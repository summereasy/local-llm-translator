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
 * 必须区分"正常结束信号"([DONE])与"响应体 EOF":
 * - 只有 delta 就 EOF → 流被提前切断,半截译文不能当成功结果;
 * - 只发 [DONE] 没有任何 delta → 空译文,走错误路径触发整段回落;
 * - 收到 [DONE] → 正常完成,不再依赖后续 EOF。
 */
export class StreamDeltaAssembler {
  private result = "";
  private sawDone = false;
  private sawContent = false;
  private apiError: string | null = null;

  /** 喂入一个事件的 data 载荷;返回 true 表示已收到结束信号,可以停止读流。 */
  consume(data: string, onDelta?: (delta: string) => void): boolean {
    if (this.sawDone) {
      // 结束信号已到:之后到达的任何事件(迟到数据/多余心跳)一律忽略。
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
      this.apiError = this.apiError ?? error;
      return false;
    }
    const delta = extractDeltaContent(payload);
    if (delta) {
      this.sawContent = true;
      this.result += delta;
      onDelta?.(delta);
    }
    return false;
  }

  get done(): boolean {
    return this.sawDone;
  }

  finish(): StreamFinish {
    if (this.apiError) {
      return { ok: false, reason: `本地服务流式返回错误: ${this.apiError}` };
    }
    if (!this.sawDone) {
      return { ok: false, reason: "流被提前切断(缺少结束信号),不采用半截译文。" };
    }
    if (!this.sawContent) {
      return { ok: false, reason: "流式响应为空,已回落整段请求。" };
    }
    return { ok: true, text: this.result.trim() };
  }
}
