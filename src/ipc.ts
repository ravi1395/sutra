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

export interface AgentChange extends ChangedFile {
  humanTouched: boolean;
  binary: boolean;
}

export interface AgentTrackingStatus {
  enabled: boolean;
  agentActive: boolean;
  changes: AgentChange[];
}

export interface AgentRevertResult {
  revertedPaths: string[];
  unsafePaths: string[];
  errors: string[];
}

export const agentTrackingPoll = (root: string) =>
  invoke<AgentTrackingStatus>("agent_tracking_poll", { root });
export const agentTrackingBegin = (root: string) =>
  invoke<AgentTrackingStatus>("agent_tracking_begin", { root });
export const agentTrackingAccept = (root: string) =>
  invoke<AgentTrackingStatus>("agent_tracking_accept", { root });
export const agentTrackingRevert = (root: string) =>
  invoke<AgentRevertResult>("agent_tracking_revert", { root });

export const previewServerUrl = (root: string, path: string) =>
  invoke<string>("preview_server_url", { root, path });

export const mcpServerUrl = () => invoke<string>("mcp_server_url");
export const mcpSetRoot = (root: string) => invoke<void>("mcp_set_root", { root });
export const mcpWriteAgentConfig = (root: string) =>
  invoke<string[]>("mcp_write_agent_config", { root });

export type PreviewOpenKind = "html" | "md" | "diagram";
export interface PreviewOpenPayload {
  kind: PreviewOpenKind;
  url?: string; // present for file-backed (html)
  source?: string; // present for inline (md, diagram)
}
export const onPreviewOpen = (
  cb: (p: PreviewOpenPayload) => void,
): Promise<UnlistenFn> =>
  listen<PreviewOpenPayload>("sutra://preview/open", (e) => cb(e.payload));

export interface DrivePayload {
  action: "openFile" | "revealTree" | "showDiff" | "openTerminal";
  path?: string;
  line?: number;
  cwd?: string;
}
/** Listen for MCP drive commands emitted by the Rust server. */
export const onDrive = (cb: (p: DrivePayload) => void): Promise<UnlistenFn> =>
  listen<DrivePayload>("sutra://drive", (e) => cb(e.payload));

export interface UiRequest {
  id: number;
  query: "openTabs" | "selection";
}
/** Listen for MCP UI-state read requests from Rust. */
export const onUiRequest = (cb: (r: UiRequest) => void): Promise<UnlistenFn> =>
  listen<UiRequest>("sutra://ui/request", (e) => cb(e.payload));
/** Reply to a pending MCP UI-state request. */
export const mcpUiReply = (id: number, payload: unknown) =>
  invoke<void>("mcp_ui_reply", { id, payload });

export const ptySpawn = (id: string, cwd: string | null, rows: number, cols: number) =>
  invoke<void>("pty_spawn", { id, cwd, rows, cols });
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, rows: number, cols: number) =>
  invoke<void>("pty_resize", { id, rows, cols });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });
// Strict busy check: true when a foreground child (claude, build, vim) holds the tty.
export const ptyIsBusy = (id: string) => invoke<boolean>("pty_is_busy", { id });

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
