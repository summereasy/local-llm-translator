import { describe, expect, test } from "bun:test";
import { extractDeltaContent, SseAccumulator, StreamDeltaAssembler } from "./sse";

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
