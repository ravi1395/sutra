// Persisted user settings (editor, terminal, behavior) and pure clamp/update helpers.
export interface UserSettings {
  editorFontSize: number;
  editorFontFamily: string;
  editorTabSize: number;
  editorWordWrap: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalScrollback: number;
  defaultShell: string;
  restoreSession: boolean;
  agentTracking: boolean;
  autosaveOnBlur: boolean;
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
  terminalFontSize: 12,
  terminalFontFamily: FONT_FAMILIES[1],
  terminalScrollback: 5000,
  defaultShell: "",
  restoreSession: true,
  agentTracking: true,
  autosaveOnBlur: false,
};

const SETTINGS_KEY = "sutra.settings";
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;

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

export function clampSettings(value: Partial<UserSettings>): UserSettings {
  const d = DEFAULT_SETTINGS;
  return {
    editorFontSize: clampFontSize(value.editorFontSize, d.editorFontSize),
    editorFontFamily: pick(FONT_FAMILIES, value.editorFontFamily, d.editorFontFamily),
    editorTabSize: pick(TAB_SIZES, value.editorTabSize, d.editorTabSize),
    editorWordWrap: pickBool(value.editorWordWrap, d.editorWordWrap),
    terminalFontSize: clampFontSize(value.terminalFontSize, d.terminalFontSize),
    terminalFontFamily: pick(FONT_FAMILIES, value.terminalFontFamily, d.terminalFontFamily),
    terminalScrollback: pick(SCROLLBACK_OPTIONS, value.terminalScrollback, d.terminalScrollback),
    defaultShell: pick(SHELLS, value.defaultShell, d.defaultShell),
    restoreSession: pickBool(value.restoreSession, d.restoreSession),
    agentTracking: pickBool(value.agentTracking, d.agentTracking),
    autosaveOnBlur: pickBool(value.autosaveOnBlur, d.autosaveOnBlur),
  };
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

export function loadSettings(): UserSettings {
  try {
    return deserializeSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, serializeSettings(settings));
  } catch {
    /* storage unavailable / quota - settings remain in memory for this run */
  }
}
