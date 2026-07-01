import { loadSettings, type LocalTranslatorSettings } from "./shared/settings";
import type {
  GetCommandShortcutResponse,
  LocalTranslatorRequest,
  PageTranslationState,
  TranslateTextResponse,
  TranslateTextsResponse
} from "./shared/messages";

const ignoredSelector = [
  "header",
  "nav",
  "footer",
  "aside",
  "menu",
  "script",
  "style",
  "noscript",
  "code",
  "pre",
  "textarea",
  "input",
  "select",
  "button",
  "[contenteditable='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='menu']",
  "[aria-label*='navigation' i]",
  "[aria-label*='menu' i]",
  "[data-local-translator-ui]",
  ".local-translator-wrapper"
].join(",");

const preferredBlockSelector = [
  "p",
  "li",
  "blockquote",
  "figcaption",
  "summary",
  "dd",
  "dt",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
].join(",");

const minTextLength = 12;
const minSelectionTextLength = 1;
const minShortLabelLength = 2;
const minCommentTextLength = 2;
const maxTextLength = 4000;
const mentionTokenPrefix = "\uE000LLT";
const mentionTokenSuffix = "\uE001";
const minPanelWidth = 200;
const maxPanelWidth = 520;

type TranslatedBlock = {
  element: Element;
  originalNodes: Node[];
  originalClassName: string;
  wrapper: HTMLElement;
  result: HTMLElement;
};

type SelectionAnchor = {
  x: number;
  y: number;
  buttonWidth?: number;
  buttonHeight?: number;
};

let translatedBlocks: TranslatedBlock[] = [];
let processedElements = new WeakSet<Element>();
let failedElements = new WeakSet<Element>();
let activeElements = new Set<Element>();
let pageActive = false;
let pending = 0;
let total = 0;
let panel: HTMLElement | null = null;
let mutationObserver: MutationObserver | null = null;
let runId = 0;
let scheduled = 0;
let hadSelectionBeforePointerDown = false;
let lastPointerPosition: SelectionAnchor = {
  x: Math.round(window.innerWidth / 2),
  y: Math.round(window.innerHeight / 2)
};
const translationCache = new Map<string, string>();
const maxCacheEntries = 1000;
let selectionShortcutLabel = "⌥E";

void refreshSelectionShortcutLabel();

chrome.runtime.onMessage.addListener((message: LocalTranslatorRequest, _sender, sendResponse) => {
  if (message.type === "toggle-page-translation") {
    void togglePageTranslation();
    return false;
  }

  if (message.type === "translate-selection") {
    void translateSelection();
    return false;
  }

  if (message.type === "get-page-state") {
    sendResponse(getPageState());
    return false;
  }

  return false;
});

document.addEventListener("mousemove", (event) => {
  lastPointerPosition = { x: event.clientX, y: event.clientY };
}, { passive: true });

document.addEventListener("mousedown", (event) => {
  if ((event.target as Element | null)?.closest("[data-local-translator-ui]")) {
    return;
  }

  const selection = window.getSelection();
  hadSelectionBeforePointerDown = Boolean(selection && !selection.isCollapsed && selection.toString().trim());
});

document.addEventListener("mouseup", (event) => {
  if ((event.target as Element | null)?.closest("[data-local-translator-ui]")) {
    return;
  }

  const anchor = { x: event.clientX, y: event.clientY };
  requestAnimationFrame(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";

    if (!selection || selection.isCollapsed || text.length < minSelectionTextLength || !selection.rangeCount) {
      hidePanel();
      hadSelectionBeforePointerDown = false;
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const singleClickCanceledOldSelection =
      hadSelectionBeforePointerDown && rect.width === 0 && rect.height === 0;
    hadSelectionBeforePointerDown = false;

    if (singleClickCanceledOldSelection) {
      hidePanel();
      return;
    }

    void loadSettings().then((settings) => {
      if (!settings.enableSelectionButton) {
        return;
      }
      void showSelectionButton(text, anchor);
    });
  });
});

document.addEventListener(
  "click",
  (event) => {
    if ((event.target as Element | null)?.closest("[data-local-translator-ui]")) {
      return;
    }
    if (!window.getSelection()?.toString().trim()) {
      hidePanel();
    }
  },
  true
);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hidePanel();
  }
});

