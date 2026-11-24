import { loadSettings, type LocalTranslatorSettings } from "./shared/settings";
import { promptScopeKey } from "./shared/modelPresets";
import { looksUntranslated } from "./shared/textCheck";
import type {
  GetCommandShortcutResponse,
  LocalTranslatorRequest,
  PageTranslationState,
  StreamPortMessage,
  TranslateTextResponse,
  TranslateTextsResponse
} from "./shared/messages";
import { streamPortName } from "./shared/messages";

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

type StructuredBlockRule = {
  blockSelector: string;
  contentSelector: string;
  relayoutSelector?: string;
};

// 用于“主文本 + 需保留的元数据”卡片。规则只描述 DOM 契约，
// 文本提取、结果渲染和布局刷新由通用流程完成。
const structuredBlockRules: StructuredBlockRule[] = [
  {
    blockSelector: "#waterfall .movie-box .photo-info",
    contentSelector: ":scope > span",
    relayoutSelector: ".masonry"
  }
];

type TranslatedBlock = {
  element: Element;
  originalNodes: Node[];
  originalClassName: string;
  wrapper: HTMLElement;
  result: HTMLElement;
  /** 极速模式: 上次流式上屏时间,用于节流。 */
  streamRenderAt?: number;
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
  // 首次触发不吃防抖,按下快捷键立刻开翻。
  scheduleVisibleTranslation(true);
}

function onViewportChange(): void {
  scheduleVisibleTranslation();
}

function setupLiveTranslationListeners(): void {
  window.addEventListener("scroll", onViewportChange, { passive: true });
  window.addEventListener("resize", onViewportChange, { passive: true });

  mutationObserver?.disconnect();
  mutationObserver = new MutationObserver((mutations) => {
    if (!pageActive) {
      return;
    }
    // 自己写译文触发的 mutation 不算页面变化,否则流式渲染期间会
    // 每 120ms 全页重扫一遍。
    for (const mutation of mutations) {
      const target = mutation.target as Element | null;
      const fromSelf =
        target && typeof target.closest === "function" && target.closest(".local-translator-wrapper");
      if (!fromSelf) {
        scheduleVisibleTranslation();
        return;
      }
    }
  });
  if (document.body) {
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
  }
}

function stopLiveTranslationListeners(): void {
  window.removeEventListener("scroll", onViewportChange);
  window.removeEventListener("resize", onViewportChange);
  mutationObserver?.disconnect();
  mutationObserver = null;
  if (scheduled) {
    window.clearTimeout(scheduled);
    scheduled = 0;
  }
}

function scheduleVisibleTranslation(immediate = false): void {
  if (immediate) {
    if (scheduled) {
      window.clearTimeout(scheduled);
      scheduled = 0;
    }
    void translateVisibleBlocks();
    return;
  }
  if (scheduled || !pageActive) {
    return;
  }
  scheduled = window.setTimeout(() => {
    scheduled = 0;
    void translateVisibleBlocks();
  }, 120);
}

let collectingBlocks = false;
let needsViewportRescan = false;

async function translateVisibleBlocks(): Promise<void> {
  if (!pageActive || !document.body) {
    return;
  }
  if (collectingBlocks) {
    // 批次进行中来了新视口(滚动/展开):记下,批次结束后按最新视口补扫一次,
    // 否则要等用户再滚一下才会翻新内容。
    needsViewportRescan = true;
    return;
  }

  collectingBlocks = true;
  try {
    await collectAndTranslate();
  } finally {
    collectingBlocks = false;
    if (needsViewportRescan && pageActive) {
      needsViewportRescan = false;
      scheduleVisibleTranslation();
    }
  }
}

