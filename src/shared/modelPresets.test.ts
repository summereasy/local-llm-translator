import { describe, expect, test } from "bun:test";
import {
  backendCompatibilityError,
  describePromptResolution,
  fallbackPromptTemplate,
  presetSupportsBatchPrompt,
  promptScopeKey,
  resolveChatTemplateKwargs,
  resolveModelPreset,
  resolvePromptTemplate,
  resolveTemperature
} from "./modelPresets";

describe("modelPresets", () => {
  test("matches PLaMo 3 Translate variants without matching PLaMo 2", () => {
    expect(resolveModelPreset("pfnet/plamo-3-translate-0.8b-MLX-4bit")?.id).toBe("plamo-3-translate");
    expect(resolveModelPreset("PLaMo-3-Translate-2B")?.id).toBe("plamo-3-translate");
    expect(resolveModelPreset("pfnet/plamo-2-translate")).toBeUndefined();
  });

  test("resolves raw text template, target_lang kwargs, batch support, and temperature for PLaMo 3", () => {
    const model = "pfnet/plamo-3-translate-0.8b-MLX-4bit";
    expect(
      resolvePromptTemplate({
        model,
        targetLanguage: "简体中文",
        promptTemplate: "",
        promptTemplateMode: "auto"
      })
    ).toBe("{{text}}");

    expect(resolveChatTemplateKwargs({ model, targetLanguage: "简体中文" })).toEqual({
      target_lang: "zh-hans"
    });
    expect(resolveChatTemplateKwargs({ model, targetLanguage: "繁體中文" })).toEqual({
      target_lang: "zh-hant"
    });
    expect(resolveChatTemplateKwargs({ model, targetLanguage: "日本語" })).toEqual({
      target_lang: "ja"
    });
    expect(resolveChatTemplateKwargs({ model, targetLanguage: "UnknownLang" })).toBeUndefined();
    expect(presetSupportsBatchPrompt(model)).toBe(false);
    expect(resolveTemperature(model)).toBe(0);
  });

  test("uses custom template when mode is custom and non-empty, otherwise falls back", () => {
    const model = "pfnet/plamo-3-translate-0.8b-MLX-4bit";
    expect(
      resolvePromptTemplate({
        model,
        targetLanguage: "简体中文",
        promptTemplate: "Translate: {{text}}",
        promptTemplateMode: "custom"
      })
    ).toBe("Translate: {{text}}");

    expect(
      resolvePromptTemplate({
        model,
        targetLanguage: "简体中文",
        promptTemplate: "   ",
        promptTemplateMode: "custom"
      })
    ).toBe("{{text}}");

    expect(
      resolvePromptTemplate({
        model: "qwen3-8b",
        targetLanguage: "简体中文",
        promptTemplate: "",
        promptTemplateMode: "auto"
      })
    ).toBe(fallbackPromptTemplate);
  });

  test("reports Ollama backend incompatibility for PLaMo 3", () => {
    const model = "pfnet/plamo-3-translate-0.8b-MLX-4bit";
    expect(backendCompatibilityError(model, "ollama")).toContain("OpenAI-compatible");
    expect(backendCompatibilityError(model, "openai-compatible")).toBeUndefined();
    expect(backendCompatibilityError("hy-mt-7b", "ollama")).toBeUndefined();

    expect(
      describePromptResolution({
        backendKind: "ollama",
        model,
        targetLanguage: "简体中文",
        promptTemplate: "",
        promptTemplateMode: "auto"
      })
    ).toContain("注意:");

    expect(
      describePromptResolution({
        backendKind: "openai-compatible",
        model,
        targetLanguage: "简体中文",
        promptTemplate: "custom {{text}}",
        promptTemplateMode: "custom"
      })
    ).toContain("zh-hans");
  });

  test("changes promptScopeKey when target language or template changes", () => {
    const model = "pfnet/plamo-3-translate-0.8b-MLX-4bit";
    const zhKey = promptScopeKey({
      model,
      targetLanguage: "简体中文",
      promptTemplate: "",
      promptTemplateMode: "auto"
    });
    const jaKey = promptScopeKey({
      model,
      targetLanguage: "日本語",
      promptTemplate: "",
      promptTemplateMode: "auto"
    });
    expect(zhKey).not.toBe(jaKey);
  });
});
