export type BackendKind = "openai-compatible" | "ollama";

export type TranslationMode = "replace" | "bilingual";

export type TranslationTextStyle =
  | "none"
  | "muted"
  | "italic"
  | "bold"
  | "underline"
  | "highlight";

export type LocalTranslatorSettings = {
  backendKind: BackendKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  promptTemplate: string;
  translationMode: TranslationMode;
  translationTextStyle: TranslationTextStyle;
  enableSelectionButton: boolean;
  maxConcurrentRequests: number;
  batchSize: number;
};

export const defaultSettings: LocalTranslatorSettings = {
  backendKind: "openai-compatible",
  baseUrl: "http://127.0.0.1:12345/v1",
  apiKey: "",
  model: "",
  targetLanguage: "简体中文",
  promptTemplate:
    "请把下面的文本翻译成{{targetLanguage}}。保留原意、链接文本和术语，不要解释，不要添加额外内容。\n\n{{text}}",
  translationMode: "bilingual",
  translationTextStyle: "muted",
  enableSelectionButton: true,
  maxConcurrentRequests: 8,
  batchSize: 1
};

const settingsKey = "localTranslator.settings";

export function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Extension context invalidated");
}

export async function loadSettings(): Promise<LocalTranslatorSettings> {
  if (!isExtensionContextValid()) {
    return normalizeSettings(undefined);
  }

  try {
    const stored = await chrome.storage.sync.get(settingsKey);
    return normalizeSettings(stored[settingsKey]);
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return normalizeSettings(undefined);
    }
    throw error;
  }
}

export async function saveSettings(settings: LocalTranslatorSettings): Promise<void> {
  await chrome.storage.sync.set({ [settingsKey]: normalizeSettings(settings) });
}

function normalizeSettings(value: unknown): LocalTranslatorSettings {
  const input = typeof value === "object" && value !== null ? (value as Partial<LocalTranslatorSettings>) : {};
  return {
    backendKind: input.backendKind === "ollama" ? "ollama" : "openai-compatible",
    baseUrl: cleanBaseUrl(input.baseUrl) || defaultSettings.baseUrl,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : defaultSettings.apiKey,
    model: typeof input.model === "string" ? input.model.trim() : defaultSettings.model,
    targetLanguage:
      typeof input.targetLanguage === "string" && input.targetLanguage.trim()
        ? input.targetLanguage.trim()
        : defaultSettings.targetLanguage,
    promptTemplate:
      typeof input.promptTemplate === "string" && input.promptTemplate.trim()
        ? input.promptTemplate
        : defaultSettings.promptTemplate,
    translationMode: input.translationMode === "replace" ? "replace" : "bilingual",
    translationTextStyle: normalizeTextStyle(input.translationTextStyle),
    enableSelectionButton:
      typeof input.enableSelectionButton === "boolean"
        ? input.enableSelectionButton
        : defaultSettings.enableSelectionButton,
    maxConcurrentRequests: normalizeConcurrency(input.maxConcurrentRequests),
    batchSize: normalizeBatchSize(input.batchSize)
  };
}

export function cleanBaseUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== "string") {
    return "";
  }
  return baseUrl.trim().replace(/\/+$/, "");
}

function normalizeTextStyle(value: unknown): TranslationTextStyle {
  if (
    value === "none" ||
    value === "muted" ||
    value === "italic" ||
    value === "bold" ||
    value === "underline" ||
    value === "highlight"
  ) {
    return value;
  }
  return defaultSettings.translationTextStyle;
}

function normalizeConcurrency(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return defaultSettings.maxConcurrentRequests;
  }
  return Math.min(16, Math.max(1, Math.round(numberValue)));
}

function normalizeBatchSize(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return defaultSettings.batchSize;
  }
  return Math.min(16, Math.max(1, Math.round(numberValue)));
}