async function togglePageTranslation(): Promise<void> {
  if (pageActive) {
    restorePage();
    return;
  }

  const settings = await loadSettings();
  if (isPageAlreadyTargetLanguage(settings)) {
    pageActive = false;
    total = 0;
    pending = 0;
    broadcastProgress();
    return;
  }

  pageActive = true;
  runId += 1;
  setupLiveTranslationListeners();
  scheduleVisibleTranslation();
}

function setupLiveTranslationListeners(): void {
  window.addEventListener("scroll", scheduleVisibleTranslation, { passive: true });
  window.addEventListener("resize", scheduleVisibleTranslation, { passive: true });

  mutationObserver?.disconnect();
  mutationObserver = new MutationObserver(() => {
    if (pageActive) {
      scheduleVisibleTranslation();
    }
  });
  if (document.body) {
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
  }
}

function stopLiveTranslationListeners(): void {
  window.removeEventListener("scroll", scheduleVisibleTranslation);
  window.removeEventListener("resize", scheduleVisibleTranslation);
  mutationObserver?.disconnect();
  mutationObserver = null;
  if (scheduled) {
    window.clearTimeout(scheduled);
    scheduled = 0;
  }
}

function scheduleVisibleTranslation(): void {
  if (scheduled || !pageActive) {
    return;
  }
  scheduled = window.setTimeout(() => {
    scheduled = 0;
    void translateVisibleBlocks();
  }, 120);
}

async function translateVisibleBlocks(): Promise<void> {
  if (!pageActive || !document.body) {
    return;
  }

  const settings = await loadSettings();
  const currentRunId = runId;
  const blocks = collectVisibleBlocks(settings).filter((element) => !activeElements.has(element));
  if (blocks.length === 0) {
    broadcastProgress();
    return;
  }

  total += blocks.length;
  pending += blocks.length;
  blocks.forEach((element) => activeElements.add(element));
  broadcastProgress();

  const batches = blocks.map((block) => [block]);
  let nextBatch = 0;
  const workerCount = Math.min(settings.maxConcurrentRequests, batches.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (pageActive && currentRunId === runId) {
      const batch = batches[nextBatch];
      nextBatch += 1;
      if (!batch) {
        return;
      }
      await translateBlockBatch(batch, settings, currentRunId);
    }
  });

  await Promise.all(workers);
}

async function translateBlockBatch(
  elements: Element[],
  settings: LocalTranslatorSettings,
  currentRunId: number
): Promise<void> {
  const originalTexts = elements.map((element) => normalizeText(element.textContent ?? ""));
  const protectedTexts = originalTexts.map(protectTranslationTokens);
  const cacheKeys = originalTexts.map((text) => getCacheKey(settings, text));
  const uncached: Array<{ element: Element; text: string; cacheKey: string; tokens: string[] }> = [];

  elements.forEach((element, index) => {
    const cached = translationCache.get(cacheKeys[index] ?? "");
    if (!cached) {
      uncached.push({
        element,
        text: protectedTexts[index]?.text ?? "",
        cacheKey: cacheKeys[index] ?? "",
        tokens: protectedTexts[index]?.tokens ?? []
      });
      return;
    }

    const shell = createBlockTranslationShell(element, settings);
    if (!shell || !pageActive || currentRunId !== runId || !element.isConnected) {
      shell && restoreBlock(shell);
      return;
    }
    completeBlockTranslation(shell, cached, settings);
    processedElements.add(element);
  });

  if (uncached.length === 0) {
    elements.forEach((element) => activeElements.delete(element));
    pending = Math.max(0, pending - elements.length);
    broadcastProgress();
    return;
  }

  const requestElements = uncached.map((item) => item.element);
  const requestTexts = uncached.map((item) => item.text);
  const shells = new Map<Element, TranslatedBlock>();
  for (const item of uncached) {
    const shell = createBlockTranslationShell(item.element, settings);
    if (shell) {
      shells.set(item.element, shell);
    }
  }
  try {
    const translatedTexts = await translateTexts(requestTexts);
    requestElements.forEach((element, index) => {
      const translated = translatedTexts[index];
      const shell = shells.get(element);
      const uncachedItem = uncached[index];
      if (!translated || !pageActive || currentRunId !== runId || !element.isConnected) {
        shell && restoreBlock(shell);
        failedElements.add(element);
        return;
      }
      const restored = restoreTranslationTokens(translated, uncachedItem?.tokens ?? []);
      setCache(uncachedItem?.cacheKey ?? "", restored);
      shell && completeBlockTranslation(shell, restored, settings);
      processedElements.add(element);
    });
  } catch (error) {
    shells.forEach((shell) => restoreBlock(shell));
    elements.forEach((element) => failedElements.add(element));
    console.debug("[local-llm-translator] translation failed", error);
  } finally {
    elements.forEach((element) => activeElements.delete(element));
    pending = Math.max(0, pending - elements.length);
    broadcastProgress();
  }
}

