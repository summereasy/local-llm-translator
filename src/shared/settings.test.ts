import { describe, expect, test } from "bun:test";
import { fallbackPromptTemplate } from "./modelPresets";
import { defaultSettings, normalizeSamplingParams, normalizeSettings } from "./settings";

describe("normalizeSettings", () => {
  test("migrates legacy default promptTemplate to auto mode", () => {
    const settings = normalizeSettings({
      promptTemplate: fallbackPromptTemplate
    });
    expect(settings.promptTemplateMode).toBe("auto");
    expect(settings.promptTemplate).toBe(fallbackPromptTemplate);
  });

  test("migrates legacy custom promptTemplate to custom mode", () => {
    const custom = "Translate to {{targetLanguage}}: {{text}}";
    const settings = normalizeSettings({
      promptTemplate: custom
    });
    expect(settings.promptTemplateMode).toBe("custom");
    expect(settings.promptTemplate).toBe(custom);
  });

  test("preserves custom prompt draft when promptTemplateMode is auto", () => {
    const custom = "My custom template: {{text}}";
    const settings = normalizeSettings({
      promptTemplate: custom,
      promptTemplateMode: "auto"
    });
    expect(settings.promptTemplateMode).toBe("auto");
    expect(settings.promptTemplate).toBe(custom);
  });

  test("defaults disableBackendCache to true and respects explicit false", () => {
    expect(normalizeSettings({}).disableBackendCache).toBe(defaultSettings.disableBackendCache);
    expect(normalizeSettings({ disableBackendCache: false }).disableBackendCache).toBe(false);
  });

  test("defaults turboMode to true and respects explicit false", () => {
    expect(normalizeSettings({}).turboMode).toBe(defaultSettings.turboMode);
    expect(normalizeSettings({ turboMode: false }).turboMode).toBe(false);
  });

  test("defaults samplingParamsMode to auto and empty samplingParams for legacy settings", () => {
    const settings = normalizeSettings({ model: "hy-mt3-1.8b-oQ5e" });
    expect(settings.samplingParamsMode).toBe("auto");
    expect(settings.samplingParams).toEqual({});
  });

  test("preserves custom samplingParams draft when samplingParamsMode is auto or custom", () => {
    const autoSettings = normalizeSettings({
      samplingParamsMode: "auto",
      samplingParams: { temperature: 0.4, top_p: 0.8 }
    });
    expect(autoSettings.samplingParamsMode).toBe("auto");
    expect(autoSettings.samplingParams).toEqual({ temperature: 0.4, top_p: 0.8 });

    const customSettings = normalizeSettings({
      samplingParamsMode: "custom",
      samplingParams: { temperature: 0, top_k: 20, max_tokens: 512 }
    });
    expect(customSettings.samplingParamsMode).toBe("custom");
    expect(customSettings.samplingParams).toEqual({ temperature: 0, top_k: 20, max_tokens: 512 });
  });

  test("omits empty and invalid fields in normalizeSamplingParams", () => {
    const parsed = normalizeSamplingParams({
      temperature: "0.7",
      top_p: "",
      top_k: "20.4",
      repetition_penalty: "-1",
      max_tokens: "   "
    });
    expect(parsed).toEqual({
      temperature: 0.7,
      top_k: 20
    });
    expect("top_p" in parsed).toBe(false);
    expect("repetition_penalty" in parsed).toBe(false);
    expect("max_tokens" in parsed).toBe(false);

    expect(normalizeSamplingParams({ top_p: 1.5, max_tokens: 0 })).toEqual({});
  });
});
