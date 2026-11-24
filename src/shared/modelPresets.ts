import type { BackendKind, PromptTemplateMode } from "./settings";

/** 把设置页里的语言名映射成模型要求的语言代码。 */
export const targetLanguageCodes: Record<string, string> = {
  简体中文: "zh-hans",
  繁體中文: "zh-hant",
  English: "en",
  日本語: "ja",
  한국어: "ko",
  Français: "fr",
  Deutsch: "de",
  Español: "es"
};

/** 兜底模板:适合指令型对话模型(混元 MT、Qwen、Gemma 等)。 */
export const fallbackPromptTemplate =
  "请把下面的文本翻译成{{targetLanguage}}。保留原意、链接文本和术语，不要解释，不要添加额外内容。\n\n{{text}}";

/**
 * 裸文本模板:任务已经由模型自己的 chat template 编码,任何多余指令都会被
 * 当成待翻译原文(实测 PLaMo 3 Translate 会把指令原样翻回来)。
 */
const rawTextPromptTemplate = "{{text}}";

const defaultTemperature = 0.2;

export type PromptContext = {
  model: string;
  targetLanguage: string;
};

export type ModelPreset = {
  /** 稳定标识,仅用于调试与设置页展示。 */
  id: string;
  /** 与模型名(小写)做包含匹配,不带 g 标志。 */
  matches: RegExp;
  label: string;
  promptTemplate: string;
  /** 需要额外下发 chat_template_kwargs 的模型在这里返回参数。 */
  chatTemplateKwargs?: (context: PromptContext) => Record<string, unknown> | undefined;
  /** 依赖 OpenAI-compatible 扩展字段,Ollama native 接口无法表达。 */
  requiresOpenAICompatible?: boolean;
  /** 是否支持把多条文本打包成 JSON 指令批量翻译;纯翻译模型应设为 false。 */
  supportsBatchPrompt?: boolean;
  /** 可选覆盖默认 temperature(例如纯翻译模型推荐 0)。 */
  temperature?: number;
  note: string;
};

export const modelPresets: ModelPreset[] = [
  {
    id: "plamo-3-translate",
    matches: /plamo[-_ ]?3.*translate/,
    label: "PLaMo 3 Translate",
    promptTemplate: rawTextPromptTemplate,
    chatTemplateKwargs: ({ targetLanguage }) => {
      const code = targetLanguageCodes[targetLanguage];
      return code ? { target_lang: code } : undefined;
    },
    requiresOpenAICompatible: true,
    supportsBatchPrompt: false,
    temperature: 0,
    note: "只发裸文本,目标语言走 chat_template_kwargs.target_lang"
  },
  {
    id: "hunyuan-mt",
    matches: /hy-?mt|hunyuan-?mt/,
    label: "腾讯混元 MT",
    promptTemplate: fallbackPromptTemplate,
    note: "指令式对话模型,语言写在指令里"
  }
];

export function resolveModelPreset(model: string): ModelPreset | undefined {
  const name = model.trim().toLowerCase();
  if (!name) {
    return undefined;
  }
  return modelPresets.find((preset) => preset.matches.test(name));
}

export type PromptResolutionInput = PromptContext & {
  promptTemplate: string;
  promptTemplateMode: PromptTemplateMode;
};

export type PromptDescriptionInput = PromptResolutionInput & {
  backendKind?: BackendKind;
};

/** 决定这次请求实际使用的模板:自定义优先,其次内置表,最后兜底。 */
export function resolvePromptTemplate(input: PromptResolutionInput): string {
  if (input.promptTemplateMode === "custom" && input.promptTemplate.trim()) {
    return input.promptTemplate;
  }
  return resolveModelPreset(input.model)?.promptTemplate ?? fallbackPromptTemplate;
}

export function resolveChatTemplateKwargs(
  context: PromptContext
): Record<string, unknown> | undefined {
  const preset = resolveModelPreset(context.model);
  if (!preset?.chatTemplateKwargs) {
    return undefined;
  }
  const kwargs = preset.chatTemplateKwargs(context);
  return kwargs && Object.keys(kwargs).length > 0 ? kwargs : undefined;
}

export function presetSupportsBatchPrompt(model: string): boolean {
  return resolveModelPreset(model)?.supportsBatchPrompt !== false;
}

export function resolveTemperature(model: string): number {
  return resolveModelPreset(model)?.temperature ?? defaultTemperature;
}

export function backendCompatibilityError(
  model: string,
  backendKind: BackendKind
): string | undefined {
  const preset = resolveModelPreset(model);
  if (preset?.requiresOpenAICompatible && backendKind === "ollama") {
    return `${preset.label} 需要 chat_template_kwargs 传目标语言,Ollama 接口不支持。请把 API 类型切换为 OpenAI-compatible。`;
  }
  return undefined;
}

/** 设置页的只读说明:当前这个模型会怎么被喂 prompt。 */
export function describePromptResolution(input: PromptDescriptionInput): string {
  if (input.backendKind) {
    const error = backendCompatibilityError(input.model, input.backendKind);
    if (error) {
      return `注意: ${error}`;
    }
  }

  const preset = resolveModelPreset(input.model);
  const code = targetLanguageCodes[input.targetLanguage];
  const kwargs = resolveChatTemplateKwargs({
    model: input.model,
    targetLanguage: input.targetLanguage
  });

  if (input.promptTemplateMode === "custom" && input.promptTemplate.trim()) {
    if (kwargs && code) {
      return `正在使用自定义模板 (仍会附带目标语言参数 ${code})。`;
    }
    return "正在使用自定义模板。";
  }

  if (!preset) {
    return input.model.trim()
      ? "未匹配到内置模板,使用通用指令模板(翻译专用模型可能失效)。"
      : "填入模型名后会自动匹配内置模板。";
  }
  const languageHint = kwargs && code ? `,${code}` : "";
  return `已匹配 ${preset.label}:${preset.note}${languageHint}。`;
}

/** 缓存键的一部分:模板或语言变化后必须重新请求。 */
export function promptScopeKey(input: PromptResolutionInput): string {
  const template = resolvePromptTemplate(input);
  const kwargs = resolveChatTemplateKwargs({
    model: input.model,
    targetLanguage: input.targetLanguage
  });
  return [template, kwargs ? JSON.stringify(kwargs) : ""].join("\u001e");
}
