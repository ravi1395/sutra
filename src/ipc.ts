// Typed wrappers around Tauri commands + events. Single place that touches the
// Rust boundary so the rest of the app stays transport-agnostic.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { wrapForDelivery } from "./delivery";

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
export const agentBaseContent = (root: string, path: string) =>
  invoke<string | null>("agent_base_content", { root, path });

export const previewServerUrl = (root: string, path: string) =>
  invoke<string>("preview_server_url", { root, path });

export const proxyUrl = (target: string) =>
  invoke<string>("proxy_url", { target });

export const mcpServerUrl = () => invoke<string>("mcp_server_url");
export const mcpSetRoot = (root: string) => invoke<void>("mcp_set_root", { root });
export const mcpWriteAgentConfig = (root: string) =>
  invoke<string[]>("mcp_write_agent_config", { root });

export const watchStart = (root: string) => invoke<void>("watch_start", { root });
export const watchStop = () => invoke<void>("watch_stop");
export interface FsChangedPayload {
  paths: string[];
}
export const onFsChanged = (cb: (payload: FsChangedPayload) => void): Promise<UnlistenFn> =>
  listen<FsChangedPayload>("fs-changed", (e) => cb(e.payload));

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
  action: "openFile" | "revealTree" | "showDiff" | "openTerminal" | "navigateBrowser";
  path?: string;
  line?: number;
  cwd?: string;
  url?: string;
}
/** Listen for MCP drive commands emitted by the Rust server. */
export const onDrive = (cb: (p: DrivePayload) => void): Promise<UnlistenFn> =>
  listen<DrivePayload>("sutra://drive", (e) => cb(e.payload));

export interface PromptRequest {
  id: number;
  url: string; // preview-server URL of the injected interactive HTML
}
/** Listen for MCP interactive-prompt requests (prompt_user tool). */
export const onPromptRequest = (cb: (r: PromptRequest) => void): Promise<UnlistenFn> =>
  listen<PromptRequest>("sutra://preview/prompt", (e) => cb(e.payload));

export interface UiRequest {
  id: number;
  query: "openTabs" | "selection" | "annotations";
}
/** Listen for MCP UI-state read requests from Rust. */
export const onUiRequest = (cb: (r: UiRequest) => void): Promise<UnlistenFn> =>
  listen<UiRequest>("sutra://ui/request", (e) => cb(e.payload));
/** Reply to a pending MCP UI-state request. */
export const mcpUiReply = (id: number, payload: unknown) =>
  invoke<void>("mcp_ui_reply", { id, payload });

export const ptySpawn = (id: string, cwd: string | null, rows: number, cols: number, shell: string | null = null) =>
  invoke<void>("pty_spawn", { id, cwd, rows, cols, shell });
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
export const searchDir = (
  root: string,
  pattern: string,
  caseInsensitive: boolean,
  isRegex = false,
) => invoke<SearchResult>("search_dir", { root, pattern, caseInsensitive, isRegex });

// Clipboard wrappers over tauri-plugin-clipboard-manager.
export const clipboardRead = (): Promise<string> => readText();
export const clipboardWrite = (text: string): Promise<void> => writeText(text);

// --- Self-update (tauri-plugin-updater + plugin-process) ---
// Centralizes the updater/process plugin surface so updater.ts stays
// transport-agnostic. `Update` is treated as an opaque handle by callers.
export type { Update, DownloadEvent };
// Hit the release endpoint; resolves to an Update handle when a newer signed
// release exists, or null when already current.
export const checkForUpdate = (): Promise<Update | null> => check();
// Download + install a resolved update, streaming progress to `onEvent`.
export const installUpdate = (
  update: Update,
  onEvent: (e: DownloadEvent) => void,
): Promise<void> => update.downloadAndInstall(onEvent);
// Relaunch the app (used right after a successful install).
export const relaunchApp = (): Promise<void> => relaunch();

// --- Debugger (DAP) ---
// Transport selects how the Rust proxy reaches the adapter: spawn a process
// (stdio) or connect to a listening port (socket).
export type Transport =
  | { kind: "stdio"; command: string; args: string[] }
  | { kind: "socket"; host: string; port: number; command?: string; args?: string[] };

export const debugStart = (sessionId: string, transport: Transport, cwd: string | null) =>
  invoke<void>("debug_start", { sessionId, transport, cwd });
export const debugSend = (sessionId: string, message: string) =>
  invoke<void>("debug_send", { sessionId, message });
export const debugStop = (sessionId: string) => invoke<void>("debug_stop", { sessionId });
export const resolveDebugAdapter = (root: string, adapter: "codelldb") =>
  invoke<string | null>("resolve_debug_adapter", { root, adapter });

