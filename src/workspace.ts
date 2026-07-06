export interface WorkspaceTab {
  path: string | null;
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

export function pathBelongsToRoot(path: string, root: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (normalizedRoot === "/") return normalizedPath.startsWith("/");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
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

const RECENTS_KEY = "sutra.recents";

export function loadRecents(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentWorkspace =>
        !!r &&
        typeof r.path === "string" &&
        typeof r.name === "string" &&
        typeof r.openedAt === "number",
    );
  } catch {
    return [];
  }
}

export function saveRecents(list: readonly RecentWorkspace[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable / quota — recents are best-effort */
  }
}

// ---- workspace trust (gates execution of repo-defined commands) ----
// A folder is "trusted" only when the user opened it deliberately (in-app File▸Open)
// or clicked Trust. Folders arriving via OS file-association / CLI / single-instance
// forward start untrusted; their `.sutra/automations.json` commands are NOT auto-run
// until trusted. Pure reducers below are unit-tested; the localStorage wrappers are not.

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

const TRUST_KEY = "sutra.trustedRoots";
const TRUST_MIGRATED_KEY = "sutra.trustMigrated";

/** Load the trusted-root list from localStorage; junk yields []. */
export function loadTrusted(): string[] {
  try {
    const raw = localStorage.getItem(TRUST_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/** Persist the trusted-root list (best-effort). */
export function saveTrusted(list: readonly string[]): void {
  try {
    localStorage.setItem(TRUST_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable / quota — trust is best-effort but re-promptable */
  }
}

/** True when `root` is trusted to run its repo-defined commands. */
export function isWorkspaceTrusted(root: string): boolean {
  return pathIsTrusted(loadTrusted(), root);
}

/** Mark `root` trusted and persist. */
export function trustWorkspace(root: string): void {
  saveTrusted(addTrust(loadTrusted(), root));
}

/** Once per install: seed the trusted set from the current recents so folders the
 *  user already opened before the trust gate existed are not re-gated on upgrade.
 *  Guarded by a localStorage flag so a later untrust is not undone on next launch. */
export function ensureTrustSeeded(recentPaths: readonly string[]): void {
  try {
    if (localStorage.getItem(TRUST_MIGRATED_KEY) === "1") return;
    saveTrusted(seedTrusted(loadTrusted(), recentPaths));
    localStorage.setItem(TRUST_MIGRATED_KEY, "1");
  } catch {
    /* storage unavailable — seeding is best-effort; falls back to explicit trust */
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
