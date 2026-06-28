export const GLOBAL_SHORTCUT_OPTIONS: AddEventListenerOptions = { capture: true };

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

type ShortcutKey = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey">;

export function isPreviewShortcut(e: ShortcutKey): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyV";
}

// True if the platform modifier key is held (Cmd on Mac, Ctrl elsewhere).
export function isMod(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

// Format a shortcut string for display, platform-aware.
// fmtShortcut("S", { shift: true }) → "⇧⌘S" on Mac, "Ctrl+Shift+S" on Windows/Linux.
export function fmtShortcut(key: string, mods: { shift?: boolean; alt?: boolean } = {}): string {
  return IS_MAC
    ? `${mods.shift ? "⇧" : ""}${mods.alt ? "⌥" : ""}⌘${key}`
    : `Ctrl+${mods.shift ? "Shift+" : ""}${mods.alt ? "Alt+" : ""}${key}`;
}