async function collectAndTranslate(): Promise<void> {
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
  if (!pageActive || currentRunId !== runId) {
    // 收集期间 run 变了(关→开切换): 让新一轮滚动调度接手,别把新 run 悬死。
    scheduleVisibleTranslation();
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
  const originalTexts = elements.map((element) => extractBlockText(element));
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
    let translatedTexts: string[] | null = null;
    let streamedAnyRender = false;
    let abortedByCancel = false;
    if (settings.turboMode && settings.backendKind === "openai-compatible") {
      try {
        translatedTexts = await streamTranslateTexts(requestTexts, (index, partial) => {
          const element = requestElements[index];
          if (!element) {
            return;
          }
          const shell = shells.get(element);
          if (!shell || !pageActive || currentRunId !== runId) {
            return;
          }
          if (partial.trim()) {
            // 纯空白的 partial 不算"已上屏":否则纯空白译文报错时会被
            // 已上屏判定挡住,跳过整段回落。
            streamedAnyRender = true;
          }
          const uncachedItem = uncached[index];
          renderStreamingText(
            shell,
            restoreTranslationTokens(partial, uncachedItem?.tokens ?? [])
          );
        });
      } catch (streamError) {
        if (!pageActive || currentRunId !== runId) {
          // 用户已关闭或切换:请求被主动取消。不回落整段(那会背着用户继续
          // 发请求)、不标记失败,壳已由 restorePage 还原,直接收尾。
          abortedByCancel = true;
        } else if (streamedAnyRender) {
          // 译文已经上屏到一半,断流按整批失败处理,与既有错误路径一致。
          throw streamError;
        } else {
          console.debug("[local-llm-translator] streaming unavailable, falling back", streamError);
        }
      }
    }
    if (abortedByCancel) {
      return;
    }
    if (!translatedTexts) {
      translatedTexts = await translateTexts(requestTexts);
    }
    requestElements.forEach((element, index) => {
      const translated = translatedTexts[index];
      const shell = shells.get(element);
      const uncachedItem = uncached[index];
      if (!pageActive || currentRunId !== runId) {
        // 旧 run 的批次:只清掉自己的壳,不碰新一轮的 failed/active/pending。
        shell && restoreBlock(shell);
        return;
      }
      if (!translated || !element.isConnected) {
        shell && restoreBlock(shell);
        failedElements.add(element);
        return;
      }
      warnUnchangedTranslation(settings, uncachedItem?.text ?? "", translated);
      const restored = restoreTranslationTokens(translated, uncachedItem?.tokens ?? []);
      setCache(uncachedItem?.cacheKey ?? "", restored);
      shell && completeBlockTranslation(shell, restored, settings);
      processedElements.add(element);
    });
  } catch (error) {
    const stale = !pageActive || currentRunId !== runId;
    shells.forEach((shell) => restoreBlock(shell));
    if (!stale) {
      elements.forEach((element) => failedElements.add(element));
    }
    warnPageTranslationError(settings, error);
    console.debug("[local-llm-translator] translation failed", error);
  } finally {
    if (pageActive && currentRunId === runId) {
      elements.forEach((element) => activeElements.delete(element));
      pending = Math.max(0, pending - elements.length);
    }
    broadcastProgress();
  }
}

function collectVisibleBlocks(settings: LocalTranslatorSettings): Element[] {
  const preferred = dedupeNestedBlocks(
    queryContentRoots(preferredBlockSelector).filter((element) =>
      shouldTranslateElement(element, settings, { includeLayoutFragile: true })
    )
  );
  const siteSpecific = dedupeNestedBlocks(
    querySiteSpecificBlocks().filter((element) =>
      shouldTranslateElement(element, settings, { minTextLength: minCommentTextLength })
    )
  );
  const candidates = dedupeNestedBlocks([...siteSpecific, ...preferred]);
  const expanded = expandLayoutFragile(candidates, settings);

  if (expanded.length > 0) {
    return prioritizeByViewport(expanded).slice(0, settings.maxConcurrentRequests * 3);
  }

  const fallback = dedupeNestedBlocks(
    queryContentRoots("article, main, section, div")
      .filter((element) => isLeafLikeBlock(element))
      .filter((element) => shouldTranslateElement(element, settings))
  );
  return prioritizeByViewport(expandLayoutFragile(fallback, settings)).slice(
    0,
    settings.maxConcurrentRequests * 3
  );
}

