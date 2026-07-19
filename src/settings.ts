// Persisted user settings (editor, terminal, behavior) and pure clamp/update helpers.
import { settingsGet, settingsSet } from "./ipc";

export type ViewId = "classic" | "north" | "graphite" | "stanza";
export type ViewVariant = "ink" | "washi" | "day" | "night" | "dusk" | "dawn" | "dark";
export const VIEW_VARIANTS: Record<ViewId, ViewVariant[]> = {
  classic: ["ink", "washi"],
  north: ["day", "night"],
  graphite: ["dark"],
  stanza: ["dusk", "dawn"],
};

export interface UserSettings {
  editorFontSize: number;
  editorFontFamily: string;
  editorTabSize: number;
  editorWordWrap: boolean;
  formatOnSave: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  defaultShell: string;
  restoreSession: boolean;
  agentTracking: boolean;
  autosaveOnBlur: boolean;
  view: ViewId;
  theme: ViewVariant;
  diagnosticsEnabled: boolean;
  quietWindowMs: number; // harness v2 turn quiet-window; clamped 3000–60000
  annotationDockSide: "left" | "right";
  annotationRailCollapsed: boolean;
}

// Whitelists: every multi-choice setting validates against one of these.
// First two stacks match the app's shipped defaults (editor --mono / terminal).
export const FONT_FAMILIES: readonly string[] = [
  '"Spline Sans Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  '"SF Mono", Menlo, monospace',
  "Menlo, monospace",
  '"JetBrains Mono", Menlo, monospace',
  '"Fira Code", Menlo, monospace',
];
export const TAB_SIZES: readonly number[] = [2, 4, 8];
export const SCROLLBACK_OPTIONS: readonly number[] = [1000, 5000, 10000];
// "" = use $SHELL. Missing binaries fall back to $SHELL on the Rust side.
export const SHELLS: readonly string[] = ["", "/bin/zsh", "/bin/bash", "/opt/homebrew/bin/fish"];

export const DEFAULT_SETTINGS: UserSettings = {
  editorFontSize: 13,
  editorFontFamily: FONT_FAMILIES[0],
  editorTabSize: 4,
  editorWordWrap: false,
  formatOnSave: true,
  terminalFontSize: 12,
  terminalFontFamily: FONT_FAMILIES[1],
  terminalScrollback: 5000,
  defaultShell: "",
  restoreSession: true,
  agentTracking: true,
  autosaveOnBlur: false,
  view: "classic",
  theme: "ink",
  diagnosticsEnabled: true,
  quietWindowMs: 10000,
  annotationDockSide: "right",
  annotationRailCollapsed: false,
};

// Legacy localStorage key — read once (loadSettings) to port a pre-migration
// value into the shared backend store, then never written again.
const SETTINGS_KEY = "sutra.settings";
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const MIN_QUIET_MS = 3000;
const MAX_QUIET_MS = 60000;

function clampQuietWindow(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_QUIET_MS, Math.max(MIN_QUIET_MS, Math.round(value)));
}

function clampFontSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

