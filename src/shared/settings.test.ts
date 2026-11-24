import { describe, expect, test } from "bun:test";
import { fallbackPromptTemplate } from "./modelPresets";
import { defaultSettings, normalizeSettings } from "./settings";

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
});
