import { describe, expect, test } from "bun:test";
import { extractDeltaContent, SseAccumulator } from "./sse";

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