// Returns value when it appears in the whitelist, else the default.
function pick<T>(list: readonly T[], value: unknown, fallback: T): T {
  return list.includes(value as T) ? (value as T) : fallback;
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickDockSide(value: unknown, fallback: "left" | "right"): "left" | "right" {
  return value === "left" ? "left" : value === "right" ? "right" : fallback;
}

export function clampSettings(value: Partial<UserSettings>): UserSettings {
  const d = DEFAULT_SETTINGS;
  const view = pick(Object.keys(VIEW_VARIANTS) as ViewId[], value.view, d.view);
  // Legacy settings stored only ink/washi. Preserve washi specifically; every
  // other missing-view value maps to classic/ink. Explicit views use only their
  // own variant set.
  const theme = value.view === undefined
    ? value.theme === "washi" ? "washi" : "ink"
    : pick(VIEW_VARIANTS[view], value.theme, VIEW_VARIANTS[view][0]);
  return {
    editorFontSize: clampFontSize(value.editorFontSize, d.editorFontSize),
    editorFontFamily: pick(FONT_FAMILIES, value.editorFontFamily, d.editorFontFamily),
    editorTabSize: pick(TAB_SIZES, value.editorTabSize, d.editorTabSize),
    editorWordWrap: pickBool(value.editorWordWrap, d.editorWordWrap),
    formatOnSave: pickBool(value.formatOnSave, d.formatOnSave),
    terminalFontSize: clampFontSize(value.terminalFontSize, d.terminalFontSize),
    terminalFontFamily: pick(FONT_FAMILIES, value.terminalFontFamily, d.terminalFontFamily),
    terminalScrollback: pick(SCROLLBACK_OPTIONS, value.terminalScrollback, d.terminalScrollback),
    defaultShell: pick(SHELLS, value.defaultShell, d.defaultShell),
    restoreSession: pickBool(value.restoreSession, d.restoreSession),
    agentTracking: pickBool(value.agentTracking, d.agentTracking),
    autosaveOnBlur: pickBool(value.autosaveOnBlur, d.autosaveOnBlur),
    view,
    theme,
    diagnosticsEnabled: pickBool(value.diagnosticsEnabled, d.diagnosticsEnabled),
    quietWindowMs: clampQuietWindow(value.quietWindowMs, d.quietWindowMs),
    annotationDockSide: pickDockSide(value.annotationDockSide, d.annotationDockSide),
    annotationRailCollapsed: pickBool(value.annotationRailCollapsed, d.annotationRailCollapsed),
  };
}

export function viewClasses(view: ViewId, theme: ViewVariant): string[] {
  if (view === "classic") return theme === "washi" ? ["theme-washi", "theme-light"] : [];
  if (view === "north") return theme === "day" ? ["view-north", "theme-light"] : ["view-north", "variant-night"];
  if (view === "graphite") return ["view-graphite"];
  return theme === "dawn" ? ["view-stanza", "variant-dawn", "theme-light"] : ["view-stanza"];
}

/** Merge a partial patch into current settings and re-clamp the result. Pure. */
export function updateSettings(current: UserSettings, patch: Partial<UserSettings>): UserSettings {
  return clampSettings({ ...current, ...patch });
}

export function serializeSettings(settings: UserSettings): string {
  return JSON.stringify(clampSettings(settings));
}

export function deserializeSettings(raw: string | null): UserSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return clampSettings(parsed as Partial<UserSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function nextFontSettings(settings: UserSettings, delta: number): UserSettings {
  return clampSettings({
    ...settings,
    editorFontSize: settings.editorFontSize + delta,
    terminalFontSize: settings.terminalFontSize + delta,
  });
}

export interface SettingsBackend {
  get: () => Promise<unknown>;
  set: (value: unknown) => Promise<void>;
}
const defaultSettingsBackend: SettingsBackend = { get: settingsGet, set: settingsSet };

/** Load settings from the shared backend store (every window sees the same
 *  values). One-shot: while the backend is still empty (pre-migration), seeds
 *  it from any pre-existing `sutra.settings` localStorage value, then never
 *  reads localStorage again. Safe to call on every boot. */
export async function loadSettings(backend: SettingsBackend = defaultSettingsBackend): Promise<UserSettings> {
  try {
    const stored = await backend.get();
    if (stored !== null && stored !== undefined) return clampSettings(stored as Partial<UserSettings>);
  } catch {
    /* backend unavailable this call — fall through to legacy/defaults */
  }
  let legacyRaw: string | null = null;
  try {
    legacyRaw = localStorage.getItem(SETTINGS_KEY);
  } catch {
    /* storage unavailable — nothing to port, fall back to defaults */
  }
  const legacy = deserializeSettings(legacyRaw);
  if (legacyRaw !== null) {
    await backend.set(legacy).catch(() => {});
  }
  return legacy;
}

// Per-root test auto-run toggle (harness v2), keyed "sutra.testAutoRun.<root>".
export function isTestAutoRunEnabled(root: string): boolean {
  try {
    return localStorage.getItem(`sutra.testAutoRun.${root}`) === "1";
  } catch {
    return false;
  }
}

export function setTestAutoRunEnabled(root: string, on: boolean): void {
  try {
    localStorage.setItem(`sutra.testAutoRun.${root}`, on ? "1" : "0");
  } catch {
    /* storage unavailable / quota - toggle remains off for this run */
  }
}

/** Persist settings to the shared backend store (best-effort). */
export function saveSettings(settings: UserSettings, backend: SettingsBackend = defaultSettingsBackend): Promise<void> {
  return backend.set(clampSettings(settings)).catch(() => {
    /* backend unavailable / quota - settings remain in memory for this run */
  });
}
