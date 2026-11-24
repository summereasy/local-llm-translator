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
