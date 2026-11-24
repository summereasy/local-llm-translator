import { loadSettings, type LocalTranslatorSettings } from "./shared/settings";
import {
  backendCompatibilityError,
  presetSupportsBatchPrompt,
  resolveChatTemplateKwargs,
  resolvePromptTemplate,
  resolveTemperature
} from "./shared/modelPresets";
import { formatCommandShortcut } from "./shared/shortcuts";
import { SseAccumulator, StreamDeltaAssembler } from "./shared/sse";
import {
  streamPortName,
  type GetCommandShortcutResponse,
  type LocalTranslatorRequest,
  type StreamPortMessage,
  type TranslateTextResponse,
  type TranslateTextsResponse
} from "./shared/messages";

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

  if (message.type === "get-command-shortcut") {
    void chrome.commands.getAll().then((commands) => {
      const command = commands.find((item) => item.name === message.command);
      sendResponse({
        shortcut: formatCommandShortcut(message.command, command?.shortcut)
      } satisfies GetCommandShortcutResponse);
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

/**
 * 极速模式的流式通道: 每批翻译一个 Port,后端 stream:true 逐 token 推给
 * content script 渐进渲染。建流失败时 content 侧自动回落整段返回。
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== streamPortName) {
    return;
  }
  // 页面侧断开(关闭翻译/导航/关标签)时终止在途 fetch,别继续占用本地模型。
  const aborter = new AbortController();
  port.onDisconnect.addListener(() => aborter.abort());
  port.onMessage.addListener((message: StreamPortMessage) => {
    if (message.type === "stream-translate") {
      void handleStreamTranslate(port, message.texts, aborter.signal);
    }
  });
});

async function handleStreamTranslate(
  port: chrome.runtime.Port,
  texts: string[],
  signal: AbortSignal
): Promise<void> {
  if (texts.length === 0) {
    return;
  }
  try {
    const settings = await loadSettings();
    if (settings.backendKind !== "openai-compatible") {
      throw new Error("Ollama 后端不支持流式,请关闭极速模式。");
    }
    assertBackendSupportsPreset(settings);

    let cursor = 0;
    const workerCount = Math.min(settings.maxConcurrentRequests, texts.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= texts.length) {
          return;
        }
        try {
          const text = texts[index] ?? "";
          const translated = await streamTranslateOne(settings, text, signal, (delta) =>
            postToPort(port, { type: "stream-delta", index, delta })
          );
          postToPort(port, { type: "stream-done", index, text: translated });
        } catch (error) {
          postToPort(port, { type: "stream-error", index, error: errorMessage(error) });
        }
      }
    });
    await Promise.all(workers);
  } catch (error) {
    // 设置读取等前置步骤失败:每个 index 都要收到终止事件,content 侧才不会悬等。
    const message = errorMessage(error);
    texts.forEach((_, index) => postToPort(port, { type: "stream-error", index, error: message }));
  }
}

function postToPort(port: chrome.runtime.Port, message: StreamPortMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // 页面侧已断开(导航/关闭),剩余结果丢弃。
  }
}

async function streamTranslateOne(
  settings: LocalTranslatorSettings,
  text: string,
  signal: AbortSignal,
  onDelta: (delta: string) => void
): Promise<string> {
  if (!settings.model) {
    throw new Error("请先在设置里填写模型名。");
  }

  const response = await fetch(openAIChatCompletionsUrl(settings.baseUrl), {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      ...backendCacheHeaders(settings)
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(settings, text)
        }
      ],
      ...chatTemplateKwargsBody(settings),
      temperature: resolveTemperature(settings.model),
      stream: true
    })
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`本地服务请求失败: HTTP ${response.status} ${body.slice(0, 300)}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    // 后端无视 stream:true 返回普通 JSON:抛错让 content 侧回落整段请求,
    // 否则会被当成"空译文"静默失败。
    throw new Error("后端没有返回 SSE 流(text/event-stream),已回落整段请求。");
  }

  const accumulator = new SseAccumulator();
  const assembler = new StreamDeltaAssembler();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      for (const data of accumulator.push(decoder.decode(value, { stream: true }))) {
        if (assembler.consume(data, onDelta)) {
          // 已收到 [DONE]:正常结束信号到了,不再等响应体 EOF。
          return finishStream(assembler);
        }
      }
      if (assembler.done) {
        return finishStream(assembler);
      }
    }
    for (const data of [...accumulator.push(decoder.decode()), ...accumulator.flush()]) {
      if (assembler.consume(data, onDelta)) {
        break;
      }
    }
  } finally {
    // 结束信号已到或对端不再发数据,主动放弃剩余响应体。
    await reader.cancel().catch(() => {});
  }
  const finished = assembler.finish();
  if (!finished.ok) {
    throw new Error(finished.reason);
  }
  return finished.text;
}

function finishStream(assembler: StreamDeltaAssembler): string {
  const finished = assembler.finish();
  if (!finished.ok) {
    throw new Error(finished.reason);
  }
  return finished.text;
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

  assertBackendSupportsPreset(settings);

  if (inputs.length === 1) {
    const input = inputs[0] ?? "";
    return [await translateSingle(settings, input)];
  }

  if (!presetSupportsBatchPrompt(settings.model)) {
    return Promise.all(inputs.map((input) => translateSingle(settings, input)));
  }

  if (settings.backendKind === "ollama") {
    return translateBatchWithOllama(settings, inputs);
  }

  return translateBatchWithOpenAICompatible(settings, inputs);
}

async function translateSingle(settings: LocalTranslatorSettings, input: string): Promise<string> {
  if (settings.backendKind === "ollama") {
    return translateWithOllama(settings, input);
  }
  return translateWithOpenAICompatible(settings, input);
}

async function translateWithOpenAICompatible(settings: LocalTranslatorSettings, text: string): Promise<string> {
  if (!settings.model) {
    throw new Error("请先在设置里填写模型名。");
  }

  const response = await fetch(openAIChatCompletionsUrl(settings.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      ...backendCacheHeaders(settings)
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(settings, text)
        }
      ],
      ...chatTemplateKwargsBody(settings),
      temperature: resolveTemperature(settings.model),
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
      ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      ...backendCacheHeaders(settings)
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: renderBatchPrompt(settings, texts)
        }
      ],
      ...chatTemplateKwargsBody(settings),
      temperature: resolveTemperature(settings.model),
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
  return resolvePromptTemplate({
    model: settings.model,
    targetLanguage: settings.targetLanguage,
    promptTemplate: settings.promptTemplate,
    promptTemplateMode: settings.promptTemplateMode
  })
    .replaceAll("{{targetLanguage}}", settings.targetLanguage)
    .replaceAll("{{text}}", text);
}

/**
 * 翻译是一次性请求,前缀命中率接近 0,写缓存只会占磁盘并挤掉其他会话的 hot cache。
 * oMLX 只认 HTTP header,`off` 只关写入、不关读取;其他后端会忽略这个未知 header。
 */
function backendCacheHeaders(settings: LocalTranslatorSettings): Record<string, string> {
  return settings.disableBackendCache ? { "X-oMLX-Cache-Store": "off" } : {};
}

/** 需要 chat_template_kwargs 的模型(如 PLaMo)把目标语言当请求参数下发。 */
function chatTemplateKwargsBody(settings: LocalTranslatorSettings): Record<string, unknown> {
  const kwargs = resolveChatTemplateKwargs({
    model: settings.model,
    targetLanguage: settings.targetLanguage
  });
  return kwargs ? { chat_template_kwargs: kwargs } : {};
}

function assertBackendSupportsPreset(settings: LocalTranslatorSettings): void {
  const error = backendCompatibilityError(settings.model, settings.backendKind);
  if (error) {
    throw new Error(error);
  }
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