function collectVisibleBlocks(settings: LocalTranslatorSettings): Element[] {
  const preferred = dedupeNestedBlocks(
    queryContentRoots(preferredBlockSelector).filter((element) =>
      shouldTranslateElement(element, settings)
    )
  );
  const siteSpecific = dedupeNestedBlocks(
    querySiteSpecificBlocks().filter((element) =>
      shouldTranslateElement(element, settings, { minTextLength: minCommentTextLength })
    )
  );
  const candidates = dedupeNestedBlocks([...preferred, ...siteSpecific]);

  if (candidates.length > 0) {
    return candidates.slice(0, settings.maxConcurrentRequests * 3);
  }

  const fallback = dedupeNestedBlocks(
    queryContentRoots("article, main, section, div")
      .filter((element) => isLeafLikeBlock(element))
      .filter((element) => shouldTranslateElement(element, settings))
  );
  return fallback.slice(0, settings.maxConcurrentRequests * 3);
}

function queryContentRoots(selector: string): Element[] {
  const roots = Array.from(document.querySelectorAll("main, article, [role='main']"));
  const searchRoots = roots.length > 0 ? roots : [document.body];
  const result: Element[] = [];
  for (const root of searchRoots) {
    result.push(...Array.from(root.querySelectorAll(selector)));
  }
  return result;
}

function dedupeNestedBlocks(elements: Element[]): Element[] {
  const elementSet = new Set(elements);
  return elements.filter((element) => {
    for (const child of elementSet) {
      if (child !== element && element.contains(child)) {
        return false;
      }
    }
    return true;
  });
}

type TranslateElementOptions = {
  minTextLength?: number;
};

function shouldTranslateElement(
  element: Element,
  settings: LocalTranslatorSettings,
  options?: TranslateElementOptions
): boolean {
  if (processedElements.has(element) || failedElements.has(element) || element.closest(ignoredSelector)) {
    return false;
  }
  if (isMentionOnlyElement(element)) {
    return false;
  }
  if (isLinkDenseElement(element)) {
    return false;
  }
  if (!isVisible(element)) {
    return false;
  }

  const text = normalizeText(element.textContent ?? "");
  if (!shouldTranslateText(text, element, options?.minTextLength)) {
    return false;
  }
  if (looksLikeModelName(text)) {
    return false;
  }
  if (isTextAlreadyTargetLanguage(text, settings.targetLanguage)) {
    return false;
  }
  return !Array.from(element.children).some((child) => processedElements.has(child));
}

function isLinkDenseElement(element: Element): boolean {
  const text = normalizeText(element.textContent ?? "");
  if (text.length < 40) {
    return false;
  }

  const links = Array.from(element.querySelectorAll("a"));
  if (links.length < 3) {
    return false;
  }

  const linkTextLength = links.reduce((sum, link) => sum + normalizeText(link.textContent ?? "").length, 0);
  return linkTextLength / text.length > 0.55;
}

function isLeafLikeBlock(element: Element): boolean {
  const text = normalizeText(element.textContent ?? "");
  if (text.length < 80) {
    return false;
  }
  return !Array.from(element.children).some((child) => {
    const childText = normalizeText(child.textContent ?? "");
    return child.matches(preferredBlockSelector) || childText.length > 80;
  });
}

