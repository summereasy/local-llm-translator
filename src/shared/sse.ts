/**
 * SSE (Server-Sent Events) 增量解析。
 *
 * OpenAI-compatible 的流式接口用 `data: {...}` 事件逐块推送 delta。网络读到
 * 的 chunk 可能在任意字节处断开,这里负责缓冲并把完整事件的 data 载荷吐出,
 * 同时兼容 `\n` 与 `\r\n` 两种行尾。
 */
export class SseAccumulator {
  private buffer = "";

  /** 喂入一个网络 chunk,返回其中所有完整事件的 data 载荷(不含 `data: ` 前缀)。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    for (;;) {
      const match = this.buffer.match(/\r\n\r\n|\n\n/);
      if (!match || match.index === undefined) {
        break;
      }
      const rawEvent = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = extractSseData(rawEvent);
      if (data !== null) {
        events.push(data);
      }
    }
    return events;
  }

  /**
   * 流结束后的收尾:个别实现最后一个事件不带空行就 EOF,残余 buffer
   * 里若有 data 行也应当作最后一个事件吐出,否则会丢尾部 delta。
   */
  flush(): string[] {
    if (!this.buffer) {
      return [];
    }
    const data = extractSseData(this.buffer);
    this.buffer = "";
    return data !== null ? [data] : [];
  }
}

/** 从一个完整事件里拼出 data 载荷;没有 data 行的事件(如注释)返回 null。 */
function extractSseData(rawEvent: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) {
    return null;
  }
  return dataLines.join("\n");
}

/** 从 OpenAI-compatible 流式 chunk 的 JSON 里取增量文本;没有 delta 文本时返回空串。 */
export function extractDeltaContent(payload: unknown): string {
  const choices = (payload as { choices?: unknown[] } | null)?.choices;
  const choice = Array.isArray(choices) ? choices[0] : null;
  const content = (choice as { delta?: { content?: unknown } } | null)?.delta?.content;
  return typeof content === "string" ? content : "";
}

export type StreamFinish =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * 组装一条流式翻译:喂入每个 SSE 事件的 data 载荷,结束时用 finish() 判定。
 *
 * 必须区分"正常结束信号"([DONE])、"后端错误事件"与"响应体 EOF":
 * - 只有 delta 就 EOF → 流被提前切断,半截译文不能当成功结果;
 * - 后端发出 error 事件 → 终止条件,立即报错,不等响应体关闭
 *   (有些实现出错后仍保持连接打开,继续读会拖住整批翻译);
 * - 译文 trim 后为空(纯空白 delta 或只有 [DONE])→ 空译文,走错误路径
 *   触发整段回落;
 * - 收到 [DONE] → 正常完成,不再依赖后续 EOF。
 */
export class StreamDeltaAssembler {
  private result = "";
  private sawDone = false;
  private apiError: string | null = null;

  /**
   * 喂入一个事件的 data 载荷;返回 true 表示流已终止([DONE] 或后端错误
   * 事件),调用方应停止读流并放弃剩余响应体。
   */
  consume(data: string, onDelta?: (delta: string) => void): boolean {
    if (this.sawDone || this.apiError) {
      // 流已终止:之后到达的任何事件(迟到数据/多余心跳)一律忽略。
      return true;
    }
    if (data === "[DONE]") {
      this.sawDone = true;
      return true;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return false;
    }
    const error = (payload as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof error === "string" && error) {
      // 后端已明确报错:这就是终止条件,别再等响应体 EOF。
      this.apiError = this.apiError ?? error;
      return true;
    }
    const delta = extractDeltaContent(payload);
    if (delta) {
      this.result += delta;
      onDelta?.(delta);
    }
    return false;
  }

  /** 流是否已到终止条件([DONE] 或后端错误事件),调用方不必再读。 */
  get done(): boolean {
    return this.sawDone || this.apiError !== null;
  }

  finish(): StreamFinish {
    if (this.apiError) {
      return { ok: false, reason: `本地服务流式返回错误: ${this.apiError}` };
    }
    if (!this.sawDone) {
      return { ok: false, reason: "流被提前切断(缺少结束信号),不采用半截译文。" };
    }
    if (!this.result.trim()) {
      return { ok: false, reason: "流式响应为空,已回落整段请求。" };
    }
    return { ok: true, text: this.result.trim() };
  }
}

/** 流式响应体读取器的最小接口(ReadableStreamDefaultReader 的结构子集)。 */
export interface SseBodyReader {
  read(): Promise<{ done: false; value: Uint8Array } | { done: true; value?: undefined }>;
  cancel(): Promise<void>;
}

/**
 * 驱动一条流式响应体直到终止:EOF、[DONE] 或后端错误事件,任一先到。
 * 返回 assembler 的最终判定。终止条件一到立即返回并 cancel() 剩余响应体,
 * 不等它自己关闭——后端报错后连接可能一直开着,等下去会拖住整批翻译。
 */
export async function readSseBody(
  reader: SseBodyReader,
  assembler: StreamDeltaAssembler,
  onDelta?: (delta: string) => void
): Promise<StreamFinish> {
  const accumulator = new SseAccumulator();
  const decoder = new TextDecoder();
  const feed = (events: string[]): boolean => {
    for (const data of events) {
      if (assembler.consume(data, onDelta)) {
        return true;
      }
    }
    return assembler.done;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (feed(accumulator.push(decoder.decode(value, { stream: true })))) {
        break;
      }
    }
    if (!assembler.done) {
      // EOF 收尾:个别实现最后一个事件不带空行,残余 buffer 里的 data 行
      // 也应当作最后一个事件喂给 assembler。
      feed([...accumulator.push(decoder.decode()), ...accumulator.flush()]);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return assembler.finish();
}
