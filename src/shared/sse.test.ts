import { describe, expect, test } from "bun:test";
import {
  extractDeltaContent,
  readSseBody,
  SseAccumulator,
  SseBodyReader,
  StreamDeltaAssembler,
} from "./sse";

describe("SseAccumulator", () => {
  test("returns complete events from a single chunk", () => {
    const acc = new SseAccumulator();
    expect(
      acc.push('data: {"a":1}\n\ndata: {"a":2}\n\n')
    ).toEqual(['{"a":1}', '{"a":2}']);
  });

  test("buffers chunks that split an event anywhere", () => {
    const acc = new SseAccumulator();
    expect(acc.push('data: {"a"')).toEqual([]);
    expect(acc.push(':1}\n\ndata: {"b"')).toEqual(['{"a":1}']);
    expect(acc.push(":2}\n\n")).toEqual(['{"b":2}']);
  });

  test("handles split multi-byte content and split line endings", () => {
    const acc = new SseAccumulator();
    expect(acc.push("data: 翻")).toEqual([]);
    expect(acc.push("译\r\n\r")).toEqual([]);
    expect(acc.push("\ndata: [DONE]\r\n\r\n")).toEqual(["翻译", "[DONE]"]);
  });

  test("joins multi-line data payloads", () => {
    const acc = new SseAccumulator();
    expect(acc.push("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });

  test("ignores comment-only events", () => {
    const acc = new SseAccumulator();
    expect(acc.push(": heartbeat\n\n")).toEqual([]);
  });

  test("flush() emits a trailing event without a blank line", () => {
    const acc = new SseAccumulator();
    expect(acc.push("data: [DONE]\n")).toEqual([]);
    expect(acc.flush()).toEqual(["[DONE]"]);
    expect(acc.flush()).toEqual([]);
  });

  test("survives byte-level chunk boundaries through TextDecoder", () => {
    const acc = new SseAccumulator();
    const decoder = new TextDecoder();
    const events: string[] = [];
    const bytes = new TextEncoder().encode('data: {"x":"流式翻译"}\n\ndata: [DONE]\n\n');
    // 模拟网络层把字节流在任意位置切开(含多字节字符中间)。
    const slices = [0, 1, 5, 9, 17, 25, 31, bytes.length];
    for (let i = 0; i < slices.length - 1; i += 1) {
      const chunk = bytes.slice(slices[i], slices[i + 1]);
      events.push(...acc.push(decoder.decode(chunk, { stream: true })));
    }
    events.push(...acc.push(decoder.decode()));
    expect(events).toEqual(['{"x":"流式翻译"}', "[DONE]"]);
  });
});

describe("StreamDeltaAssembler", () => {
  const chunk = (text: string) =>
    JSON.stringify({ choices: [{ delta: { content: text } }] });

  test("normal stream: deltas then [DONE] resolves the full text", () => {
    const a = new StreamDeltaAssembler();
    const deltas: string[] = [];
    expect(a.consume(chunk("你好"), (d) => deltas.push(d))).toBe(false);
    expect(a.consume(chunk(",世界"), (d) => deltas.push(d))).toBe(false);
    expect(a.consume("[DONE]")).toBe(true);
    expect(deltas).toEqual(["你好", ",世界"]);
    expect(a.finish()).toEqual({ ok: true, text: "你好,世界" });
  });

  test("delta then EOF without [DONE]: premature cut is an error, not success", () => {
    const a = new StreamDeltaAssembler();
    a.consume(chunk("半截译文"));
    const finished = a.finish();
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("提前切断");
    }
  });

  test("[DONE] only with no deltas: empty stream is an error that enables fallback", () => {
    const a = new StreamDeltaAssembler();
    expect(a.consume("[DONE]")).toBe(true);
    const finished = a.finish();
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("为空");
    }
  });

  test("[DONE] stops consumption: caller need not wait for body EOF", () => {
    const a = new StreamDeltaAssembler();
    a.consume(chunk("完整"));
    expect(a.done).toBe(false);
    a.consume("[DONE]");
    expect(a.done).toBe(true);
    // 结束信号之后到达的任何事件都不再影响结果。
    a.consume(chunk("迟到的多余数据"));
    expect(a.finish()).toEqual({ ok: true, text: "完整" });
  });

  test("payload error is surfaced", () => {
    const a = new StreamDeltaAssembler();
    a.consume(JSON.stringify({ error: { message: "model overloaded" } }));
    const finished = a.finish();
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("model overloaded");
    }
  });

  test("error event is terminal: consume returns true and done is set", () => {
    const a = new StreamDeltaAssembler();
    expect(a.consume(chunk("已到手的半截"))).toBe(false);
    expect(a.consume(JSON.stringify({ error: { message: "inference failed" } }))).toBe(true);
    expect(a.done).toBe(true);
    // 终止后到达的事件不再影响结果。
    expect(a.consume(chunk("迟到的数据"))).toBe(true);
    const finished = a.finish();
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("inference failed");
    }
  });

  test("whitespace-only output with [DONE] counts as empty and enables fallback", () => {
    const a = new StreamDeltaAssembler();
    expect(a.consume(chunk("  "))).toBe(false);
    expect(a.consume("[DONE]")).toBe(true);
    const finished = a.finish();
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("为空");
    }
  });
});

