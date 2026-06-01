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
