import { describe, expect, test } from "bun:test";
import {
  backendCompatibilityError,
  describePromptResolution,
  describeSamplingResolution,
  fallbackPromptTemplate,
  fallbackSamplingParams,
  presetSupportsBatchPrompt,
  promptScopeKey,
  resolveChatTemplateKwargs,
  resolveModelPreset,
  resolvePromptTemplate,
  resolveSamplingParams,
  toOllamaSamplingOptions
} from "./modelPresets";

describe("modelPresets", () => {
  test("matches PLaMo 3 Translate variants without matching PLaMo 2", () => {
    expect(resolveModelPreset("pfnet/plamo-3-translate-0.8b-MLX-4bit")?.id).toBe("plamo-3-translate");
    expect(resolveModelPreset("plamo-3-translate-0.8b-MLX-4bit-q8head")?.id).toBe("plamo-3-translate");
    expect(resolveModelPreset("PLaMo-3-Translate-2B")?.id).toBe("plamo-3-translate");
    expect(resolveModelPreset("pfnet/plamo-2-translate")).toBeUndefined();
  });

  test("matches Hunyuan MT 30B before generic Hunyuan MT", () => {
    expect(resolveModelPreset("hy-mt3-30b-a3b")?.id).toBe("hunyuan-mt-30b");
    expect(resolveModelPreset("Hunyuan-MT-Chimera-30B")?.id).toBe("hunyuan-mt-30b");
    expect(resolveModelPreset("hy-mt3-1.8b-oQ5e")?.id).toBe("hunyuan-mt");
    expect(resolveModelPreset("hunyuan-mt-7b")?.id).toBe("hunyuan-mt");
  });

  test("resolves raw text template, target_lang kwargs, batch support, and sampling params for PLaMo 3", () => {
    const model = "plamo-3-translate-0.8b-MLX-4bit-q8head";
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
    expect(
      resolveSamplingParams({
        model,
        samplingParams: {},
        samplingParamsMode: "auto"
      })
    ).toEqual({ temperature: 0 });
  });

  test("resolves official sampling params for built-in presets and fallback for unknown models", () => {
    const hyMtSmall = resolveSamplingParams({
      model: "hy-mt3-1.8b-oQ5e",
      samplingParams: {},
      samplingParamsMode: "auto"
    });
    expect(hyMtSmall).toEqual({
      temperature: 0.7,
      top_p: 0.6,
      top_k: 20,
      repetition_penalty: 1.05
    });
    expect("max_tokens" in hyMtSmall).toBe(false);

    const hyMt30b = resolveSamplingParams({
      model: "hy-mt3-30b-a3b",
      samplingParams: {},
      samplingParamsMode: "auto"
    });
    expect(hyMt30b).toEqual({
      temperature: 0.7,
      top_p: 1.0,
      repetition_penalty: 1.0
    });
    expect("top_k" in hyMt30b).toBe(false);
    expect("max_tokens" in hyMt30b).toBe(false);

    const unknown = resolveSamplingParams({
      model: "qwen3-8b",
      samplingParams: {},
      samplingParamsMode: "auto"
    });
    expect(unknown).toEqual(fallbackSamplingParams);
    expect(Object.keys(unknown)).toEqual(["temperature"]);
  });

  test("respects custom sampling params and omits empty/undefined fields", () => {
    const custom = resolveSamplingParams({
      model: "hy-mt3-1.8b-oQ5e",
      samplingParams: {
        temperature: 0.3,
        top_p: undefined as unknown as number,
        max_tokens: 1024
      },
      samplingParamsMode: "custom"
    });
    expect(custom).toEqual({
      temperature: 0.3,
      max_tokens: 1024
    });
    expect(Object.keys(custom)).toEqual(["temperature", "max_tokens"]);

    const allEmpty = resolveSamplingParams({
      model: "hy-mt3-1.8b-oQ5e",
      samplingParams: {},
      samplingParamsMode: "custom"
    });
    expect(allEmpty).toEqual({});
    expect(Object.keys(allEmpty)).toEqual([]);

    // 切回 auto 后应忽略自定义草稿,重新使用 preset 官方参数
    const backToAuto = resolveSamplingParams({
      model: "hy-mt3-1.8b-oQ5e",
      samplingParams: { temperature: 0.3 },
      samplingParamsMode: "auto"
    });
    expect(backToAuto).toEqual({
      temperature: 0.7,
      top_p: 0.6,
      top_k: 20,
      repetition_penalty: 1.05
    });
  });

  test("describes sampling resolution and maps Ollama options safely", () => {
    expect(
      describeSamplingResolution({
        model: "hy-mt3-1.8b-oQ5e",
        samplingParams: {},
        samplingParamsMode: "auto"
      })
    ).toBe("已匹配 腾讯混元 MT: temperature=0.7, top_p=0.6, top_k=20, repetition_penalty=1.05");

    expect(
      describeSamplingResolution({
        model: "qwen3-8b",
        samplingParams: {},
        samplingParamsMode: "auto"
      })
    ).toContain("temperature=0.2");

    expect(
      describeSamplingResolution({
        model: "hy-mt3-1.8b-oQ5e",
        samplingParams: {},
        samplingParamsMode: "custom"
      })
    ).toContain("全部留空");

    expect(
      toOllamaSamplingOptions({
        temperature: 0.7,
        top_p: 0.6,
        top_k: 20,
        repetition_penalty: 1.05,
        max_tokens: 512
      })
    ).toEqual({
      temperature: 0.7,
      top_p: 0.6,
      top_k: 20,
      repeat_penalty: 1.05,
      num_predict: 512
    });
    expect(toOllamaSamplingOptions({})).toBeUndefined();
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

  test("changes promptScopeKey when target language, template, or sampling params change", () => {
    const model = "pfnet/plamo-3-translate-0.8b-MLX-4bit";
    const zhKey = promptScopeKey({
      model,
      targetLanguage: "简体中文",
      promptTemplate: "",
      promptTemplateMode: "auto",
      samplingParams: {},
      samplingParamsMode: "auto"
    });
    const jaKey = promptScopeKey({
      model,
      targetLanguage: "日本語",
      promptTemplate: "",
      promptTemplateMode: "auto",
      samplingParams: {},
      samplingParamsMode: "auto"
    });
    const customSamplingKey = promptScopeKey({
      model,
      targetLanguage: "简体中文",
      promptTemplate: "",
      promptTemplateMode: "auto",
      samplingParams: { temperature: 0.5 },
      samplingParamsMode: "custom"
    });
    expect(zhKey).not.toBe(jaKey);
    expect(zhKey).not.toBe(customSamplingKey);
  });
});
