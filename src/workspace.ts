import {
  recentsList, recentsPush, trustList, trustAdd, trustMigrated, trustSetMigrated,
  type RecentBk,
} from "./ipc";

export interface WorkspaceTab {
  path: string | null;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

/**
 * Collapse `.`/`..`/empty segments purely — string-only, no fs resolution, so
 * non-existent paths (an MCP breakpoint in a file not yet created) are still
 * judged. On an absolute path a `..` at the root clamps at `/` (POSIX realpath
 * behavior); on a relative path unresolvable leading `..` segments are kept so
 * a containment prefix check can never accept them.
 */
function collapseDotSegments(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return absolute ? `/${out.join("/")}` : out.join("/");
}

export function pathBelongsToRoot(path: string, root: string): boolean {
  // Dot segments are collapsed BEFORE the prefix check: `<root>/../outside.py`
  // starts with `<root>/` as a raw string but lives outside the workspace —
  // without this, MCP debug_set_breakpoint could persist a breakpoint outside
  // the root (security: lexical containment must survive `.`/`..`).
  const normalizedPath = collapseDotSegments(normalizePath(path));
  const normalizedRoot = collapseDotSegments(normalizePath(root));
  if (normalizedRoot === "/") return normalizedPath.startsWith("/");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

/**
 * Resolve an externally supplied (MCP) workspace path: a relative path joins to
 * the root, `.`/`..` segments collapse purely (no fs calls), and anything that
 * escapes the root is refused. Returns the normalized absolute path, or null
 * when the path lands outside the workspace.
 */
export function resolveWorkspacePath(raw: string, root: string): string | null {
  // Malformed input is refused outright rather than partially handled.
  // Platform posture is macOS+Linux (no Windows path support) — a Windows
  // drive-letter or UNC form is not a valid workspace-relative or POSIX path
  // here, so a backslash or a `C:`-style prefix refuses rather than being
  // silently treated as relative and nested under the root.
  if (raw.trim().length === 0) return null;
  if (raw.includes("\\") || /^[A-Za-z]:/.test(raw)) return null;
  // A NUL is impossible in any POSIX filename; refusing here keeps an
  // unopenable path out of the store and its persisted form.
  if (raw.includes("\u0000")) return null;
  const joined = raw.startsWith("/") ? raw : `${normalizePath(root)}/${raw}`;
  const resolved = collapseDotSegments(normalizePath(joined));
  return pathBelongsToRoot(resolved, root) ? resolved : null;
}

/** Parent directory of a path, tolerant of both separators. */
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

/** How to open a path handed to Sutra by the OS/CLI. */
export type OpenPathAction =
  | { kind: "workspace"; dir: string } // folder → replace the workspace root
  | { kind: "fileInRoot"; file: string } // file inside current root → open as a tab
  | { kind: "fileWithParent"; parent: string; file: string }; // outside file → open parent as root + file

/** Decide how to open a path per the smart rule (pure; caller performs the effects). */
export function resolveOpenPath(path: string, isDir: boolean, currentRoot: string | null): OpenPathAction {
  if (isDir) return { kind: "workspace", dir: path };
  if (currentRoot && pathBelongsToRoot(path, currentRoot)) return { kind: "fileInRoot", file: path };
  return { kind: "fileWithParent", parent: parentDir(path), file: path };
}

export interface BreadcrumbSegment { label: string; dirPath: string | null; leaf: boolean; }

/** Split an absolute file path into clickable breadcrumb segments relative to root. */
export function breadcrumbSegments(root: string, filePath: string | null): BreadcrumbSegment[] {
  if (!filePath || !pathBelongsToRoot(filePath, root)) return [];
  const rel = filePath.slice(root.length).replace(/^\//, "");
  const parts = rel.split("/").filter(Boolean);
  return parts.map((label, i) => ({
    label,
    dirPath: i < parts.length - 1 ? `${root}/${parts.slice(0, i + 1).join("/")}` : null,
    leaf: i === parts.length - 1,
  }));
}

export function filterWorkspaceTabs<T extends WorkspaceTab>(tabs: readonly T[], root: string): T[] {
  return tabs.filter((tab) => tab.path != null && pathBelongsToRoot(tab.path, root));
}

// ---- per-workspace session restore ----
export interface WorkspaceSession {
  tabs: string[];
  activePath: string | null;
}

const SESSION_PREFIX = "sutra.session:";

export function workspaceSessionKey(root: string): string {
  return `${SESSION_PREFIX}${normalizePath(root)}`;
}

export function sessionFromTabs(
  tabs: readonly WorkspaceTab[],
  activePath: string | null,
  root: string,
): WorkspaceSession {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const tab of tabs) {
    if (!tab.path || !pathBelongsToRoot(tab.path, root)) continue;
    const normalized = normalizePath(tab.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  const normalizedActive =
    activePath && pathBelongsToRoot(activePath, root) ? normalizePath(activePath) : null;
  return {
    tabs: paths,
    activePath: normalizedActive && seen.has(normalizedActive) ? normalizedActive : null,
  };
}

export function serializeWorkspaceSession(session: WorkspaceSession): string {
  return JSON.stringify(session);
}

export function deserializeWorkspaceSession(raw: string | null): WorkspaceSession | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as { tabs?: unknown; activePath?: unknown };
    if (!Array.isArray(candidate.tabs)) return null;
    if (
      candidate.activePath !== null &&
      candidate.activePath !== undefined &&
      typeof candidate.activePath !== "string"
    ) {
      return null;
    }
    const tabs = candidate.tabs.filter((path): path is string => typeof path === "string");
    if (tabs.length !== candidate.tabs.length) return null;
    return {
      tabs,
      activePath: typeof candidate.activePath === "string" ? candidate.activePath : null,
    };
  } catch {
    return null;
  }
}

export function pruneWorkspaceSession(
  session: WorkspaceSession,
  exists: (path: string) => boolean,
): WorkspaceSession {
  const tabs = session.tabs.filter(exists);
  return {
    tabs,
    activePath: session.activePath && tabs.includes(session.activePath) ? session.activePath : null,
  };
}

export function loadWorkspaceSession(root: string): WorkspaceSession | null {
  try {
    return deserializeWorkspaceSession(localStorage.getItem(workspaceSessionKey(root)));
  } catch {
    return null;
  }
}

export function saveWorkspaceSession(root: string, session: WorkspaceSession): void {
  try {
    localStorage.setItem(workspaceSessionKey(root), serializeWorkspaceSession(session));
  } catch {
    /* storage unavailable / quota — session restore is best-effort */
  }
}

// ---- recent workspaces ----
export interface RecentWorkspace {
  path: string;
  name: string;
  openedAt: number;
}

/** Last path segment (folder name) of a normalized path; "/" for the root. */
export function basenameOf(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return normalized.split("/").pop() || normalized;
}

/**
 * Insert `path` at the front of the recents list: dedupe by normalized path,
 * stamp `openedAt`, and cap the list length. Pure — safe to unit test.
 */
export function upsertRecent(
  list: readonly RecentWorkspace[],
  path: string,
  now: number,
  cap = 8,
): RecentWorkspace[] {
  const normalized = normalizePath(path);
  const without = list.filter((r) => normalizePath(r.path) !== normalized);
  const entry: RecentWorkspace = { path: normalized, name: basenameOf(normalized), openedAt: now };
  return [entry, ...without].slice(0, cap);
}

// Legacy localStorage key — read once (seedRecentsFromLocalStorage) to port a
// pre-migration list into the shared backend store, then never written again.
const RECENTS_KEY = "sutra.recents";

export interface RecentsBackend {
  list: () => Promise<RecentBk[]>;
  push: (path: string, name: string) => Promise<void>;
}
const defaultRecentsBackend: RecentsBackend = { list: recentsList, push: recentsPush };

/** Load the shared recents list from the backend (every window sees the same list). */
export async function loadRecents(backend: RecentsBackend = defaultRecentsBackend): Promise<RecentWorkspace[]> {
  try {
    const list = await backend.list();
    return list.map((r) => ({ path: r.path, name: r.name, openedAt: r.opened_at }));
  } catch {
    return [];
  }
}

/** One-shot: port a pre-migration `sutra.recents` localStorage blob into the
 *  backend store. Guarded by the backend itself being empty — recents only
 *  grows via `recentsPush`, so an empty backend list reliably means "not yet
 *  migrated" (or a genuine first run, where there's nothing to port anyway).
 *  Safe to call on every boot. */
export async function seedRecentsFromLocalStorage(backend: RecentsBackend = defaultRecentsBackend): Promise<void> {
  let current: RecentWorkspace[];
  try {
    current = await loadRecents(backend);
  } catch {
    return;
  }
  if (current.length > 0) return;
  let legacy: RecentWorkspace[] = [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        legacy = parsed.filter(
          (r): r is RecentWorkspace =>
            !!r &&
            typeof r.path === "string" &&
            typeof r.name === "string" &&
            typeof r.openedAt === "number",
        );
      }
    }
  } catch {
    /* junk localStorage value — nothing to port */
  }
  // Oldest first: recentsPush prepends, so pushing oldest→newest reproduces the
  // original recency order in the backend list.
  for (const r of [...legacy].reverse()) {
    await backend.push(r.path, r.name).catch(() => {});
  }
}