/**
 * DOM 顺序不等于视觉顺序。按视口位置排序后再截断,保证首批请求优先
 * 覆盖首屏段落,而不是被页脚之类的后置内容占满并发额度。
 */
function prioritizeByViewport(elements: Element[]): Element[] {
  const tops = new Map<Element, number>();
  for (const element of elements) {
    tops.set(element, element.getBoundingClientRect().top);
  }
  return [...elements].sort((a, b) => (tops.get(a) ?? 0) - (tops.get(b) ?? 0));
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
  /** 收集阶段放行 flex/grid 容器,交给 expandLayoutFragile 下沉到子节点。 */
  includeLayoutFragile?: boolean;
};

function shouldTranslateElement(
  element: Element,
  settings: LocalTranslatorSettings,
  options?: TranslateElementOptions
): boolean {
  if (processedElements.has(element) || failedElements.has(element) || isIgnoredElement(element)) {
    return false;
  }
  // X 只翻译推文正文。profile / 按钮 / fallback 大容器一律跳过，避免毁掉布局。
  if (isXHost() && !isXTweetTextElement(element)) {
    return false;
  }
  if (isMentionOnlyElement(element)) {
    return false;
  }
  if (isLinkDenseElement(element)) {
    return false;
  }
  if (isCompositeMetadataBlock(element)) {
    return false;
  }
  if (!options?.includeLayoutFragile && isLayoutFragileContainer(element)) {
    // 默认拒绝;收集阶段用 includeLayoutFragile 放行进来,
    // 由 expandLayoutFragile 换成可翻译的文本子节点。
    return false;
  }
  if (isYoutubeWatchChrome(element)) {
    return false;
  }
  if (!isVisible(element)) {
    return false;
  }

  const text = extractBlockText(element);
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
  // X 会把 @mention / hashtag / t.co 都做成链接，不能按导航链接密度过滤。
  if (isXTweetTextElement(element) || element.closest('[data-testid="tweetText"]')) {
    return false;
  }

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

function isCompositeMetadataBlock(element: Element): boolean {
  const hasHeading = element.querySelector("h1, h2, h3");
  const hasChannel = element.querySelector("ytd-channel-name, #channel-name, #owner, ytd-video-owner-renderer");
  const hasActions = element.querySelector(
    "button, ytd-button-renderer, ytd-subscribe-button-renderer, #actions-inner, ytd-menu-renderer"
  );
  if (hasHeading && (hasChannel || hasActions)) {
    return true;
  }
  if (hasChannel && hasActions) {
    return true;
  }
  return element.matches("#info, #top-row, ytd-video-owner-renderer, #owner, #actions, #actions-inner");
}

/**
 * flex/grid 且带元素子节点的块。设计站点常见:标题行 = 标题 + 副标题 + 更新时间
 * 横排在一个 h2/li/td 里。整体套壳会把横排子元素全塞进一个容器,布局崩掉
 * (2026-11-24 slopalytics 实测);这类块不改自身,下沉到文本子节点分别翻译。
 */
function isLayoutFragileContainer(element: Element): boolean {
  const display = window.getComputedStyle(element).display;
  if (display !== "flex" && display !== "grid" && display !== "inline-flex" && display !== "inline-grid") {
    return false;
  }
  return element.children.length > 0;
}

/** flex/grid 容器下沉:把容器自身换成分别可翻译的文本子节点(flex 套 flex 递归,最多 3 层)。 */
function expandLayoutFragile(
  elements: Element[],
  settings: LocalTranslatorSettings
): Element[] {
  const result: Element[] = [];
  const visit = (element: Element, depth: number): void => {
    if (!isLayoutFragileContainer(element)) {
      result.push(element);
      return;
    }
    if (depth <= 0) {
      // flex 嵌套太深:放弃这块,宁可少翻一段不毁布局。
      return;
    }
    for (const child of Array.from(element.children)) {
      if (
        shouldTranslateElement(child, settings, {
          minTextLength: minCommentTextLength,
          includeLayoutFragile: true
        })
      ) {
        if (isLayoutFragileContainer(child)) {
          visit(child, depth - 1);
        } else {
          result.push(child);
        }
      }
    }
  };
  for (const element of elements) {
    visit(element, 3);
  }
  return dedupeNestedBlocks(result);
}

function isYoutubeWatchChrome(element: Element): boolean {
  const host = location.hostname.toLowerCase();
  if (!host.endsWith("youtube.com") && host !== "youtu.be") {
    return false;
  }
  if (element.closest("#description, ytd-expandable-video-description-body, #description-inline-expander")) {
    return false;
  }
  return element.closest(
    "#info, #top-row, ytd-video-owner-renderer, #owner, #actions, #actions-inner, ytd-menu-renderer, ytd-channel-name, #channel-name"
  ) !== null;
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

function findDeepestTextElement(root: Element): HTMLElement | null {
  const leaves: HTMLElement[] = [];
  const walk = (node: Element): void => {
    if (node.childElementCount === 0 && node instanceof HTMLElement) {
      leaves.push(node);
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return (
    leaves.find((leaf) =>
      leaf.matches(
        '[role="text"], .ytAttributedStringHost, .yt-formatted-string, .yt-attributed-string, .yt-core-attributed-string, span[dir]'
      )
    ) ??
    leaves[leaves.length - 1] ??
    null
  );
}

function findPresentationTemplate(container: Element): HTMLElement | null {
  const selectors = [
    "a[class*='Title'], a[class*='title']",
    ".yt-formatted-string",
    ".yt-attributed-string",
    ".ytAttributedStringHost",
    "[role='text']",
    "span[dir]",
    "span",
    "a"
  ];
  for (const selector of selectors) {
    for (const match of container.querySelectorAll(selector)) {
      if (!(match instanceof HTMLElement)) {
        continue;
      }
      if (match.closest("ytd-channel-name, #channel-name, #owner, #info")) {
        continue;
      }
      if (normalizeText(match.textContent ?? "").length === 0) {
        continue;
      }
      return match;
    }
  }
  const firstElement = container.firstElementChild;
  return firstElement instanceof HTMLElement ? firstElement : null;
}

function buildPresentationResult(original: HTMLElement, translated: string): Node {
  const template = findPresentationTemplate(original);
  if (!template) {
    return document.createTextNode(translated);
  }

  const clone = template.cloneNode(true) as HTMLElement;
  const textTarget = findDeepestTextElement(clone) ?? clone;
  textTarget.textContent = translated;
  return clone;
}

function buildStructuredBlockResult(
  original: Element,
  translated: string,
  rule: StructuredBlockRule
): Node {
  const clone = original.cloneNode(true) as Element;
  const content = findStructuredBlockContent(clone, rule);
  const node = content ? findFirstNonEmptyTextNode(content) : null;
  if (node) {
    node.nodeValue = translated;
  }
  return content ?? document.createTextNode(translated);
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
  block.wrapper.classList.remove("local-translator-streaming");
  block.wrapper.classList.add("local-translator-completed");
  const preserveBreaks = isXTweetTextElement(block.element) || translated.includes("\n");
  block.result.className =
    settings.translationMode === "bilingual"
      ? `local-translator-result local-translator-style-${settings.translationTextStyle}${
          preserveBreaks ? " local-translator-preserve-breaks" : ""
        }`
      : `local-translator-result${preserveBreaks ? " local-translator-preserve-breaks" : ""}`;

  const original = block.wrapper.querySelector(".local-translator-original");
  if (settings.translationMode === "replace" && original instanceof HTMLElement) {
    // X 等站点可能用更高优先级 display 盖掉 stylesheet，这里强制隐藏原文。
    original.style.setProperty("display", "none", "important");
    if (isXTweetTextElement(block.element)) {
      // 多 span 推文不适合 YouTube 那套 clone-first-span 展示，直接替换为纯文本。
      block.result.textContent = translated;
      return;
    }
    const structuredRule = findStructuredBlockRule(block.element);
    if (structuredRule) {
      // 只替换之前送去翻译的主文本节点，保留卡片里的其他结构和元数据。
      block.result.replaceChildren(buildStructuredBlockResult(original, translated, structuredRule));
      scheduleStructuredBlockRelayout(structuredRule);
      return;
    }
    block.result.replaceChildren(buildPresentationResult(original, translated));
    return;
  }

  const structuredRule = findStructuredBlockRule(block.element);
  if (structuredRule) {
    block.result.textContent = translated;
    scheduleStructuredBlockRelayout(structuredRule);
    return;
  }

  block.result.textContent = translated;
}

function restorePage(): void {
  runId += 1;
  stopLiveTranslationListeners();
  needsViewportRescan = false;
  // 主动结算在途流式请求:Chrome 只在对端触发 onDisconnect,自己 disconnect()
  // 不会唤醒本侧监听,Promise 会悬着、collectingBlocks 永远不释放。
  for (const cancel of [...activeStreamCancellers]) {
    cancel();
  }
  activeStreamCancellers.clear();
  // 断开 Port 本身:后台 onDisconnect 会 abort 对应 fetch,
  // 不让旧请求继续占用本地模型、排队在下一轮翻译前面。
  for (const port of activeStreamPorts) {
    try {
      port.disconnect();
    } catch {
      // 已断。
    }
  }
  activeStreamPorts.clear();

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
  scheduleStructuredBlockRelayouts();
  broadcastProgress();
}

function restoreBlock(block: TranslatedBlock): void {
  block.element.className = block.originalClassName;
  if (block.wrapper.parentNode) {
    block.wrapper.replaceWith(...block.originalNodes);
  }
  translatedBlocks = translatedBlocks.filter((item) => item !== block);
}

const warnedUnchangedModels = new Set<string>();
const warnedPageErrors = new Set<string>();

function warnPageTranslationError(settings: LocalTranslatorSettings, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const key = `${settings.backendKind}\u001f${settings.model}\u001f${message}`;
  if (warnedPageErrors.has(key)) {
    return;
  }
  warnedPageErrors.add(key);
  console.warn(`[local-llm-translator] ${message}`);
}

function selectionHint(
  settings: LocalTranslatorSettings,
  source: string,
  translated: string
): string | undefined {
  if (!looksUntranslated(source, translated, settings.targetLanguage)) {
    return undefined;
  }
  return "译文看起来和原文一样。原文可能已是目标语言，或该模型需要专用 Prompt: 设置 → Prompt → 关闭“自动匹配”后自定义。";
}

function warnUnchangedTranslation(
  settings: LocalTranslatorSettings,
  source: string,
  translated: string
): void {
  if (!looksUntranslated(source, translated, settings.targetLanguage)) {
    return;
  }
  const key = `${settings.model}\u001f${settings.targetLanguage}\u001f${promptScopeKey(settings)}`;
  if (warnedUnchangedModels.has(key)) {
    return;
  }
  warnedUnchangedModels.add(key);
  console.warn(
    `[local-llm-translator] ${settings.model} 的输出看起来没有翻译。若该模型要求裸文本或专用模板,请在设置里关闭“自动匹配”并填写自定义 Prompt。`
  );
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
    const settings = await loadSettings();
    const translated = await translateText(text);
    showPanel(translated, anchor, selectionHint(settings, text, translated));
  } catch (error) {
    showPanel(error instanceof Error ? error.message : String(error), anchor);
  }
}

async function translateText(text: string): Promise<string> {
  const protectedText = protectTranslationTokens(normalizeSelectionText(text));
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

/**
 * 极速模式: 每批翻译建一个长连 Port,后台 stream:true 拉取并逐 token 推回。
 * onDelta 收到的是该段"到目前为止"的完整文本;建流/中途失败由调用方回落。
 */
const activeStreamPorts = new Set<chrome.runtime.Port>();
/** 主动取消在途流式请求的结算回调(restorePage 调用)。 */
const activeStreamCancellers = new Set<() => void>();
const streamPingIntervalMs = 20_000;
const streamFirstDeltaTimeoutMs = 60_000;

function streamTranslateTexts(
  texts: string[],
  onDelta: (index: number, partialText: string) => void
): Promise<string[]> {
  if (texts.length === 0) {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: streamPortName });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("无法建立流式连接"));
      return;
    }

    const results = new Array<string>(texts.length).fill("");
    const settled = new Array<boolean>(texts.length).fill(false);
    let firstError: Error | null = null;
    let finished = false;
    let gotAnyDelta = false;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      window.clearInterval(pingTimer);
      window.clearTimeout(watchdogTimer);
      activeStreamPorts.delete(port);
      activeStreamCancellers.delete(cancel);
      port.onMessage.removeListener(listener);
      try {
        port.disconnect();
      } catch {
        // 对端已关。
      }
      if (firstError) {
        reject(firstError);
      } else {
        resolve(results);
      }
    };

    /** 用户关闭翻译时由 restorePage 调用:结算 Promise、清理计时器。 */
    const cancel = () => {
      if (finished) {
        return;
      }
      if (!firstError) {
        firstError = new Error("页面翻译已关闭,流式请求已取消。");
      }
      settled.fill(true);
      finish();
    };
    activeStreamCancellers.add(cancel);

    const maybeFinish = () => {
      if (settled.every(Boolean)) {
        finish();
      }
    };

    // MV3: 只有端口上来消息才给 service worker 续命;首 token 前定时 ping。
    const pingTimer = window.setInterval(() => {
      try {
        port.postMessage({ type: "stream-ping" });
      } catch {
        // 端口已坏,onDisconnect 会收尾。
      }
    }, streamPingIntervalMs);

    // 首 delta 看门狗:超时视为流式不可用,让调用方回落整段请求,
    // 不等 service worker 被 30s idle 杀掉才反应。
    const watchdogTimer = window.setTimeout(() => {
      if (finished || gotAnyDelta) {
        return;
      }
      firstError = new Error("流式首响应超时,已回落整段请求。");
      settled.fill(true);
      finish();
    }, streamFirstDeltaTimeoutMs);

    const listener = (message: StreamPortMessage) => {
      if (message.type === "stream-delta") {
        if (!settled[message.index]) {
          gotAnyDelta = true;
          results[message.index] += message.delta;
          onDelta(message.index, results[message.index] ?? "");
        }
        return;
      }
      if (message.type === "stream-done") {
        results[message.index] = message.text;
        settled[message.index] = true;
        onDelta(message.index, message.text);
        maybeFinish();
        return;
      }
      if (message.type === "stream-error") {
        settled[message.index] = true;
        if (!firstError) {
          firstError = new Error(message.error);
        }
        maybeFinish();
      }
    };

    activeStreamPorts.add(port);
    port.onMessage.addListener(listener);
    port.onDisconnect.addListener(() => {
      if (finished) {
        return;
      }
      if (!firstError) {
        firstError = new Error("流式连接中断");
      }
      settled.fill(true);
      finish();
    });

    try {
      port.postMessage({ type: "stream-translate", texts });
    } catch (error) {
      firstError = error instanceof Error ? error : new Error("流式请求发送失败");
      settled.fill(true);
      finish();
    }
  });
}

