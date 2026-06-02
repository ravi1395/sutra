export const GLOBAL_SHORTCUT_OPTIONS: AddEventListenerOptions = { capture: true };

type ShortcutKey = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey">;

export function isPreviewShortcut(e: ShortcutKey): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyV";
}
