export type TranslateTextRequest = {
  type: "translate-text";
  text: string;
};

export type TranslateTextsRequest = {
  type: "translate-texts";
  texts: string[];
};

export type TogglePageTranslationRequest = {
  type: "toggle-page-translation";
};

export type TranslateSelectionRequest = {
  type: "translate-selection";
};

export type GetPageStateRequest = {
  type: "get-page-state";
};

export type GetCommandShortcutRequest = {
  type: "get-command-shortcut";
  command: string;
};

export type GetCommandShortcutResponse = {
  shortcut: string;
};

export type PageTranslationProgressMessage = {
  type: "page-translation-progress";
  active: boolean;
  pending: number;
  total: number;
};

export type PageTranslationState = {
  active: boolean;
  pending: number;
  total: number;
};

export type LocalTranslatorRequest =
  | TranslateTextRequest
  | TranslateTextsRequest
  | TogglePageTranslationRequest
  | TranslateSelectionRequest
  | GetPageStateRequest
  | GetCommandShortcutRequest;

/** 极速模式的流式通道: content script 每批翻译建一个 Port, 逐 token 推送 delta。 */
export const streamPortName = "local-translator-stream";

export type StreamTranslateRequest = {
  type: "stream-translate";
  texts: string[];
};

/** MV3 service worker 只有"端口上来消息"才续命;首 token 前由 content 侧定时发。 */
export type StreamPingRequest = {
  type: "stream-ping";
};

export type StreamDeltaEvent = {
  type: "stream-delta";
  index: number;
  delta: string;
};

export type StreamDoneEvent = {
  type: "stream-done";
  index: number;
  text: string;
};

export type StreamErrorEvent = {
  type: "stream-error";
  index: number;
  error: string;
};

export type StreamPortMessage =
  | StreamTranslateRequest
  | StreamPingRequest
  | StreamDeltaEvent
  | StreamDoneEvent
  | StreamErrorEvent;

export type TranslateTextResponse =
  | {
      ok: true;
      text: string;
    }
  | {
      ok: false;
      error: string;
    };

export type TranslateTextsResponse =
  | {
      ok: true;
      texts: string[];
    }
  | {
      ok: false;
      error: string;
    };
