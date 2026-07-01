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