function createBlockTranslationShell(
  element: Element,
  settings: LocalTranslatorSettings
): TranslatedBlock | null {
  if (element.querySelector(":scope > .local-translator-wrapper")) {
    return null;
  }

  const wrapperTag = isBlockElement(element) ? "div" : "span";
  const wrapper = document.createElement(wrapperTag);
  wrapper.className = "local-translator-wrapper";

  const original = document.createElement(wrapperTag);
  original.className = "local-translator-original";

  const result = document.createElement(wrapperTag);
  result.className = "local-translator-result local-translator-loading-row";
  result.innerHTML = element.matches("li")
    ? `<span class="local-translator-spinner" aria-hidden="true"></span>`
    : `<span class="local-translator-spinner" aria-hidden="true"></span><span>翻译中...</span>`;

  const originalNodes = Array.from(element.childNodes);
  const originalClassName = element.className;
  original.append(...originalNodes);
  wrapper.append(original, result);
  element.append(wrapper);

  if (settings.translationMode === "replace") {
    element.classList.add("local-translator-mode-replace");
  } else {
    element.classList.add("local-translator-mode-bilingual");
  }

  const block = { element, originalNodes, originalClassName, wrapper, result };
  translatedBlocks.push(block);
  return block;
}

function completeBlockTranslation(
  block: TranslatedBlock,
  translated: string,
  settings: LocalTranslatorSettings
): void {
  block.wrapper.classList.add("local-translator-completed");
  block.result.className =
    settings.translationMode === "bilingual"
      ? `local-translator-result local-translator-style-${settings.translationTextStyle}`
      : "local-translator-result";
  block.result.textContent = translated;
}

function restorePage(): void {
  runId += 1;
  stopLiveTranslationListeners();

  for (const item of [...translatedBlocks]) {
    restoreBlock(item);
  }

  translatedBlocks = [];
  processedElements = new WeakSet<Element>();
  failedElements = new WeakSet<Element>();
  activeElements.clear();
  pageActive = false;
  pending = 0;
  total = 0;
  broadcastProgress();
}

function restoreBlock(block: TranslatedBlock): void {
  block.element.className = block.originalClassName;
  if (block.wrapper.parentNode) {
    block.wrapper.replaceWith(...block.originalNodes);
  }
  translatedBlocks = translatedBlocks.filter((item) => item !== block);
}

async function translateSelection(): Promise<void> {
  const selection = window.getSelection();
  const text = selection?.toString().trim() ?? "";
  if (!text || !selection?.rangeCount) {
    return;
  }

  const rect = selection.getRangeAt(0).getBoundingClientRect();
  const anchor = selectionAnchorFromRect(rect);
  showPanel("翻译中...", anchor);
  try {
    showPanel(await translateText(text), anchor);
  } catch (error) {
    showPanel(error instanceof Error ? error.message : String(error), anchor);
  }
}

async function translateText(text: string): Promise<string> {
  const protectedText = protectTranslationTokens(normalizeText(text));
  const response = (await chrome.runtime.sendMessage({
    type: "translate-text",
    text: protectedText.text
  })) as TranslateTextResponse;

  if (!response.ok) {
    throw new Error(response.error);
  }
  return restoreTranslationTokens(response.text, protectedText.tokens);
}

async function translateTexts(texts: string[]): Promise<string[]> {
  const response = (await chrome.runtime.sendMessage({
    type: "translate-texts",
    texts
  })) as TranslateTextsResponse;

  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.texts;
}

async function showSelectionButton(text: string, anchor: SelectionAnchor): Promise<void> {
  hidePanel();
  await refreshSelectionShortcutLabel();

  const button = document.createElement("button");
  button.type = "button";
  button.className = "local-translator-float-button";
  button.dataset.localTranslatorUi = "true";
  button.innerHTML = `<span aria-hidden="true">文A</span><strong>翻译(${selectionShortcutLabel})</strong>`;

  button.addEventListener("mousedown", stopUiEvent);
  button.addEventListener("mouseup", stopUiEvent);
  button.addEventListener("click", async (event) => {
    stopUiEvent(event);
    const rect = button.getBoundingClientRect();
    const popupAnchor = {
      x: rect.right,
      y: rect.top,
      buttonWidth: rect.width,
      buttonHeight: rect.height
    };
    showPanel("翻译中...", popupAnchor);
    try {
      showPanel(await translateText(text), popupAnchor);
    } catch (error) {
      showPanel(error instanceof Error ? error.message : String(error), popupAnchor);
    }
  });

  panel = button;
  document.documentElement.append(button);
  positionFloatingElement(button, anchor, {
    width: button.offsetWidth || 120,
    height: button.offsetHeight || 32,
    verticalOffset: 12,
    horizontalOffset: 12
  });
}

