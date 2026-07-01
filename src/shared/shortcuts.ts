const shortcutKeyLabels: Record<string, string> = {
  Alt: "⌥",
  Option: "⌥",
  Ctrl: "⌃",
  Control: "⌃",
  Shift: "⇧",
  Meta: "⌘",
  Command: "⌘"
};

const defaultShortcuts: Record<string, string> = {
  "translate-selection": "⌥E",
  "toggle-page-translation": "⌥A"
};

export function formatCommandShortcut(command: string, shortcut?: string): string {
  if (!shortcut?.trim()) {
    return defaultShortcuts[command] ?? shortcut ?? "";
  }

  return shortcut
    .split("+")
    .map((part) => shortcutKeyLabels[part.trim()] ?? part.trim())
    .join("");
}
