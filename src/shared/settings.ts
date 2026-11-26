import { fallbackPromptTemplate } from "./modelPresets";

export type BackendKind = "openai-compatible" | "ollama";

/** auto:按模型名匹配内置模板;custom:强制使用用户填写的模板。 */
export type PromptTemplateMode = "auto" | "custom";

/** auto:按模型名匹配内置采样参数;custom:使用用户自定义的采样参数。 */
export type SamplingParamsMode = "auto" | "custom";

/** 采样参数全可选:未填/undefined 的字段不会发进请求 JSON。 */
export type SamplingParams = {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  max_tokens?: number;
};

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
  promptTemplateMode: PromptTemplateMode;
  samplingParams: SamplingParams;
  samplingParamsMode: SamplingParamsMode;
  translationMode: TranslationMode;
  translationTextStyle: TranslationTextStyle;
  enableSelectionButton: boolean;
  /** 请求头里声明后端不要写 KV 缓存(目前只有 oMLX 认这个 header)。 */
  disableBackendCache: boolean;
  /** 极速模式: 流式渐进渲染 + 首屏优先。Ollama 后端或建流失败时自动回落整段返回。 */
  turboMode: boolean;
  maxConcurrentRequests: number;
  batchSize: number;
};

export const defaultSettings: LocalTranslatorSettings = {
  backendKind: "openai-compatible",
  baseUrl: "http://127.0.0.1:12345/v1",
  apiKey: "",
  model: "",
  targetLanguage: "简体中文",
  promptTemplate: "",
  promptTemplateMode: "auto",
  samplingParams: {},
  samplingParamsMode: "auto",
  translationMode: "bilingual",
  translationTextStyle: "muted",
  enableSelectionButton: true,
  disableBackendCache: true,
  turboMode: true,
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

export function normalizeSettings(value: unknown): LocalTranslatorSettings {
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
    promptTemplate: normalizePromptTemplate(input),
    promptTemplateMode: normalizePromptTemplateMode(input),
    samplingParams: normalizeSamplingParams(input.samplingParams),
    samplingParamsMode: normalizeSamplingParamsMode(input),
    translationMode: input.translationMode === "replace" ? "replace" : "bilingual",
    translationTextStyle: normalizeTextStyle(input.translationTextStyle),
    disableBackendCache:
      typeof input.disableBackendCache === "boolean"
        ? input.disableBackendCache
        : defaultSettings.disableBackendCache,
    turboMode:
      typeof input.turboMode === "boolean" ? input.turboMode : defaultSettings.turboMode,
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

function normalizePromptTemplateMode(input: Partial<LocalTranslatorSettings>): PromptTemplateMode {
  if (input.promptTemplateMode === "auto" || input.promptTemplateMode === "custom") {
    return input.promptTemplateMode;
  }
  // 旧版本只有一份全局模板:与旧默认值相同就当作"自动",否则视为用户自定义。
  const legacyTemplate = typeof input.promptTemplate === "string" ? input.promptTemplate : "";
  return legacyTemplate.trim() && legacyTemplate !== fallbackPromptTemplate ? "custom" : "auto";
}

function normalizePromptTemplate(input: Partial<LocalTranslatorSettings>): string {
  const template = typeof input.promptTemplate === "string" ? input.promptTemplate : "";
  if (normalizePromptTemplateMode(input) === "auto") {
    // 自动模式下保留文本,方便用户切回自定义时继续编辑。
    return template;
  }
  return template.trim() ? template : fallbackPromptTemplate;
}

function normalizeSamplingParamsMode(input: Partial<LocalTranslatorSettings>): SamplingParamsMode {
  if (input.samplingParamsMode === "auto" || input.samplingParamsMode === "custom") {
    return input.samplingParamsMode;
  }
  return defaultSettings.samplingParamsMode;
}

export function normalizeSamplingParams(value: unknown): SamplingParams {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const input = value as Record<string, unknown>;
  const result: SamplingParams = {};

  const temperature = parseFiniteNumber(input.temperature);
  if (temperature !== undefined && temperature >= 0) {
    result.temperature = temperature;
  }

  const topP = parseFiniteNumber(input.top_p);
  if (topP !== undefined && topP >= 0 && topP <= 1) {
    result.top_p = topP;
  }

  const topK = parseFiniteNumber(input.top_k);
  if (topK !== undefined && topK >= 0) {
    result.top_k = Math.round(topK);
  }

  const repetitionPenalty = parseFiniteNumber(input.repetition_penalty);
  if (repetitionPenalty !== undefined && repetitionPenalty > 0) {
    result.repetition_penalty = repetitionPenalty;
  }

  const maxTokens = parseFiniteNumber(input.max_tokens);
  if (maxTokens !== undefined && maxTokens >= 1) {
    result.max_tokens = Math.round(maxTokens);
  }

  return result;
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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