async function refreshSelectionShortcutLabel(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "get-command-shortcut",
      command: "translate-selection"
    })) as GetCommandShortcutResponse;
    if (response.shortcut) {
      selectionShortcutLabel = response.shortcut;
    }
  } catch {
    // background 未就绪时保留默认值。
  }
}

function showPanel(text: string, anchor?: SelectionAnchor): void {
  hidePanel();
  const box = document.createElement("div");
  box.className = "local-translator-panel";
  box.dataset.localTranslatorUi = "true";

  const body = document.createElement("div");
  body.className = "local-translator-panel-body";
  if (text === "翻译中...") {
    body.innerHTML = `<span class="local-translator-spinner" aria-hidden="true"></span><strong>翻译中...</strong>`;
  } else {
    body.textContent = text;
  }

  const footer = document.createElement("div");
  footer.className = "local-translator-panel-footer";
  footer.textContent = "Local LLM Translator";

  box.append(body, footer);
  panel = box;
  document.documentElement.append(box);

  const panelWidth = Math.min(
    Math.max(box.offsetWidth, minPanelWidth),
    Math.min(maxPanelWidth, window.innerWidth * 0.8)
  );
  positionFloatingElement(box, anchor ?? lastPointerPosition, {
    width: panelWidth,
    height: box.offsetHeight || 120,
    verticalOffset: 8,
    horizontalOffset: 12
  });
}

function selectionAnchorFromRect(rect: DOMRect): SelectionAnchor {
  if (rect.width > 0 || rect.height > 0) {
    return { x: rect.right, y: rect.bottom };
  }
  return lastPointerPosition;
}

function positionFloatingElement(
  element: HTMLElement,
  anchor: SelectionAnchor,
  options: { width: number; height: number; verticalOffset: number; horizontalOffset?: number }
): void {
  const padding = 10;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  let left = anchor.x + scrollX + (options.horizontalOffset ?? 0);
  let top = anchor.y + scrollY + options.verticalOffset;
  const width = options.width;
  const height = options.height;

  if (left + width > window.innerWidth + scrollX - padding) {
    left = anchor.x + scrollX - width - (options.horizontalOffset ?? 0);
  }
  if (left < scrollX + padding) {
    left = scrollX + padding;
  }
  if (top + height > window.innerHeight + scrollY - padding) {
    top = anchor.y + scrollY - height - (anchor.buttonHeight ?? 0) - 10;
  }
  if (top < scrollY + padding) {
    top = scrollY + padding;
  }

  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}

function hidePanel(): void {
  panel?.remove();
  panel = null;
}

function getPageState(): PageTranslationState {
  return {
    active: pageActive,
    pending,
    total
  };
}

function broadcastProgress(): void {
  void chrome.runtime
    .sendMessage({
      type: "page-translation-progress",
      active: pageActive,
      pending,
      total
    })
    .catch(() => {
      // popup 未打开时没有监听者，这是正常状态。
    });
}

function stopUiEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
}

function isBlockElement(element: Element): boolean {
  const style = window.getComputedStyle(element);
  return style.display === "block" || style.display === "list-item" || style.display === "table-cell";
}