/** 流式期间把部分译文写进壳层;按块节流,避免每个 token 都动 DOM。 */
function renderStreamingText(block: TranslatedBlock, partial: string): void {
  const now = performance.now();
  if (block.streamRenderAt !== undefined && now - block.streamRenderAt < 50) {
    return;
  }
  block.streamRenderAt = now;
  block.wrapper.classList.add("local-translator-streaming");
  block.result.className = "local-translator-result local-translator-streaming";
  // 掐掉尾巴上只到了一半的 @mention 保护符,避免豆腐块闪一下。
  const visible = partial.replace(/\uE000[A-Za-z0-9]*$/, "");
  block.result.textContent = visible;
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

function showPanel(text: string, anchor?: SelectionAnchor, note?: string): void {
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

  box.append(body);

  if (note) {
    const noteElement = document.createElement("div");
    noteElement.className = "local-translator-panel-note";
    noteElement.textContent = note;
    box.append(noteElement);
  }

  const footer = document.createElement("div");
  footer.className = "local-translator-panel-footer";
  footer.textContent = "Local LLM Translator";

  box.append(footer);
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
  if (/^[0-9.,+\s\-*:|/()%[\]{}]+$/.test(text)) {
    return false;
  }
  if (/^@[\w.-]+$/.test(text)) {    return false;
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

function isXHost(): boolean {
  const host = location.hostname.toLowerCase();
  return host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com");
}

function isXTweetTextElement(element: Element): boolean {
  return element.matches('[data-testid="tweetText"]');
}

function querySiteSpecificBlocks(): Element[] {
  if (isXHost()) {
    return queryXTweetBlocks();
  }

  const structuredBlocks = queryStructuredBlocks();
  if (structuredBlocks.length > 0) {
    return structuredBlocks;
  }

  const host = location.hostname.toLowerCase();
  if (!host.endsWith("youtube.com") && host !== "youtu.be") {
    return [];
  }

  const blocks: Element[] = [];

  document
    .querySelectorAll(
      "ytd-watch-metadata h1 yt-formatted-string, #title h1 yt-formatted-string, h1.ytd-watch-metadata-renderer yt-formatted-string"
    )
    .forEach((element) => {
      blocks.push(element);
    });

  blocks.push(...queryYoutubeDescriptionBlocks());
  blocks.push(...queryYoutubeCommentBlocks());
  return dedupeElements(blocks);
}

function queryXTweetBlocks(): Element[] {
  return dedupeElements(Array.from(document.querySelectorAll('[data-testid="tweetText"]')));
}

function queryStructuredBlocks(): Element[] {
  return dedupeElements(
    structuredBlockRules.flatMap((rule) => Array.from(document.querySelectorAll(rule.blockSelector)))
  );
}

function findStructuredBlockRule(element: Element): StructuredBlockRule | undefined {
  return structuredBlockRules.find((rule) => element.matches(rule.blockSelector));
}

function findStructuredBlockContent(element: Element, rule: StructuredBlockRule): Element | null {
  return element.matches(rule.contentSelector) ? element : element.querySelector(rule.contentSelector);
}

function findFirstNonEmptyTextNode(root: Node): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.nodeValue?.trim()) {
    node = walker.nextNode();
  }
  return node instanceof Text ? node : null;
}

function extractStructuredBlockText(element: Element, rule: StructuredBlockRule): string {
  const container = findStructuredBlockContent(element, rule);
  const titleNode = container ? findFirstNonEmptyTextNode(container) : null;
  return normalizeText(titleNode?.nodeValue ?? "");
}

let structuredBlockRelayoutTimer = 0;

function scheduleStructuredBlockRelayout(rule: StructuredBlockRule): void {
  if (!rule.relayoutSelector || !document.querySelector(rule.relayoutSelector)) {
    return;
  }
  if (structuredBlockRelayoutTimer) {
    window.clearTimeout(structuredBlockRelayoutTimer);
  }
  structuredBlockRelayoutTimer = window.setTimeout(() => {
    structuredBlockRelayoutTimer = 0;
    window.dispatchEvent(new Event("resize"));
  }, 300);
}

function scheduleStructuredBlockRelayouts(): void {
  structuredBlockRules.forEach(scheduleStructuredBlockRelayout);
}

function queryYoutubeDescriptionBlocks(): Element[] {
  const blocks: Element[] = [];
  const roots = document.querySelectorAll(
    "#description, ytd-expandable-video-description-body, #description-inline-expander, ytd-text-inline-expander"
  );
  const selectors = [
    "yt-formatted-string",
    "yt-attributed-string",
    "#snippet-text",
    "#content"
  ];
  for (const root of roots) {
    for (const selector of selectors) {
      root.querySelectorAll(selector).forEach((element) => {
        if (element.closest("ytd-video-description-transcript-section-renderer")) {
          return;
        }
        blocks.push(element);
      });
    }
  }
  return blocks;
}

const youtubeCommentTextSelector = [
  "yt-formatted-string#content-text",
  "yt-attributed-string#content-text",
  "#content-text.yt-core-attributed-string",
  "#content-text"
].join(",");

function queryYoutubeCommentBlocks(): Element[] {
  const blocks: Element[] = [];
  const hosts = document.querySelectorAll(
    "ytd-comment-thread-renderer, ytd-comment-renderer, ytd-comment-view-model, ytd-comments"
  );
  for (const commentHost of hosts) {
    queryWithinElementTree(commentHost, youtubeCommentTextSelector).forEach((element) => {
      if (element.closest("ytd-comment-thread-renderer, ytd-comment-renderer, ytd-comment-view-model")) {
        blocks.push(element);
      }
    });
  }
  return blocks;
}

function queryWithinElementTree(root: Element, selector: string): Element[] {
  const result: Element[] = [];
  const visit = (node: Element | ShadowRoot): void => {
    node.querySelectorAll(selector).forEach((element) => {
      result.push(element);
    });
    node.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) {
        visit(element.shadowRoot);
      }
    });
  };
  visit(root);
  return result;
}

