// Git index helpers for regular repositories and linked worktrees.

/** Parse the `gitdir: ...` pointer stored in a linked-worktree `.git` file. */
export function parseGitDirLine(text: string): string | null {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^gitdir:\s*(.+)$/.exec(line);
  const gitDir = match?.[1]?.trim();
  return gitDir ? gitDir : null;
}

/** Resolve `<gitdir>/index`, treating relative gitdir pointers as root-relative. */
export function resolveGitIndexPathFromGitDir(root: string, gitDir: string): string {
  const base = gitDir.startsWith("/") ? gitDir : `${trimTrailingSlash(root)}/${gitDir}`;
  return `${normalizePath(base)}/index`;
}

/** Drop trailing slashes except for the filesystem root. */
function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Normalize a slash-delimited filesystem path without touching the disk. */
function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(segment);
      }
      continue;
    }
    parts.push(segment);
  }
  if (absolute) return `/${parts.join("/")}`.replace(/\/+$/, "") || "/";
  return parts.join("/") || ".";
}