function shouldTranslateText(text: string, element?: Element, minLengthOverride?: number): boolean {
  const minLength =
    minLengthOverride ?? (isShortLabelElement(element) ? minShortLabelLength : minTextLength);
  if (text.length < minLength || text.length > maxTextLength) {
    return false;
  }
  if (/^[0-9.,+\s\-*:|/()[\]{}]+$/.test(text)) {
    return false;
  }
  if (/^@[\w.-]+$/.test(text)) {
    return false;
  }
  if (/^[\w.-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(text)) {
    return false;
  }
  if (/^(https?:\/\/)?[\w.-]+\.[A-Za-z]{2,}(:\d+)?(\/\S*)?$/i.test(text)) {
    return false;
  }
  return /\p{L}/u.test(text);
}

function isMentionOnlyElement(element: Element): boolean {
  const text = normalizeText(element.textContent ?? "");
  if (/^@[\w.-]+$/.test(text)) {
    return true;
  }
  if (element.matches("a[href*='/@'], a[href*='youtube.com/@']")) {
    return /^@[\w.-]+$/.test(text);
  }
  return false;
}

type ProtectedText = {
  text: string;
  tokens: string[];
};

function protectTranslationTokens(text: string): ProtectedText {
  const tokens: string[] = [];
  const protectedText = text.replace(/@[\w.-]+/g, (match) => {
    tokens.push(match);
    return `${mentionTokenPrefix}${tokens.length - 1}${mentionTokenSuffix}`;
  });
  return { text: protectedText, tokens };
}

function restoreTranslationTokens(text: string, tokens: string[]): string {
  let result = text;
  tokens.forEach((token, index) => {
    const marker = `${mentionTokenPrefix}${index}${mentionTokenSuffix}`;
    result = result.replaceAll(marker, token);
  });
  return result;
}

function querySiteSpecificBlocks(): Element[] {
  const host = location.hostname.toLowerCase();
  if (!host.endsWith("youtube.com") && host !== "youtu.be") {
    return [];
  }

  const commentHosts = document.querySelectorAll(
    "ytd-comment-thread-renderer, ytd-comment-renderer, ytd-comment-view-model"
  );
  const blocks: Element[] = [];
  for (const commentHost of commentHosts) {
    commentHost.querySelectorAll("yt-formatted-string#content-text, #content-text").forEach((element) => {
      blocks.push(element);
    });
  }
  return blocks;
}

function isShortLabelElement(element?: Element): boolean {
  if (!element) {
    return false;
  }
  return element.matches("th, td, dt, dd, h1, h2, h3, h4, h5, h6");
}

function looksLikeModelName(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6 || text.length > 64) {
    return false;
  }
  if (/[。！？；，、]/.test(text)) {
    return false;
  }
  const hasDigit = /\d/.test(text);
  const hasModelUnit = /\b(?:\d+(?:\.\d+)?\s*)?(?:B|M|K|A\d+B|MoE|MLX|GGUF|Q\d|FP\d+|MXFP\d+)\b/i.test(text);
  const shortNameWords = words.every((word) => /^[A-Za-z0-9._:+-]+$/.test(word));
  return shortNameWords && (hasDigit || hasModelUnit);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getCacheKey(settings: LocalTranslatorSettings, text: string): string {
  const scope = [
    location.origin,
    location.pathname,
    settings.backendKind,
    settings.baseUrl,
    settings.model,
    settings.targetLanguage,
    settings.promptTemplate,
    hashText(text)
  ];
  return scope.join("\u001f");
}

function setCache(key: string, value: string): void {
  if (!key || !value) {
    return;
  }
  if (translationCache.size >= maxCacheEntries) {
    const oldestKey = translationCache.keys().next().value;
    if (oldestKey) {
      translationCache.delete(oldestKey);
    }
  }
  translationCache.set(key, value);
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function isPageAlreadyTargetLanguage(settings: LocalTranslatorSettings): boolean {
  const pageLanguage =
    document.documentElement.lang ||
    document.querySelector("meta[http-equiv='content-language']")?.getAttribute("content") ||
    document.querySelector("meta[name='language']")?.getAttribute("content") ||
    "";
  return isSameLanguage(pageLanguage, settings.targetLanguage);
}

function isTextAlreadyTargetLanguage(text: string, targetLanguage: string): boolean {
  const target = normalizeLanguageCode(targetLanguage);
  if (target === "zh") {
    return cjkRatio(text) > 0.55;
  }
  if (target === "en") {
    return latinRatio(text) > 0.75 && cjkRatio(text) < 0.05;
  }
  return false;
}

function isSameLanguage(source: string, target: string): boolean {
  const sourceCode = normalizeLanguageCode(source);
  const targetCode = normalizeLanguageCode(target);
  return Boolean(sourceCode && targetCode && sourceCode === targetCode);
}

function normalizeLanguageCode(language: string): string {
  const value = language.toLowerCase().replace("_", "-").trim();
  if (!value) {
    return "";
  }
  if (value.includes("chinese") || value.includes("中文") || value.includes("hans") || value === "zh" || value === "zh-cn") {
    return "zh";
  }
  if (value.includes("hant") || value === "zh-tw" || value === "zh-hk") {
    return "tw";
  }
  if (value.includes("english") || value === "en" || value.startsWith("en-")) {
    return "en";
  }
  return value.split("-")[0] ?? value;
}

function cjkRatio(text: string): number {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) {
    return 0;
  }
  return letters.filter((char) => /[\u3400-\u9fff]/u.test(char)).length / letters.length;
}

function latinRatio(text: string): number {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) {
    return 0;
  }
  return letters.filter((char) => /[A-Za-z]/.test(char)).length / letters.length;
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