describe("readSseBody", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const chunk = (text: string) =>
    JSON.stringify({ choices: [{ delta: { content: text } }] });

  /** 按顺序吐出 chunks;耗尽后要么 EOF,要么 read() 永不返回(响应体保持打开)。 */
  function fakeReader(chunks: Uint8Array[], keepOpenAfter = false): {
    reader: SseBodyReader;
    cancelled: () => boolean;
  } {
    let cursor = 0;
    let cancelled = false;
    const pending = new Promise<{ done: false; value: Uint8Array }>(() => {});
    const reader: SseBodyReader = {
      read: () => {
        const value = chunks[cursor];
        if (value === undefined) {
          return keepOpenAfter
            ? pending
            : Promise.resolve({ done: true as const, value: undefined });
        }
        cursor += 1;
        return Promise.resolve({ done: false as const, value });
      },
      cancel: async () => {
        cancelled = true;
      },
    };
    return { reader, cancelled: () => cancelled };
  }

  test("error event settles immediately while the body stays open", async () => {
    // 评审复现场景:一个有效 delta → 后端 error 事件 → 响应体保持打开
    // (不再发数据也不断开)。错误实现会一直等 read(),本用例超时失败。
    const { reader, cancelled } = fakeReader(
      [
        enc(`data: ${chunk("半截")}\n\n`),
        enc(`data: ${JSON.stringify({ error: { message: "inference failed" } })}\n\n`),
      ],
      true
    );
    const deltas: string[] = [];
    const finished = await readSseBody(
      reader,
      new StreamDeltaAssembler(),
      (d) => deltas.push(d)
    );
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("inference failed");
    }
    expect(deltas).toEqual(["半截"]);
    expect(cancelled()).toBe(true);
  });

  test("[DONE] terminates and cancels the rest of the body", async () => {
    // [DONE] 之后响应体可能还挂着,读循环必须退出并 cancel。
    const { reader, cancelled } = fakeReader(
      [enc(`data: ${chunk("你好")}\n\n`), enc("data: [DONE]\n\n")],
      true
    );
    const finished = await readSseBody(reader, new StreamDeltaAssembler());
    expect(finished).toEqual({ ok: true, text: "你好" });
    expect(cancelled()).toBe(true);
  });

  test("delta then EOF without [DONE]: premature cut is an error", async () => {
    const { reader } = fakeReader([enc(`data: ${chunk("半截译文")}\n\n`)]);
    const finished = await readSseBody(reader, new StreamDeltaAssembler());
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("提前切断");
    }
  });

  test("trailing [DONE] without blank line is flushed at EOF", async () => {
    const { reader } = fakeReader([enc(`data: ${chunk("完整")}\n\ndata: [DONE]\n`)]);
    const finished = await readSseBody(reader, new StreamDeltaAssembler());
    expect(finished).toEqual({ ok: true, text: "完整" });
  });

  test("whitespace-only stream falls back instead of returning empty success", async () => {
    const { reader } = fakeReader([enc(`data: ${chunk("  ")}\n\n`), enc("data: [DONE]\n\n")]);
    const finished = await readSseBody(reader, new StreamDeltaAssembler());
    expect(finished.ok).toBe(false);
    if (!finished.ok) {
      expect(finished.reason).toContain("为空");
    }
  });
});

describe("extractDeltaContent", () => {
  test("extracts delta content from an OpenAI-compatible chunk", () => {
    expect(extractDeltaContent({ choices: [{ delta: { content: "你好" } }] })).toBe("你好");
  });

  test("returns empty string for finish chunks without delta content", () => {
    expect(extractDeltaContent({ choices: [{ delta: {}, finish_reason: "stop" }] })).toBe("");
    expect(extractDeltaContent({ choices: [{ message: { content: "x" } }] })).toBe("");
    expect(extractDeltaContent({})).toBe("");
    expect(extractDeltaContent(null)).toBe("");
  });
});
