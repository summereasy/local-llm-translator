import type {
  LocalTranslatorRequest,
  PageTranslationProgressMessage,
  PageTranslationState
} from "./shared/messages";
import { loadSettings } from "./shared/settings";

const togglePage = mustGet<HTMLButtonElement>("togglePage");
const status = mustGet<HTMLElement>("status");
const openOptions = mustGet<HTMLButtonElement>("openOptions");
const targetLanguage = mustGet<HTMLElement>("targetLanguage");
const providerName = mustGet<HTMLElement>("providerName");
const providerEndpoint = mustGet<HTMLElement>("providerEndpoint");
const providerModel = mustGet<HTMLElement>("providerModel");

void refreshState();
void refreshSettings();

togglePage.addEventListener("click", async () => {
  await sendToActiveTab({ type: "toggle-page-translation" });
  window.close();
});

openOptions.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message: PageTranslationProgressMessage) => {
  if (message.type === "page-translation-progress") {
    renderState(message);
  }
});

async function refreshState(): Promise<void> {
  const state = await sendToActiveTab<PageTranslationState>({ type: "get-page-state" }).catch(() => null);
  if (!state) {
    status.textContent = "当前页面不可注入内容脚本。";
    togglePage.disabled = true;
    return;
  }
  renderState(state);
}

async function refreshSettings(): Promise<void> {
  const settings = await loadSettings();
  targetLanguage.textContent = settings.targetLanguage;
  providerName.textContent =
    settings.backendKind === "ollama" ? "Ollama native" : "OpenAI-compatible";
  providerEndpoint.textContent = settings.baseUrl;
  providerModel.textContent = settings.model || "未设置模型";
}

function renderState(state: PageTranslationState): void {
  togglePage.textContent = state.active ? "显示原文" : "翻译当前页面";
  status.textContent = state.active
    ? `页面翻译中，剩余 ${state.pending}/${state.total}`
    : "页面翻译关闭";
}

async function sendToActiveTab<T>(message: LocalTranslatorRequest): Promise<T> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("找不到当前标签页。");
  }
  return chrome.tabs.sendMessage(tab.id, message);
}

function mustGet<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}
