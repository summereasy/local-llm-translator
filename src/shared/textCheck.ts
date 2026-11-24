/** 目标语言是中日韩文字时,译文里应该出现对应文字。 */
const cjkTargetLanguages = new Set(["简体中文", "繁體中文", "日本語", "한국어"]);

const cjkPattern = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

/** 太短的片段无法判断,不打扰用户。 */
const minCheckLength = 10;

/** 判定"高相似"的阈值:译文和原文几乎一样说明没翻。 */
const echoSimilarityThreshold = 0.85;

function squash(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

function bigrams(text: string): Set<string> {
  const result = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) {
    result.add(text.slice(index, index + 2));
  }
  return result;
}

function similarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 || b.size === 0) {
    return left === right ? 1 : 0;
  }
  let shared = 0;
  for (const piece of a) {
    if (b.has(piece)) {
      shared += 1;
    }
  }
  return shared / (a.size + b.size - shared);
}

/**
 * 粗判"这次其实没翻"。
 *
 * 典型失败模式是翻译专用模型把整段指令当成原文,原样吐回来(只改了几个字),
 * 或者是通用模型完全忽略了目标语言。两种情况都不该让用户以为模型坏了。
 */
export function looksUntranslated(
  source: string,
  translated: string,
  targetLanguage: string
): boolean {
  const sourceText = squash(source);
  const translatedText = squash(translated);
  if (sourceText.length < minCheckLength || !translatedText) {
    return false;
  }

  if (sourceText === translatedText) {
    return true;
  }

  if (similarity(sourceText, translatedText) >= echoSimilarityThreshold) {
    return true;
  }

  return cjkTargetLanguages.has(targetLanguage) && !cjkPattern.test(translated);
}

/**
 * "标签 + 数值"统计行:短、无句读、以数字(可带 %/K/M/B 单位)结尾。
 * 看板/电商常见("Input from cache98.1%"、"Output/turn 10.1K"),整块送翻
 * 只会把名字和数字糊成一坨,直接跳过。
 */
export function looksLikeStatLabel(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 48) {
    return false;
  }
  // 句末句号或任意叹问号说明是句子;小数点里的 "." 不算句读。
  if (/[!?。！？]/.test(trimmed) || /[.]$/.test(trimmed)) {
    return false;
  }
  return /[-+]?\d+([.,]\d+)?\s*[%kKmMbB]?$/.test(trimmed);
}
