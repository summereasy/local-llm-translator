import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type BackendKind,
  type TranslationMode,
  type TranslationTextStyle
} from "./shared/settings";

const form = mustGet<HTMLFormElement>("settingsForm");
const backendKind = mustGet<HTMLSelectElement>("backendKind");
const baseUrl = mustGet<HTMLInputElement>("baseUrl");
const apiKey = mustGet<HTMLInputElement>("apiKey");
const model = mustGet<HTMLInputElement>("model");
const targetLanguage = mustGet<HTMLSelectElement>("targetLanguage");
const promptTemplate = mustGet<HTMLTextAreaElement>("promptTemplate");
const translationMode = mustGet<HTMLSelectElement>("translationMode");
const styleFieldset = mustGet<HTMLFieldSetElement>("styleFieldset");
const enableSelectionButton = mustGet<HTMLInputElement>("enableSelectionButton");
const maxConcurrentRequests = mustGet<HTMLSelectElement>("maxConcurrentRequests");
const openShortcutsPage = mustGet<HTMLButtonElement>("openShortcutsPage");
const status = mustGet<HTMLElement>("status");

let saveTimer = 0;

void loadSettings().then((settings) => {
  backendKind.value = settings.backendKind;
  baseUrl.value = settings.baseUrl;
  apiKey.value = settings.apiKey;
  model.value = settings.model;
  targetLanguage.value = settings.targetLanguage;
  promptTemplate.value = settings.promptTemplate;
  translationMode.value = settings.translationMode;
  setSelectedStyle(settings.translationTextStyle);
  enableSelectionButton.checked = settings.enableSelectionButton;
  maxConcurrentRequests.value = String(settings.maxConcurrentRequests || 8);
  updateStyleAvailability();
});

backendKind.addEventListener("change", () => {
  if (backendKind.value === "ollama" && baseUrl.value === defaultSettings.baseUrl) {
    baseUrl.value = "http://127.0.0.1:11434";
  }
});

translationMode.addEventListener("change", updateStyleAvailability);

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
    promptTemplate: promptTemplate.value,
    translationMode: translationMode.value as TranslationMode,
    translationTextStyle: getSelectedStyle(),
    enableSelectionButton: enableSelectionButton.checked,
    maxConcurrentRequests: Number(maxConcurrentRequests.value || 8),
    batchSize: 1
  });
  status.textContent = "已自动保存";
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
