// Shared theme-token helpers for non-CSS consumers (xterm, canvas-drawn surfaces, inline
// styles). main.ts's applyTheme() flips the full view/theme class set (view-north/
// view-graphite/view-stanza/variant-night/variant-dawn/theme-washi/theme-light) on
// documentElement as one transaction; no event fires. Consumers without an explicit
// call from applySettings self-subscribe via onThemeChange's MutationObserver on the
// class attribute instead — same pattern as editor.ts's private cssVar()/themeObserver,
// generalized for reuse (Phase 3/4/5). TerminalManager is the exception: it gets an
// explicit retheme() call from main.ts's applySettings, so it does not use onThemeChange.

/** Read a CSS custom property off :root; falls back when unresolved or outside a DOM (tests, SSR). */
export function cssVar(name: string, fallback = ""): string {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback || "";
}

/** Subscribe to ink/washi theme toggles; returns a disposer. No-ops outside a DOM. */
export function onThemeChange(cb: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return () => {};
  }
  const observer = new MutationObserver(() => cb());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * Fallback colors for terminal.ts's buildTermTheme(), used when an ansi/bg/fg token can't
 * be resolved (non-DOM test env, or a stray missing var). Keeps terminal.ts itself free of
 * inline hex literals — the fallback values live here instead.
 */
export const DEFAULT_TERM_COLORS = {
  background: "#181818",
  foreground: "#cccccc",
  cursor: "#cccccc",
  cursorAccent: "#181818",
  selectionBackground: "#264f78",
  black: "#3a3a34",
  red: "#e5484d",
  green: "#4ade93",
  yellow: "#e3b341",
  blue: "#4493f8",
  magenta: "#a78bfa",
  cyan: "#4ec9b0",
  white: "#d4d4d4",
  brightBlack: "#6b7280",
  brightRed: "#ff6b6b",
  brightGreen: "#6fe7ab",
  brightYellow: "#f0cc6c",
  brightBlue: "#6cb6ff",
  brightMagenta: "#c4a7fa",
  brightCyan: "#7ee2cc",
  brightWhite: "#ffffff",
} as const;
