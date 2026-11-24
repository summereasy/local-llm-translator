import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type BackendKind,
  type PromptTemplateMode,
  type TranslationMode,
  type TranslationTextStyle
} from "./shared/settings";
import {
  backendCompatibilityError,
  describePromptResolution,
  fallbackPromptTemplate,
  resolvePromptTemplate
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
const translationMode = mustGet<HTMLSelectElement>("translationMode");
const styleFieldset = mustGet<HTMLFieldSetElement>("styleFieldset");
const enableSelectionButton = mustGet<HTMLInputElement>("enableSelectionButton");
const disableBackendCache = mustGet<HTMLInputElement>("disableBackendCache");
const maxConcurrentRequests = mustGet<HTMLSelectElement>("maxConcurrentRequests");
const openShortcutsPage = mustGet<HTMLButtonElement>("openShortcutsPage");
const status = mustGet<HTMLElement>("status");

let saveTimer = 0;
let customPromptDraft = "";

void loadSettings().then((settings) => {
  backendKind.value = settings.backendKind;
  baseUrl.value = settings.baseUrl;
  apiKey.value = settings.apiKey;
  model.value = settings.model;
  targetLanguage.value = settings.targetLanguage;
  customPromptDraft = settings.promptTemplate;
  promptTemplate.value = settings.promptTemplate;
  autoPromptTemplate.checked = settings.promptTemplateMode !== "custom";
  translationMode.value = settings.translationMode;
  setSelectedStyle(settings.translationTextStyle);
  enableSelectionButton.checked = settings.enableSelectionButton;
  disableBackendCache.checked = settings.disableBackendCache;
  maxConcurrentRequests.value = String(settings.maxConcurrentRequests || 8);
  updateStyleAvailability();
  updatePromptAvailability();
  updatePromptHint();
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
model.addEventListener("input", () => {
  updatePromptAvailability();
  updatePromptHint();
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
    translationMode: translationMode.value as TranslationMode,
    translationTextStyle: getSelectedStyle(),
    enableSelectionButton: enableSelectionButton.checked,
    disableBackendCache: disableBackendCache.checked,
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
