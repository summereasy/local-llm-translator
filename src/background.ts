import { loadSettings, type LocalTranslatorSettings } from "./shared/settings";
import type { LocalTranslatorRequest, TranslateTextResponse, TranslateTextsResponse } from "./shared/messages";

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-page-translation") {
    void sendToActiveTab({ type: "toggle-page-translation" });
  }

  if (command === "translate-selection") {
    void sendToActiveTab({ type: "translate-selection" });
  }
});

chrome.runtime.onMessage.addListener((message: LocalTranslatorRequest, _sender, sendResponse) => {
  if (message.type === "translate-text") {
    void translateText(message.text)
      .then((text) => sendResponse({ ok: true, text } satisfies TranslateTextResponse))
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: errorMessage(error) } satisfies TranslateTextResponse);
      });

    return true;
  }

  if (message.type === "translate-texts") {
    void translateTexts(message.texts)
      .then((texts) => sendResponse({ ok: true, texts } satisfies TranslateTextsResponse))
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: errorMessage(error) } satisfies TranslateTextsResponse);
      });

    return true;
  }

  return false;
});

async function sendToActiveTab(message: LocalTranslatorRequest): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return;
  }
  await chrome.tabs.sendMessage(tab.id, message);
}

async function translateText(text: string): Promise<string> {
  const [translated] = await translateTexts([text]);
  return translated ?? "";
}

async function translateTexts(texts: string[]): Promise<string[]> {
  const settings = await loadSettings();
  const inputs = texts.map((text) => text.trim()).filter(Boolean);
  if (inputs.length === 0) {
    return [];
  }

  if (inputs.length === 1) {
    const input = inputs[0] ?? "";
    if (settings.backendKind === "ollama") {
      return [await translateWithOllama(settings, input)];
    }
    return [await translateWithOpenAICompatible(settings, input)];
  }

  if (settings.backendKind === "ollama") {
    return translateBatchWithOllama(settings, inputs);
  }

  return translateBatchWithOpenAICompatible(settings, inputs);
}

async function translateWithOpenAICompatible(settings: LocalTranslatorSettings, text: string): Promise<string> {
  if (!settings.model) {
    throw new Error("请先在设置里填写模型名。");
  }

  const response = await fetch(openAIChatCompletionsUrl(settings.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(settings, text)
        }
      ],
      temperature: 0.2,
      stream: false
    })
  });

  const json = await readJson(response);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("本地服务返回格式不是 OpenAI-compatible chat completion。");
  }
  return content.trim();
}

async function translateBatchWithOpenAICompatible(settings: LocalTranslatorSettings, texts: string[]): Promise<string[]> {
  const response = await fetch(openAIChatCompletionsUrl(settings.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: renderBatchPrompt(settings, texts)
        }
      ],
      temperature: 0.2,
      stream: false
    })
  });

  const json = await readJson(response);
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("本地服务返回格式不是 OpenAI-compatible chat completion。");
  }
  return parseBatchTranslation(content, texts.length);
}

async function translateWithOllama(settings: LocalTranslatorSettings, text: string): Promise<string> {
  if (!settings.model) {
    throw new Error("请先在设置里填写模型名。");
  }

  const response = await fetch(`${settings.baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(settings, text)
        }
      ],
      stream: false
    })
  });

  const json = await readJson(response);
  const content = json?.message?.content;
  if (typeof content !== "string") {
    throw new Error("本地服务返回格式不是 Ollama chat response。");
  }
  return content.trim();
}

async function translateBatchWithOllama(settings: LocalTranslatorSettings, texts: string[]): Promise<string[]> {
  const response = await fetch(`${settings.baseUrl}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: renderBatchPrompt(settings, texts)
        }
      ],
      stream: false
    })
  });

  const json = await readJson(response);
  const content = json?.message?.content;
  if (typeof content !== "string") {
    throw new Error("本地服务返回格式不是 Ollama chat response。");
  }
  return parseBatchTranslation(content, texts.length);
}

function renderPrompt(settings: LocalTranslatorSettings, text: string): string {
  return settings.promptTemplate
    .replaceAll("{{targetLanguage}}", settings.targetLanguage)
    .replaceAll("{{text}}", text);
}

function renderBatchPrompt(settings: LocalTranslatorSettings, texts: string[]): string {
  return [
    `请把 JSON 数组里的每一项翻译成${settings.targetLanguage}。`,
    "必须只返回 JSON 字符串数组，数组长度和输入完全一致，不要解释，不要 Markdown。",
    "输入:",
    JSON.stringify(texts)
  ].join("\n");
}

function parseBatchTranslation(content: string, expectedLength: number): string[] {
  const text = content.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length === expectedLength && parsed.every((item) => typeof item === "string")) {
      return parsed.map((item) => item.trim());
    }
  } catch {
    // 继续走兼容解析。
  }

  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  if (lines.length === expectedLength) {
    return lines;
  }

  if (expectedLength === 1) {
    return [text];
  }
  throw new Error("批量翻译返回格式无法解析。");
}

function openAIChatCompletionsUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/chat/completions")) {
    return baseUrl;
  }
  return `${baseUrl}/chat/completions`;
}

async function readJson(response: Response): Promise<any> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`本地服务请求失败: HTTP ${response.status} ${body.slice(0, 300)}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`本地服务返回的不是 JSON: ${body.slice(0, 300)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