// ---- workspace trust (gates execution of repo-defined commands) ----
// A folder is "trusted" only when the user opened it deliberately (in-app File▸Open)
// or clicked Trust. Folders arriving via OS file-association / CLI / single-instance
// forward start untrusted; their `.sutra/automations.json` commands are NOT auto-run
// until trusted. Pure reducers below are unit-tested; the backend-backed wrappers are
// not. Trust state is shared across every open Sutra window via the backend store.

/** True when `root` (normalized) is in the trusted set. Exact folder match — subtrees
 *  and prefix siblings are not trusted. */
export function pathIsTrusted(list: readonly string[], root: string): boolean {
  return list.includes(normalizePath(root));
}

/** Add `root` (normalized) to the trusted set; idempotent. Pure. */
export function addTrust(list: readonly string[], root: string): string[] {
  const normalized = normalizePath(root);
  return list.includes(normalized) ? [...list] : [...list, normalized];
}

/** One-shot migration seed: union existing trust with the (normalized) recents list,
 *  deduped, existing entries first. Callers run this once so pre-upgrade folders the
 *  user already opened deliberately are not re-gated. Pure. */
export function seedTrusted(existing: readonly string[], recentPaths: readonly string[]): string[] {
  const out = existing.map(normalizePath);
  const seen = new Set(out);
  for (const p of recentPaths) {
    const n = normalizePath(p);
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// Legacy localStorage key — read once (seedTrustedRootsFromLocalStorage) to
// port a pre-migration trusted-root list into the shared backend store.
const TRUST_KEY = "sutra.trustedRoots";

export interface TrustBackend {
  list: () => Promise<string[]>;
  add: (path: string) => Promise<void>;
  migrated: () => Promise<boolean>;
  setMigrated: () => Promise<void>;
}
const defaultTrustBackend: TrustBackend = {
  list: trustList, add: trustAdd, migrated: trustMigrated, setMigrated: trustSetMigrated,
};

/** Load the trusted-root list from the shared backend store. */
export async function loadTrusted(backend: TrustBackend = defaultTrustBackend): Promise<string[]> {
  try {
    return await backend.list();
  } catch {
    return [];
  }
}

/** One-shot: port a pre-migration `sutra.trustedRoots` localStorage blob into
 *  the backend store. Guarded the same way as recents — an empty backend list
 *  means "not yet migrated" (trust is never bulk-cleared once granted). Safe
 *  to call on every boot. */
export async function seedTrustedRootsFromLocalStorage(backend: TrustBackend = defaultTrustBackend): Promise<void> {
  let current: string[];
  try {
    current = await backend.list();
  } catch {
    return;
  }
  if (current.length > 0) return;
  let legacy: string[] = [];
  try {
    const raw = localStorage.getItem(TRUST_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) legacy = parsed.filter((p): p is string => typeof p === "string");
    }
  } catch {
    /* junk localStorage value — nothing to port */
  }
  for (const root of legacy) {
    await backend.add(root).catch(() => {});
  }
}

/** True when `root` is trusted to run its repo-defined commands. */
export async function isWorkspaceTrusted(root: string, backend: TrustBackend = defaultTrustBackend): Promise<boolean> {
  return pathIsTrusted(await loadTrusted(backend), root);
}

/** Mark `root` trusted and persist to the shared backend. Callers must only
 *  invoke this from the explicit File▸Open dialog or the Trust toast — never
 *  from a recents re-select or any other open path. */
export async function trustWorkspace(root: string, backend: TrustBackend = defaultTrustBackend): Promise<void> {
  await backend.add(normalizePath(root));
}

/** Once per install (shared by every window via the backend `trustMigrated`
 *  flag): port a pre-migration trusted-root list, then — as before — seed the
 *  trusted set from the current recents so folders the user already opened
 *  before the trust gate existed are not re-gated on upgrade. Guarded so a
 *  later untrust is not undone on next launch. */
export async function ensureTrustSeeded(
  recentPaths: readonly string[],
  backend: TrustBackend = defaultTrustBackend,
): Promise<void> {
  try {
    await seedTrustedRootsFromLocalStorage(backend);
    if (await backend.migrated()) return;
    for (const p of recentPaths) {
      await backend.add(normalizePath(p));
    }
    await backend.setMigrated();
  } catch {
    /* backend unavailable — seeding is best-effort; falls back to explicit trust */
  }
}

// ---- workspace selector menu model ----

export interface WorkspaceMenuItem { kind: "current" | "recent"; name: string; path: string; age: string; }

/** Compact relative age for menu rows: <1d → "today", then d/w/mo. */
export function formatAge(openedAt: number, now: number): string {
  const days = Math.floor((now - openedAt) / 86_400_000);
  if (days < 1) return "today";
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** Menu model: current root first, then recents excluding it. */
export function workspaceMenuModel(root: string, recents: readonly RecentWorkspace[], now: number): WorkspaceMenuItem[] {
  const items: WorkspaceMenuItem[] = [{ kind: "current", name: basenameOf(root), path: root, age: "" }];
  for (const r of recents) if (r.path !== root)
    items.push({ kind: "recent", name: r.name, path: r.path, age: formatAge(r.openedAt, now) });
  return items;
}
