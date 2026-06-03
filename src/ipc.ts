// Typed wrappers around Tauri commands + events. Single place that touches the
// Rust boundary so the rest of the app stays transport-agnostic.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

export const listDir = (path: string) => invoke<Entry[]>("list_dir", { path });
export const readFile = (path: string) => invoke<string>("read_file", { path });
export const writeFile = (path: string, content: string) =>
  invoke<void>("write_file", { path, content });
export const fileMtime = (path: string) => invoke<number>("file_mtime", { path });
export const renamePath = (path: string, newName: string) =>
  invoke<void>("rename_path", { path, newName });
export const movePath = (from: string, to: string) =>
  invoke<void>("move_path", { from, to });
export const deletePath = (path: string) => invoke<void>("delete_path", { path });
export const createDir = (path: string) => invoke<void>("create_dir", { path });
export const gitHeadContent = (path: string) =>
  invoke<string | null>("git_head_content", { path });

export interface GitStatusEntry {
  path: string;
  status: "M" | "A" | "D";
}
export const gitStatus = (root: string) =>
  invoke<GitStatusEntry[]>("git_status", { root });

export const gitBranch = (root: string) =>
  invoke<string | null>("git_branch", { root });

export interface AheadBehindResult {
  ahead: number;
  behind: number;
  base: string;
}
export const gitAheadBehind = (root: string) =>
  invoke<AheadBehindResult | null>("git_ahead_behind", { root });

export interface ChangedFile {
  path: string;
  status: string;
}
export const gitChangedFiles = (root: string) =>
  invoke<ChangedFile[]>("git_changed_files", { root });

export interface WorktreeInfo {
  name: string;
  path: string;
  is_current: boolean;
}
export const gitWorktrees = (root: string) =>
  invoke<WorktreeInfo[]>("git_worktrees", { root });

export interface BranchInfo {
  name: string;
  is_current: boolean;
}
export const gitBranches = (root: string) =>
  invoke<BranchInfo[]>("git_branches", { root });
export const gitCheckout = (root: string, branch: string) =>
  invoke<void>("git_checkout", { root, branch });

export const previewServerUrl = (root: string, path: string) =>
  invoke<string>("preview_server_url", { root, path });

export const ptySpawn = (id: string, cwd: string | null, rows: number, cols: number) =>
  invoke<void>("pty_spawn", { id, cwd, rows, cols });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, rows: number, cols: number) =>
  invoke<void>("pty_resize", { id, rows, cols });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });

export interface PtyOutput {
  id: string;
  data: string; // base64
}
export const onPtyOutput = (cb: (p: PtyOutput) => void): Promise<UnlistenFn> =>
  listen<PtyOutput>("pty-output", (e) => cb(e.payload));
export const onPtyExit = (cb: (id: string) => void): Promise<UnlistenFn> =>
  listen<{ id: string }>("pty-exit", (e) => cb(e.payload.id));

export interface SearchMatch { path: string; line: number; text: string; }
export interface SearchResult { matches: SearchMatch[]; truncated: boolean; }
export const searchDir = (root: string, pattern: string, caseInsensitive: boolean) =>
  invoke<SearchResult>("search_dir", { root, pattern, caseInsensitive });

// Clipboard wrappers over tauri-plugin-clipboard-manager.
export const clipboardRead = (): Promise<string> => readText();
export const clipboardWrite = (text: string): Promise<void> => writeText(text);