export interface DapEventPayload {
  session_id: string;
  message: string;
}
export const onDapEvent = (cb: (p: DapEventPayload) => void): Promise<UnlistenFn> =>
  listen<DapEventPayload>("debug-dap-event", (e) => cb(e.payload));

// --- Language-intelligence engine (in-house tree-sitter) ---
// FROZEN CONTRACT between the TS frontend and the Rust `lang` engine. Both halves
// build against these exact command names + shapes. All Rust return structs MUST
// derive `#[serde(rename_all = "camelCase")]` so they serialize to these fields.
// Positions are 0-based; `character` is a UTF-16 code-unit column (CM6 semantics).
export interface Pos { line: number; character: number }
export interface Range { start: Pos; end: Pos }

export interface CompletionItem {
  label: string;
  kind: string;          // "function" | "class" | "variable" | "keyword" | "member" | ...
  detail: string | null; // signature/preview shown beside the label
  source: string;        // "scope" | "symbol" | "keyword" | "member"
  score: number;         // fuzzy rank; higher = better (maps to CM6 boost)
}
export interface DocumentSymbol {
  name: string;
  kind: string;
  range: Range;          // full declaration span
  selectionRange: Range; // the name span (revealed on click)
  children: DocumentSymbol[];
}
export interface Symbol {
  name: string;
  kind: string;
  path: string;
  range: Range;
  selectionRange: Range;
  container: string | null; // enclosing symbol, e.g. "Foo.bar"
  detail: string | null;
}
export interface Location { path: string; range: Range }
export interface Hover { signature: string; doc: string | null; kind: string }
export interface IndexStats { indexedFiles: number; symbols: number }

// Document lifecycle — keep the engine's view of an open buffer in sync.
export const langDidOpen = (path: string, text: string, version: number) =>
  invoke<void>("lang_did_open", { path, text, version });
export const langDidChange = (path: string, text: string, version: number) =>
  invoke<void>("lang_did_change", { path, text, version });
export const langDidClose = (path: string) =>
  invoke<void>("lang_did_close", { path });

// Workspace symbol index lifecycle (reuses the existing fs-changed pipeline).
export const langIndexBuild = (root: string) =>
  invoke<IndexStats>("lang_index_build", { root });
export const langIndexInvalidate = (paths: string[]) =>
  invoke<void>("lang_index_invalidate", { paths });

// Features.
export const langCompletion = (path: string, pos: Pos, prefix: string) =>
  invoke<CompletionItem[]>("lang_completion", { path, pos, prefix });
export const langDocumentSymbols = (path: string) =>
  invoke<DocumentSymbol[]>("lang_document_symbols", { path });
export const langWorkspaceSymbols = (query: string, limit = 100) =>
  invoke<Symbol[]>("lang_workspace_symbols", { query, limit });
export const langGotoDefinition = (path: string, pos: Pos) =>
  invoke<Location[]>("lang_goto_definition", { path, pos });
export const langHover = (path: string, pos: Pos) =>
  invoke<Hover | null>("lang_hover", { path, pos });

// --- Prompt composer: agent assets, terminal targeting, delivery ---
export interface AgentAsset {
  name: string;
  kind: "skill" | "command" | "subagent";
  invocation: string;
}
export const scanAgentAssets = (root: string) =>
  invoke<AgentAsset[]>("scan_agent_assets", { root });

export interface AgentTerminal {
  id: string;
  kind: string;
  cwd: string | null;
  state: "idle" | "busy" | "awaiting-input";
}
export const ptyListAgents = () => invoke<AgentTerminal[]>("pty_list_agents");

/**
 * Write a composed prompt to a target terminal, gated on the agent being idle.
 * Re-validates the target at send time, refuses non-idle targets, and (when
 * submitting) sends the trailing CR only after a settle delay so it never lands
 * on partially-pasted input.
 */
export async function deliverToPty(args: {
  targetId: string;
  text: string;
  submit: boolean;
  settleMs?: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const settleMs = args.settleMs ?? 60; // from phase0-findings.md
  const agents = await ptyListAgents();
  const target = agents.find((a) => a.id === args.targetId);
  if (!target) return { ok: false, reason: "target terminal is gone" };
  if (target.state !== "idle") return { ok: false, reason: `agent ${target.state}` };

  if (args.submit) {
    // paste block first, settle, then CR (split into two writes)
    await ptyWrite(args.targetId, wrapForDelivery(args.text, false));
    await new Promise((r) => setTimeout(r, settleMs));
    await ptyWrite(args.targetId, "\r");
  } else {
    await ptyWrite(args.targetId, wrapForDelivery(args.text, false));
  }
  return { ok: true };
}
