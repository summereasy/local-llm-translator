import { describe, expect, test } from "bun:test";
import { looksLikeStatLabel, looksUntranslated } from "./textCheck";

describe("looksLikeStatLabel", () => {
  test("flags label+number stats with units", () => {
    expect(looksLikeStatLabel("Input from cache98.1%")).toBe(true);
    expect(looksLikeStatLabel("Output/turn 10.1K")).toBe(true);
    expect(looksLikeStatLabel("77.3%")).toBe(true);
    expect(looksLikeStatLabel("Claude Code77.3%")).toBe(true);
    expect(looksLikeStatLabel("Updated 11月24日 10:26")).toBe(true);
  });

  test("keeps real sentences and pure labels", () => {
    expect(looksLikeStatLabel("Claude Code")).toBe(false);
    expect(looksLikeStatLabel("pp = change from first to last observed day")).toBe(false);
    expect(looksLikeStatLabel("The model was launched in 2026.")).toBe(false);
    expect(
      looksLikeStatLabel("Turns = completed turn events, including tool calls and subagents")
    ).toBe(false);
  });
});

describe("looksUntranslated", () => {
  test("ignores short snippets", () => {
    expect(looksUntranslated("Hello", "Hello", "简体中文")).toBe(false);
  });

  test("flags exact echo and high-similarity echo", () => {
    const source = "The meeting has been moved to next Monday morning.";
    expect(looksUntranslated(source, source, "English")).toBe(true);
    expect(
      looksUntranslated(source, "The meeting has been moved to next Monday morning!", "English")
    ).toBe(true);
  });

  test("flags missing CJK output when target language is CJK", () => {
    expect(
      looksUntranslated(
        "The meeting has been moved to next Monday.",
        "The meeting was shifted to Monday.",
        "简体中文"
      )
    ).toBe(true);
    // 原文是日文但误翻成英文时也应触发提醒。
    expect(
      looksUntranslated(
        "会議は来週の月曜日に変更されました。",
        "The meeting has been moved to next Monday.",
        "简体中文"
      )
    ).toBe(true);
  });

  test("does not flag valid translations", () => {
    expect(
      looksUntranslated(
        "The meeting has been moved to next Monday.",
        "会议已改到下周一举行。",
        "简体中文"
      )
    ).toBe(false);
    expect(
      looksUntranslated(
        "会議は来週の月曜日に変更されました。",
        "会议已改到下周一。",
        "简体中文"
      )
    ).toBe(false);
  });
});
