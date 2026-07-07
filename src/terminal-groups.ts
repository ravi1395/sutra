import { uiStateGet, uiStateSet } from "./ipc";

export type TerminalGroupSide = "left" | "right";

export interface TerminalGroups<T> {
  left: T[];
  right: T[];
}

export interface DrawerState {
  open: boolean;
  heightPx: number;
}

export const DRAWER_KEY = "sutra.drawer";

/** Clamp persisted drawer state; fall back to closed/280px on junk. */
export function clampDrawerState(value: unknown): DrawerState {
  const v = (value ?? {}) as Partial<DrawerState>;
  const h = typeof v.heightPx === "number" && v.heightPx >= 120 && v.heightPx <= 800 ? v.heightPx : 280;
  return { open: v.open === true, heightPx: h };
}

export function loadDrawerState(raw: string | null): DrawerState {
  try {
    return clampDrawerState(raw ? JSON.parse(raw) : null);
  } catch {
    return clampDrawerState(null);
  }
}

// ---- shared ui-state (terminal drawer + composer drawer height) ----
// Both dims used to live under separate localStorage keys (`sutra.drawer`,
// `composer-drawer-h`); they're now one backend-owned `ui-state.json` object
// so every window shares the same values. `readUiState`/`patchUiState` do a
// read-merge-write so main.ts (terminalDrawer) and composer.ts
// (composerDrawerH) never clobber each other's field.
export interface UiState {
  terminalDrawer: DrawerState;
  composerDrawerH: number;
}

const COMPOSER_DRAWER_H_DEFAULT = 220;
const COMPOSER_DRAWER_H_MIN = 120;

function clampComposerDrawerH(value: unknown): number {
  return typeof value === "number" && value >= COMPOSER_DRAWER_H_MIN ? value : COMPOSER_DRAWER_H_DEFAULT;
}

/** Clamp a persisted (or partial/legacy) ui-state blob into a full UiState. */
export function clampUiState(value: unknown): UiState {
  const v = (value ?? {}) as Partial<{ terminalDrawer: unknown; composerDrawerH: unknown }>;
  return {
    terminalDrawer: clampDrawerState(v.terminalDrawer),
    composerDrawerH: clampComposerDrawerH(v.composerDrawerH),
  };
}

export interface UiStateBackend {
  get: () => Promise<unknown>;
  set: (value: unknown) => Promise<void>;
}
const defaultUiStateBackend: UiStateBackend = { get: uiStateGet, set: uiStateSet };

/** Read the shared ui-state from the backend. `legacy`, when given, is
 *  consulted ONLY the first time the backend is still empty (pre-migration):
 *  it seeds the backend once from the caller's pre-migration localStorage
 *  values so drawer-size preferences survive the move to backend-owned
 *  state. Safe to call on every boot/mount. */
export async function readUiState(
  legacy?: { drawerRaw: string | null; composerHRaw: string | null },
  backend: UiStateBackend = defaultUiStateBackend,
): Promise<UiState> {
  try {
    const stored = await backend.get();
    if (stored !== null && stored !== undefined) return clampUiState(stored);
  } catch {
    /* backend unavailable this call — fall through to legacy/defaults */
  }
  if (!legacy) return clampUiState(null);
  let legacyDrawer: unknown = null;
  try {
    legacyDrawer = legacy.drawerRaw ? JSON.parse(legacy.drawerRaw) : null;
  } catch {
    /* junk localStorage value — nothing to port */
  }
  const parsedH = legacy.composerHRaw ? parseInt(legacy.composerHRaw, 10) : NaN;
  const seeded = clampUiState({
    terminalDrawer: legacyDrawer,
    composerDrawerH: Number.isFinite(parsedH) ? parsedH : undefined,
  });
  await backend.set(seeded).catch(() => {});
  return seeded;
}

/** Merge `patch` into the current shared ui-state and persist (best-effort). */
export async function patchUiState(
  patch: Partial<UiState>,
  backend: UiStateBackend = defaultUiStateBackend,
): Promise<UiState> {
  const current = await readUiState(undefined, backend);
  const next = clampUiState({ ...current, ...patch });
  await backend.set(next).catch(() => {});
  return next;
}

export function groupSideForItem<T>(groups: TerminalGroups<T>, item: T): TerminalGroupSide | null {
  if (groups.left.includes(item)) return "left";
  if (groups.right.includes(item)) return "right";
  return null;
}

export function moveItemToGroup<T>(
  groups: TerminalGroups<T>,
  item: T,
  target: TerminalGroupSide,
): TerminalGroups<T> {
  const next: TerminalGroups<T> = {
    left: groups.left.filter((candidate) => candidate !== item),
    right: groups.right.filter((candidate) => candidate !== item),
  };
  next[target] = [...next[target], item];
  return next;
}

export function removeItemFromGroups<T>(groups: TerminalGroups<T>, item: T): TerminalGroups<T> {
  return {
    left: groups.left.filter((candidate) => candidate !== item),
    right: groups.right.filter((candidate) => candidate !== item),
  };
}

export function collapseAfterClose<T>(groups: TerminalGroups<T>): TerminalGroups<T> {
  if (groups.left.length === 0 && groups.right.length > 0) {
    return { left: groups.right, right: [] };
  }
  return groups;
}
