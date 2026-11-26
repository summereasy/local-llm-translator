import {
  defaultSettings,
  loadSettings,
  normalizeSamplingParams,
  saveSettings,
  type BackendKind,
  type PromptTemplateMode,
  type SamplingParams,
  type SamplingParamsMode,
  type TranslationMode,
  type TranslationTextStyle
} from "./shared/settings";
import {
  backendCompatibilityError,
  describePromptResolution,
  describeSamplingResolution,
  fallbackPromptTemplate,
  resolveModelPreset,
  resolvePromptTemplate,
  resolveSamplingParams
} from "./shared/modelPresets";

const form = mustGet<HTMLFormElement>("settingsForm");
const backendKind = mustGet<HTMLSelectElement>("backendKind");
const baseUrl = mustGet<HTMLInputElement>("baseUrl");
const apiKey = mustGet<HTMLInputElement>("apiKey");
const model = mustGet<HTMLInputElement>("model");
const targetLanguage = mustGet<HTMLSelectElement>("targetLanguage");
const promptTemplate = mustGet<HTMLTextAreaElement>("promptTemplate");
const autoPromptTemplate = mustGet<HTMLInputElement>("autoPromptTemplate");
const promptTemplateHint = mustGet<HTMLElement>("promptTemplateHint");
const autoSamplingParams = mustGet<HTMLInputElement>("autoSamplingParams");
const samplingParamsHint = mustGet<HTMLElement>("samplingParamsHint");
const samplingTemperature = mustGet<HTMLInputElement>("samplingTemperature");
const samplingTopP = mustGet<HTMLInputElement>("samplingTopP");
const samplingTopK = mustGet<HTMLInputElement>("samplingTopK");
const samplingRepetitionPenalty = mustGet<HTMLInputElement>("samplingRepetitionPenalty");
const samplingMaxTokens = mustGet<HTMLInputElement>("samplingMaxTokens");
const samplingInputs = [
  samplingTemperature,
  samplingTopP,
  samplingTopK,
  samplingRepetitionPenalty,
  samplingMaxTokens
];
const translationMode = mustGet<HTMLSelectElement>("translationMode");
const styleFieldset = mustGet<HTMLFieldSetElement>("styleFieldset");
const enableSelectionButton = mustGet<HTMLInputElement>("enableSelectionButton");
const disableBackendCache = mustGet<HTMLInputElement>("disableBackendCache");
const turboMode = mustGet<HTMLInputElement>("turboMode");
const maxConcurrentRequests = mustGet<HTMLSelectElement>("maxConcurrentRequests");
const openShortcutsPage = mustGet<HTMLButtonElement>("openShortcutsPage");
const status = mustGet<HTMLElement>("status");

let saveTimer = 0;
let customPromptDraft = "";
let customSamplingDraft: SamplingParams = {};
let hasCustomSamplingDraft = false;

void loadSettings().then((settings) => {
  backendKind.value = settings.backendKind;
  baseUrl.value = settings.baseUrl;
  apiKey.value = settings.apiKey;
  model.value = settings.model;
  targetLanguage.value = settings.targetLanguage;
  customPromptDraft = settings.promptTemplate;
  promptTemplate.value = settings.promptTemplate;
  autoPromptTemplate.checked = settings.promptTemplateMode !== "custom";
  customSamplingDraft = { ...settings.samplingParams };
  hasCustomSamplingDraft =
    settings.samplingParamsMode === "custom" || Object.keys(settings.samplingParams).length > 0;
  autoSamplingParams.checked = settings.samplingParamsMode !== "custom";
  translationMode.value = settings.translationMode;
  setSelectedStyle(settings.translationTextStyle);
  enableSelectionButton.checked = settings.enableSelectionButton;
  disableBackendCache.checked = settings.disableBackendCache;
  turboMode.checked = settings.turboMode;
  maxConcurrentRequests.value = String(settings.maxConcurrentRequests || 8);
  updateStyleAvailability();
  updatePromptAvailability();
  updatePromptHint();
  updateSamplingAvailability();
  updateSamplingHint();
});

backendKind.addEventListener("change", () => {
  if (backendKind.value === "ollama" && baseUrl.value === defaultSettings.baseUrl) {
    baseUrl.value = "http://127.0.0.1:11434";
  }
  updatePromptHint();
});

translationMode.addEventListener("change", updateStyleAvailability);
autoPromptTemplate.addEventListener("change", () => {
  updatePromptAvailability();
  updatePromptHint();
});
promptTemplate.addEventListener("input", () => {
  if (!autoPromptTemplate.checked) {
    customPromptDraft = promptTemplate.value;
    updatePromptHint();
  }
});
autoSamplingParams.addEventListener("change", () => {
  updateSamplingAvailability({ seedFromCurrent: !autoSamplingParams.checked });
  updateSamplingHint();
});
for (const input of samplingInputs) {
  input.addEventListener("input", () => {
    if (autoSamplingParams.checked) {
      autoSamplingParams.checked = false;
    }
    hasCustomSamplingDraft = true;
    customSamplingDraft = readSamplingInputs();
    updateSamplingHint();
  });
}
model.addEventListener("input", () => {
  updatePromptAvailability();
  updatePromptHint();
  updateSamplingAvailability();
  updateSamplingHint();
});
targetLanguage.addEventListener("change", () => {
  updatePromptAvailability();
  updatePromptHint();
});