function dedupeElements(elements: Element[]): Element[] {
  return [...new Set(elements)];
}

function isShortLabelElement(element?: Element): boolean {
  if (!element) {
    return false;
  }
  return element.matches("th, td, dt, dd, h1, h2, h3, h4, h5, h6");
}

/**
 * aside 里的 details/section/article 是折叠起来的正文(数据看板常见的
 * "Data & methodology"),不算侧栏 chrome,应当翻译。
 */
function isIgnoredElement(element: Element): boolean {
  const hit = element.closest(ignoredSelector);
  if (!hit) {
    return false;
  }
  if (hit instanceof HTMLElement && hit.tagName === "ASIDE") {
    const contentRoot = element.closest("details, section, article");
    if (contentRoot && hit.contains(contentRoot)) {
      return false;
    }
  }
  return true;
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

/** 选区翻译：保留换行；行内空白压成空格；连续空行压成单行。 */
function normalizeSelectionText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 块翻译取文：用 innerText 保留可视换行，避免多 span 推文被 textContent 粘成一行。 */
function extractBlockText(element: Element): string {
  const structuredRule = findStructuredBlockRule(element);
  if (structuredRule) {
    return extractStructuredBlockText(element, structuredRule);
  }
  const raw = element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
  if (isXTweetTextElement(element) || raw.includes("\n")) {
    return normalizeSelectionText(raw);
  }
  return normalizeText(raw);
}

function getCacheKey(settings: LocalTranslatorSettings, text: string): string {
  const scope = [
    location.origin,
    location.pathname,
    settings.backendKind,
    settings.baseUrl,
    settings.model,
    settings.targetLanguage,
    promptScopeKey(settings),
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
    // 目标是简体中文:只有当文本真的是简体中文时才跳过。
    // 日文(含假名)或繁体中文(含繁体特有字)都不是简体,需要翻译,
    // 否则 繁→简、日→中 永远不会发生(例如 javbus 这类繁中/日文站)。
    if (cjkRatio(text) <= 0.55) {
      return false;
    }
    return !containsJapaneseKana(text) && !containsTraditionalChinese(text);
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

const japaneseKanaPattern = /[\u3040-\u309f\u30a0-\u30ff]/;

function containsJapaneseKana(text: string): boolean {
  return japaneseKanaPattern.test(text);
}

// 高频繁体特有字:在简体中文里有完全不同的简体写法,几乎不会出现在真正简体文本里。
// 命中其一即判定为繁体,从而让 繁→简 翻译得以发生。
const traditionalChineseChars =
  "當顯聯導覽關訊營網電視節聽藝醫廠廣場個認識實測區號雜誌語經濟繼續紀離開間問題給寫對確廳雙陽陰線練過來還見觀討論設計記評試話詞費買賣資較輕輪轉輸辦辭進連遲達選邊鐵銀銷鋪閱際隨難靈響頁頭領頻類顧養館驗魚鳥點";

function containsTraditionalChinese(text: string): boolean {
  return [...traditionalChineseChars].some((char) => text.includes(char));
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
