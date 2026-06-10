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