form.addEventListener("input", scheduleSave);
form.addEventListener("change", scheduleSave);
form.addEventListener("submit", (event) => {
  event.preventDefault();
});

openShortcutsPage.addEventListener("click", () => {
  void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

function scheduleSave(): void {
  status.textContent = "保存中...";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void persistSettings();
  }, 250);
}

async function persistSettings(): Promise<void> {
  await saveSettings({
    backendKind: backendKind.value as BackendKind,
    baseUrl: baseUrl.value,
    apiKey: apiKey.value,
    model: model.value,
    targetLanguage: targetLanguage.value,
    promptTemplate: customPromptDraft,
    promptTemplateMode: (autoPromptTemplate.checked ? "auto" : "custom") as PromptTemplateMode,
    samplingParams: customSamplingDraft,
    samplingParamsMode: (autoSamplingParams.checked ? "auto" : "custom") as SamplingParamsMode,
    translationMode: translationMode.value as TranslationMode,
    translationTextStyle: getSelectedStyle(),
    enableSelectionButton: enableSelectionButton.checked,
    disableBackendCache: disableBackendCache.checked,
    turboMode: turboMode.checked,
    maxConcurrentRequests: Number(maxConcurrentRequests.value || 8),
    batchSize: 1
  });
  status.textContent = "已自动保存";
}

function promptInput() {
  return {
    backendKind: backendKind.value as BackendKind,
    model: model.value,
    targetLanguage: targetLanguage.value,
    promptTemplate: customPromptDraft,
    promptTemplateMode: (autoPromptTemplate.checked ? "auto" : "custom") as PromptTemplateMode
  };
}

function samplingInput() {
  return {
    model: model.value,
    samplingParams: customSamplingDraft,
    samplingParamsMode: (autoSamplingParams.checked ? "auto" : "custom") as SamplingParamsMode
  };
}

function updatePromptAvailability(): void {
  const auto = autoPromptTemplate.checked;
  promptTemplate.disabled = auto;
  promptTemplate.classList.toggle("is-disabled", auto);
  if (auto) {
    // 自动模式下把将要发送的模板当成预览显示出来,不覆盖用户的自定义草稿。
    promptTemplate.value = resolvePromptTemplate(promptInput());
  } else {
    promptTemplate.value = customPromptDraft.trim() ? customPromptDraft : fallbackPromptTemplate;
    customPromptDraft = promptTemplate.value;
  }
}

function updatePromptHint(): void {
  const input = promptInput();
  promptTemplateHint.textContent = describePromptResolution(input);
  promptTemplateHint.classList.toggle(
    "is-warning",
    Boolean(backendCompatibilityError(input.model, input.backendKind))
  );
}

function updateSamplingAvailability(options?: { seedFromCurrent?: boolean }): void {
  const auto = autoSamplingParams.checked;
  const hasPreset = Boolean(resolveModelPreset(model.value)?.samplingParams);
  const locked = auto && hasPreset;
  for (const input of samplingInputs) {
    input.disabled = locked;
    input.classList.toggle("is-disabled", locked);
  }
  if (auto) {
    // 自动模式下把当前生效的参数显示出来,不覆盖用户的自定义草稿。
    writeSamplingInputs(resolveSamplingParams(samplingInput()));
  } else {
    if (options?.seedFromCurrent && !hasCustomSamplingDraft) {
      customSamplingDraft = resolveSamplingParams({
        model: model.value,
        samplingParams: {},
        samplingParamsMode: "auto"
      });
      hasCustomSamplingDraft = true;
    }
    writeSamplingInputs(customSamplingDraft);
  }
}

function updateSamplingHint(): void {
  samplingParamsHint.textContent = describeSamplingResolution(samplingInput());
}

function readSamplingInputs(): SamplingParams {
  return normalizeSamplingParams({
    temperature: samplingTemperature.value,
    top_p: samplingTopP.value,
    top_k: samplingTopK.value,
    repetition_penalty: samplingRepetitionPenalty.value,
    max_tokens: samplingMaxTokens.value
  });
}

function writeSamplingInputs(params: SamplingParams): void {
  samplingTemperature.value = params.temperature === undefined ? "" : String(params.temperature);
  samplingTopP.value = params.top_p === undefined ? "" : String(params.top_p);
  samplingTopK.value = params.top_k === undefined ? "" : String(params.top_k);
  samplingRepetitionPenalty.value =
    params.repetition_penalty === undefined ? "" : String(params.repetition_penalty);
  samplingMaxTokens.value = params.max_tokens === undefined ? "" : String(params.max_tokens);
}

function updateStyleAvailability(): void {
  const disabled = translationMode.value !== "bilingual";
  styleFieldset.disabled = disabled;
  styleFieldset.classList.toggle("is-disabled", disabled);
}

function getSelectedStyle(): TranslationTextStyle {
  const checked = document.querySelector<HTMLInputElement>("input[name='translationTextStyle']:checked");
  return (checked?.value || defaultSettings.translationTextStyle) as TranslationTextStyle;
}

function setSelectedStyle(value: TranslationTextStyle): void {
  const input = document.querySelector<HTMLInputElement>(`input[name='translationTextStyle'][value='${value}']`);
  if (input) {
    input.checked = true;
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}
