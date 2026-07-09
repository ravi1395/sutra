// App entry: instantiates the tree / editor / terminal / diff modules and wires
// the cross-cutting concerns — toolbar toggles, global shortcuts, save + save-as
// (native dialog), pane resizers, and integrated-agent workspace tracking.
import { open, save, ask, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { FileTree, OutlineView, deleteConfirmMessage, dropSelectedDescendants } from "./tree";
import {
  FILE_DRAG_TYPE,
  SPLIT_DROP_TARGET_OPTIONS,
  dragHasType,
  setSplitDropHint,
  splitSideFromClientX,
} from "./split-drop";
import { EditorManager, externalEditDetected, type Tab } from "./editor";
import { SearchPanel } from "./search";
import { TerminalManager } from "./terminal";
import { DiffViewer, computeLineDiff, hunkSummaries } from "./diff";
import { isFormattableExt } from "./format-ext";
import { BrowserPane } from "./browser";
import { resolveUiQuery } from "./annotation-core";
import { AnnotationsPanel } from "./annotations";
import { vResizer, hResizer, mountDebuggerSidebarSlot } from "./layout";
import { setBreakpointToggleHandler, setBreakpointMarks } from "./editor";
import { DebugSession } from "./debug-session";
import { detectAdapter, isTrusted, markTrusted, resolveLaunchConfig, breakpointStore } from "./debug";
import {
  agentTrackingPoll,
  agentBaseContent,
  agentRevertHunk,
  agentAcceptPath,
  listDir,
  readFile,
  writeFile,
  fileMtime,
  gitHeadContent,
  renamePath,
  deletePath,
  createDir,
  movePath,
  copyPath,
  gitChangedFiles,
  gitCheckout,
  spawnWindow,
  onPreviewOpen,
  onDrive,
  onOpenPath,
  takeLaunchPath,
  onUiRequest,
  onPromptRequest,
  mcpUiReply,
  mcpSetRoot,
  mcpWriteAgentConfig,
  onFsChanged,
  watchStart,
  watchStop,
  langIndexBuild,
  langIndexInvalidate,
  resolveDebugAdapter,
  turnPoll,
  turnList,
  turnTestRecord,
  turnRollback,
  turnDiskHashes,
  runnerRun,
  runnerCancel,
  onRunnerDone,
  recentsPush,
  listFiles,
  langWorkspaceSymbols,
  type AgentTrackingStatus,
  type Turn,
} from "./ipc";
import { baseSourceFor, firstViewableAgentChange, getTurns, hunkDiagBadgeEl, markRolledBack, mergeChangedFiles, onTurnClosed, replaceTurns, reviewablePaths, setTurnState, suppressibleCancelledIds, turnHeaderEl, whisperText } from "./agent-tracking";
import { openRollbackDialog, rollbackTargetId, setRollbackEditor } from "./rollback-dialog";
import { Facet, StateEffect } from "@codemirror/state";
import {
  diagChipEl,
  diagnosticsExtension,
  initDiagnostics,
  notifyDocChanged,
  pauseDiagnosticsFsTrigger,
  resumeDiagnosticsFsTrigger,
  runDiagnostics,
  setUntrustedDiagnosticsHandler,
  problemsPanelEl,
} from "./diagnostics";
import { aggregateStripEl, initSessions, pauseSessionsPolling, resumeSessionsPolling, sessionsPanelEl } from "./sessions";
import { mountWorkspaceBar, MENU_LABELS, type WorkspaceBarHandle } from "./menubar";
import { mountPalette, mountLocationPicker, type Command, type PaletteHandle } from "./palette";
import { createGitBar, type GitBarHandle } from "./gitbar";
import {
  mountAutomationBar,
  loadAutomations,
  saveAutomations,
  makeAutomation,
  upsertAutomation,
  removeAutomation,
  validateName,
  validateCommand,
  validateAutomation,
  prepareCreateAutomation,
  testAutomation,
  type Automation,
  type AutomationBarHandle,
} from "./automations";
import { icon } from "./icons";
import { mountUpdater } from "./updater";
import { parseGitDirLine, resolveGitIndexPathFromGitDir } from "./git-index";
import {
  breadcrumbSegments,
  ensureTrustSeeded,
  isWorkspaceTrusted,
  loadRecents,
  loadWorkspaceSession,
  pathBelongsToRoot,
  resolveOpenPath,
  pruneWorkspaceSession,
  saveWorkspaceSession,
  seedRecentsFromLocalStorage,
  sessionFromTabs,
  trustWorkspace,
  type RecentWorkspace,
} from "./workspace";
import {
  DEFAULT_SETTINGS,
  clampSettings,
  isTestAutoRunEnabled,
  loadSettings,
  nextFontSettings,
  saveSettings,
  type UserSettings,
} from "./settings";
import { GLOBAL_SHORTCUT_OPTIONS, isPreviewShortcut, isMod, fmtShortcut } from "./shortcuts";
import { LEGACY_DRAWER_H_KEY, mountComposer } from "./composer";
import { mountTasksPanel } from "./tasks-panel";
import { attachClosedTurnToRunningTask, loadTasks, saveTasks, setOwnedTurnReview, type Task } from "./tasks";
import { openSettingsModal, type ShortcutEntry } from "./settings-modal";
import { openAboutModal, shouldShowWhatsNew, WHATS_NEW_SEEN_KEY, type AboutTab } from "./about-modal";
import { DRAWER_KEY, clampDrawerState, patchUiState, readUiState, type DrawerState } from "./terminal-groups";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Native confirm via the dialog plugin — window.confirm is unreliable in WKWebView. */
function confirmNative(msg: string): Promise<boolean> {
  return ask(msg, { title: "Sutra", kind: "warning" });
}

/** Native alert via the dialog plugin — window.alert is unreliable in WKWebView. */
async function alertNative(msg: string): Promise<void> {
  await message(msg, { title: "Sutra", kind: "warning" });
}

const tree = new FileTree($("tree"));
const editor = new EditorManager($("panes"));
const terminals = new TerminalManager($("term-host"), $("terminal-area"), $("main"));

// Wire goto-definition multi-candidate picker: opens a location chooser overlay.
editor.onGotoDefinitionMulti = (locs) => {
  mountLocationPicker(locs, (path, line) => void editor.openFile(path, line));
};

// --- Debugger session ---
const debugSlot = mountDebuggerSidebarSlot($("main"));
const debugSession = new DebugSession({
  editor,
  slot: debugSlot,
  // Only adapters using runInTerminal (debugpy/node, post-v1) hit this; codelldb
  // launches directly. Returning the terminal id is a best-effort pid stand-in.
  runInTerminal: async (args) => {
    const a = args as { args?: string[] };
    const id = await terminals.runCommand((a.args ?? []).join(" ")).catch(() => null);
    return typeof id === "number" ? id : 0;
  },
});
// Gutter clicks toggle the persistent breakpoint store + push to the live session.
setBreakpointToggleHandler((path, line) => debugSession.toggleBreakpoint(path, line));

// Resolve the project's debug adapter and launch a session from the palette.
async function startDebugging(): Promise<void> {
  if (!currentRoot) return;
  const root = currentRoot;
  const entries = await listDir(root).catch(() => []);
  const signals = new Set(entries.map((e) => e.name));
  const codelldbPath = signals.has("Cargo.toml")
    ? await resolveDebugAdapter(root, "codelldb").catch(() => null)
    : null;
  const spec = detectAdapter(signals, codelldbPath);
  if (!spec) {
    const msg = signals.has("Cargo.toml") && !codelldbPath
      ? "codelldb not found — install the CodeLLDB VS Code extension"
      : "No debug adapter detected for this project.";
    await message(msg, { title: "Sutra", kind: "warning" });
    return;
  }
  if (!isTrusted(spec, root)) {
    const cmd = spec.transport.kind === "stdio" ? spec.transport.command : "";
    if (!window.confirm(`Run debug adapter from this workspace?\n${cmd}`)) return;
    markTrusted(root);
  }
  const launch = await resolveLaunchConfig(spec, root, editor.active?.path ?? "", {
    readText: readFile,
    exists: async (path) => {
      try {
        await fileMtime(path);
        return true;
      } catch {
        return false;
      }
    },
  });
  if (!launch.ok) {
    await message(launch.error, { title: "Sutra", kind: "warning" });
    return;
  }
  await debugSession.start(spec, root, launch.config);
}
const diffViewer = new DiffViewer();
const search = new SearchPanel(
  $<HTMLInputElement>("search-input"),
  $<HTMLButtonElement>("search-case"),
  $("search-results"),
);
search.onOpenMatch = (p, line) => { void editor.openFile(p, line); tree.setActive(p); };
const browserFrame = $<HTMLIFrameElement>("browser-frame");
const browser = new BrowserPane(
  $("browser-area"),
  browserFrame,
  $<HTMLInputElement>("browser-url"),
  $<HTMLButtonElement>("btn-back"),
  $<HTMLButtonElement>("btn-reload"),
  $<HTMLButtonElement>("btn-browser-maximize"),
);
const annotations = new AnnotationsPanel(
  browserFrame,
  $("annotation-list"),
  $<HTMLButtonElement>("btn-annotate"),
);
browser.onProxied = (origin) => annotations.setTarget(browserFrame, origin);
editor.onHtmlPreview = (url) => {
  setBrowser(true);
  browser.show();
  browser.loadDirect(url);
};

// Wire terminal link clicks → embedded browser.
terminals.onLinkActivate = (url: string) => {
  setBrowser(true);
  browser.show();
  void browser.open(url);
};

// Subscribe to MCP preview-open events emitted by the Rust MCP server tools.
// HTML → browser pane (focused); md/diagram → editor preview split.
void onPreviewOpen((p) => {
  if (p.kind === "html" && p.url) {
    setBrowser(true);
    browser.show();
    browser.loadDirect(p.url);
    return;
  }
  void editor.showAgentPreview(p).catch((e) =>
    console.error("agent preview failed", e),
  );
});

// Subscribe to MCP drive events emitted by the Rust MCP server tools.
void onDrive((d) => {
  switch (d.action) {
    case "openFile":
      if (d.path) void editor.openFile(d.path, d.line);
      break;
    case "revealTree":
      if (d.path) void tree.reveal(d.path);
      break;
    case "showDiff":
      if (d.path) {
        const path = d.path;
        void editor.openFile(path).then(() => {
          const line = editor.firstHunkLine(path);
          if (line != null) editor.revealLine(line);
        });
      }
      break;
    case "openTerminal":
      void terminals.create(undefined, d.cwd);
      break;
    case "navigateBrowser":
      if (d.url) {
        setBrowser(true);
        browser.show();
        void browser.open(d.url).catch((e) => console.error("agent navigate failed", e));
      }
      break;
  }
});

// Open a path handed to Sutra by the OS/CLI while it's already running
// (single-instance forward, macOS "Open With"). Cold-start paths are handled at
// boot by bootOpen via takeLaunchPath.
void onOpenPath((p) => void routeOpenPath(p.path, p.isDir));

// Apply the smart open rule (decision in workspace.resolveOpenPath): a folder
// replaces the workspace root; a file inside the current workspace opens as a tab;
// a file outside opens its parent folder as the workspace, then the file.
async function routeOpenPath(path: string, isDir: boolean): Promise<void> {
  const action = resolveOpenPath(path, isDir, currentRoot);
  switch (action.kind) {
    case "workspace":
      await openWorkspace(action.dir);
      break;
    case "fileInRoot":
      await editor.openFile(action.file);
      break;
    case "fileWithParent":
      await openWorkspace(action.parent);
      await editor.openFile(action.file);
      break;
  }
}

// Track the origin of the currently active prompt URL so the bridge listener
// can reject messages from any other source.
let promptOrigin: string | null = null;

// Show an MCP interactive prompt in the preview pane; the iframe posts the
// user's submission back via window.postMessage (see the bridge listener below).
void onPromptRequest((r) => {
  promptOrigin = new URL(r.url).origin;
  void editor
    .showAgentPreview({ kind: "html", url: r.url })
    .catch((e) => console.error("agent prompt failed", e));
});

// Bridge: rendered prompt iframes postMessage their result tagged with the
// pending request id; forward to the MCP reply command to resolve prompt_user.
// Guard on origin to prevent spoofed replies from other frames.
window.addEventListener("message", (e) => {
  if (e.origin !== promptOrigin) return;
  const d = e.data as { __sutraPrompt?: boolean; id?: number; data?: unknown };
  if (d && d.__sutraPrompt === true && typeof d.id === "number") {
    void mcpUiReply(d.id, d.data ?? {});
  }
});

// Subscribe to MCP UI-state requests and reply through the typed IPC command.
// Automation actions (create/list/run) are async and route to resolveAutomationUi;
// the read-only queries resolve synchronously via resolveUiQuery.
void onUiRequest((r) => {
  if (r.query === "createAutomation" || r.query === "listAutomations" || r.query === "runAutomation") {
    void resolveAutomationUi(r.query, r.params).then(
      (payload) => void mcpUiReply(r.id, payload),
      (e) => void mcpUiReply(r.id, { error: String(e) }),
    );
    return;
  }
  const result = resolveUiQuery(r.query, {
    openTabs: () => editor.getOpenTabs(),
    selection: () => editor.getSelection(),
    annotations: () => annotations.currentRouteAnnotations(),
  });
  void mcpUiReply(r.id, result.ok ? result.payload : { error: `unknown query: ${r.query}` });
});

// Handle MCP automation actions from an AI agent/skill: create/list/run automations
// against the current workspace, reusing the same validation + persistence + bar
// refresh path as the manual automation drawer. Returns a JSON-serializable result.
async function resolveAutomationUi(
  query: "createAutomation" | "listAutomations" | "runAutomation",
  params: unknown,
): Promise<unknown> {
  const root = currentRoot;
  if (!root) return { error: "No workspace open in Sutra" };
  const p = (params ?? {}) as { name?: string; command?: string; kind?: string; id?: string };

  if (query === "listAutomations") {
    return { automations };
  }

  // Create/run persist or execute a shell command; a prompt-injected agent must not
  // reach that in an untrusted folder. Listing (read-only) above stays allowed.
  if (!(await isWorkspaceTrusted(root))) {
    return { error: "This folder is not trusted. Trust it in Sutra before creating or running automations." };
  }

  if (query === "createAutomation") {
    const prepared = prepareCreateAutomation(automations, p);
    if ("error" in prepared) return { error: prepared.error };
    const a = prepared.automation;
    automations = upsertAutomation(automations, a);
    try {
      await saveAutomations(root, automations);
    } catch (e) {
      return { error: `Could not save automation: ${e}` };
    }
    automationBar.setAutomations(automations);
    return { ok: true, id: a.id, name: a.name };
  }

  // runAutomation: match by id first, else by case-insensitive name.
  const target = p.id
    ? automations.find((x) => x.id === p.id)
    : automations.find((x) => x.name.trim().toLowerCase() === (p.name ?? "").trim().toLowerCase());
  if (!target) return { error: `No automation matching ${p.id ?? p.name ?? "(none)"}` };
  void runAutomation(target);
  return { ok: true, started: true, id: target.id, name: target.name };
}

// Native workspace watcher refreshes the visible tree and git badges after
// filesystem changes from terminals, external tools, or Finder.
void onFsChanged((payload) => {
  if (!currentRoot) return;
  const root = currentRoot;
  if (payload.paths.length > 0 && !payload.paths.some((path) => pathBelongsToRoot(path, root))) {
    return;
  }
  if (bgPaused) {
    // Window hidden: defer tree refresh + lang re-index; catch up on re-show.
    fsChangedWhileHidden = true;
    for (const p of payload.paths) hiddenFsPaths.add(p);
    return;
  }
  // Inform the lang engine to re-index changed files (gracefully degrades if backend absent).
  if (payload.paths.length > 0) void langIndexInvalidate(payload.paths).catch(() => {});
  scheduleFileSystemRefresh(root);
});

const whisperBar = $("whisper-bar");
let workspaceBar: WorkspaceBarHandle; // assigned at boot once toggle handlers exist
let palette: PaletteHandle; // assigned at boot once all actions are defined
let gitBar: GitBarHandle; // assigned at boot
let automationBar: AutomationBarHandle; // assigned at boot
let outlineView: OutlineView; // Files/Outline toggle in the sidebar
let automations: Automation[] = []; // per-project automations for the current root
let currentRoot: string | null = null; // track opened workspace
let fsRefreshRunning = false;
let fsRefreshPendingRoot: string | null = null;
let agentStatus: AgentTrackingStatus = { enabled: false, agentActive: false, changes: [] };
let suppressSessionSave = false;
// Real value loaded async at boot (settings now live in the shared backend
// store); this placeholder is only visible for the instant before boot()'s
// `await loadSettings()` resolves.
let settings: UserSettings = DEFAULT_SETTINGS;
// Synchronous snapshot of the shared recents list for the command palette,
// whose builder callback must stay synchronous — refreshed at boot and after
// every recentsPush (loadRecents() itself is now backend-async).
let recentsCache: RecentWorkspace[] = [];

// ---- tabs (each pane renders its own strip; main wires cross-cutting hooks) ----
// Render the loom-bar breadcrumb for the active file; dir segments reveal in the tree.
function renderBreadcrumb(path: string | null): void {
  const host = $("breadcrumb");
  host.innerHTML = "";
  if (!currentRoot) return;
  for (const seg of breadcrumbSegments(currentRoot, path)) {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "/";
    host.appendChild(sep);
    const el = document.createElement("span");
    el.className = "seg" + (seg.leaf ? " leaf" : " dir");
    el.textContent = seg.label;
    if (seg.dirPath) {
      const dir = seg.dirPath;
      el.onclick = () => void tree.reveal(dir);
    }
    host.appendChild(el);
  }
}

editor.onActiveTabChanged = (tab) => {
  tree.setActive(tab?.path ?? null);
  renderBreadcrumb(tab?.path ?? null);
  renderWhisperBar();
  // Repaint stored breakpoints in the gutter when a file becomes active.
  if (tab?.path) {
    const bps = breakpointStore.get(tab.path) ?? [];
    editor.applyDebugEffects(
      setBreakpointMarks.of(bps.map((b) => ({ line: b.line, verified: b.verified ?? false }))),
      tab.path,
    );
  }
};
editor.onTabsChanged = () => {
  persistWorkspaceSession();
  renderWhisperBar();
};
editor.onSelectionChanged = () => renderWhisperBar();
editor.confirmCloseTab = (tab) =>
  tab.dirty ? confirmNative(`Discard unsaved changes to ${tab.name}?`) : true;

tree.onOpenFile = async (path) => {
  try {
    await editor.openFile(path);
    tree.setActive(path);
  } catch (e) {
    void alertNative(`Cannot open ${path}: ${e}`);
  }
};
tree.onOpenFileInPane = (path, side) => {
  void editor
    .openFileInSide(path, side)
    .then(() => tree.setActive(path))
    .catch((e) => void alertNative(`Cannot open ${path}: ${e}`));
};

// Tree context menu actions
tree.onRename = async (path: string, newName: string) => {
  try {
    await renamePath(path, newName);
    // Update open tabs with renamed path — keep dirty state, the bytes moved unchanged
    const parent = path.split("/").slice(0, -1).join("/");
    const newPath = parent ? parent + "/" + newName : newName;
    for (const tab of editor.tabs) {
      if (tab.path === path) {
        editor.retargetTab(tab, newPath, newName);
      }
    }
    await tree.refresh();
  } catch (e) {
    void alertNative(`Rename failed: ${e}`);
  }
};

tree.onDeleteMany = async (paths: string[]) => {
  if (!(await confirmNative(deleteConfirmMessage(paths)))) return;
  // Drop descendants whose ancestor is also selected — deleting the ancestor already removes
  // them, and attempting to delete an already-gone descendant would abort the loop partway.
  const toDelete = dropSelectedDescendants(paths);
  try {
    for (const path of toDelete) {
      await deletePath(path);
      // Close any open tabs for deleted path and its children
      const pathPrefix = path.endsWith("/") ? path : path + "/";
      for (const tab of editor.tabs.slice()) {
        if (tab.path && (tab.path === path || tab.path.startsWith(pathPrefix))) {
          editor.closeTab(tab);
        }
      }
    }
    await tree.refresh();
    tree.clearSelection();
  } catch (e) {
    void alertNative(`Delete failed: ${e}`);
  }
};

// Pure FS write — the tree owns the inline name input, validation, refresh,
// reveal, auto-open, and inline error display. Errors propagate so the tree
// can render them inline.
tree.onCreate = async (parentDir: string, name: string, isDir: boolean) => {
  const path = parentDir + "/" + name;
  if (isDir) await createDir(path);
  else await writeFile(path, "");
};

tree.onMoveMany = async (paths: string[], destDir: string) => {
  // A Shift-range selection commonly contains both an expanded directory and its own
  // children — moving the directory already relocates the children, so drop them here
  // (same rationale as the multi-delete loop above) to avoid a spurious per-item failure.
  for (const src of dropSelectedDescendants(paths)) {
    const srcParent = src.split("/").slice(0, -1).join("/");
    if (srcParent === destDir) continue; // dropped into its own parent — no-op
    const srcBaseName = src.split("/").pop() || src;
    const destPath = destDir + "/" + srcBaseName;
    try {
      await movePath(src, destPath);
      // Update open tabs with moved path — keep dirty state, the bytes moved unchanged
      const srcPrefix = src.endsWith("/") ? src : src + "/";
      for (const tab of editor.tabs.slice()) {
        if (tab.path === src) {
          editor.retargetTab(tab, destPath, srcBaseName);
        } else if (tab.path && tab.path.startsWith(srcPrefix)) {
          // Move children: /old/child -> /new/child
          const relPath = tab.path.slice(srcPrefix.length);
          const newPath = destPath + "/" + relPath;
          editor.retargetTab(tab, newPath, tab.name);
        }
      }
    } catch (e) {
      void alertNative(`Move failed for ${srcBaseName}: ${e}`);
    }
  }
  await tree.refresh();
  tree.clearSelection();
};

tree.onPaste = async (items, mode) => {
  for (const { src, destPath } of items) {
    try {
      if (mode === "copy") {
        await copyPath(src, destPath);
      } else {
        await movePath(src, destPath);
        const srcPrefix = src.endsWith("/") ? src : src + "/";
        const destBaseName = destPath.split("/").pop() || destPath;
        for (const tab of editor.tabs.slice()) {
          if (tab.path === src) {
            editor.retargetTab(tab, destPath, destBaseName);
          } else if (tab.path && tab.path.startsWith(srcPrefix)) {
            const relPath = tab.path.slice(srcPrefix.length);
            editor.retargetTab(tab, destPath + "/" + relPath, tab.name);
          }
        }
      }
    } catch (e) {
      void alertNative(`Paste failed for ${src.split("/").pop()}: ${e}`);
    }
  }
  await tree.refresh();
  tree.clearSelection();
};

// ---- save / save-as ----
function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

async function confirmWorkspaceClose(dir: string): Promise<boolean> {
  const dirtyTabs = editor.tabsOutsideWorkspace(dir).filter((tab) => tab.dirty);
  if (dirtyTabs.length === 0) return true;

  const names = dirtyTabs.slice(0, 5).map((tab) => tab.name).join(", ");
  const more = dirtyTabs.length > 5 ? `, +${dirtyTabs.length - 5} more` : "";
  return confirmNative(`Discard unsaved changes outside this folder? ${names}${more}`);
}

function persistWorkspaceSession(): void {
  if (!currentRoot || suppressSessionSave) return;
  saveWorkspaceSession(
    currentRoot,
    sessionFromTabs(editor.tabs, editor.active?.path ?? null, currentRoot),
  );
}

async function pathExists(path: string): Promise<boolean> {
  return fileMtime(path).then(
    () => true,
    () => false,
  );
}

async function restoreWorkspaceTabs(root: string): Promise<void> {
  const session = loadWorkspaceSession(root);
  if (!session) return;
  const existing = new Set<string>();
  for (const path of session.tabs) {
    if (await pathExists(path)) existing.add(path);
  }
  const pruned = pruneWorkspaceSession(session, (path) => existing.has(path));
  for (const path of pruned.tabs) {
    try {
      await editor.openFile(path);
    } catch {
      // Missing/unreadable files are skipped; restore is best-effort.
    }
  }
  if (pruned.activePath) {
    const active = editor.tabByPath(pruned.activePath);
    if (active) editor.activate(active);
  }
}

// Apply the active theme by toggling the washi class on the document root.
function applyTheme(theme: "ink" | "washi"): void {
  document.documentElement.classList.toggle("theme-washi", theme === "washi");
}

// Pushes every settings field to its consumer (CSS vars, editor, terminals, polls).
function applySettings(next: UserSettings): void {
  settings = clampSettings(next);
  applyTheme(settings.theme);
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty("--editor-font-size", `${settings.editorFontSize}px`);
  rootStyle.setProperty("--editor-font-family", settings.editorFontFamily);
  editor.setIndent(settings.editorTabSize);
  editor.setWordWrap(settings.editorWordWrap);
  terminals.setFontSize(settings.terminalFontSize);
  terminals.setFontFamily(settings.terminalFontFamily);
  terminals.setScrollback(settings.terminalScrollback);
  terminals.setShellPreference(settings.defaultShell || null);
  if (settings.agentTracking) {
    if (currentRoot) startAgentTrackingPoll();
  } else {
    stopAgentTrackingPoll();
  }
}

function persistSettings(next: UserSettings): void {
  applySettings(next);
  void saveSettings(settings);
}

async function saveTab(tab: Tab, forceDialog = false): Promise<void> {
  const prevPath = tab.path;
  let path = prevPath;
  if (!path || forceDialog) {
    const chosen = await save({ defaultPath: path ?? terminals.cwd ?? undefined });
    if (!chosen) return;
    path = chosen;
  }
  // Saving back to the loaded path: if the file changed on disk since load
  // (agent edit, git checkout), confirm before overwriting those changes.
  if (path === prevPath) {
    const diskMtime = await fileMtime(path).catch(() => null);
    if (externalEditDetected(tab.lastMtime, diskMtime)) {
      const overwrite = await confirmNative(
        `${basename(path)} changed on disk after it was loaded. Overwrite the disk version?`,
      );
      if (!overwrite) return;
    }
  }
  let content = editor.contentOf(tab);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (settings.formatOnSave && isFormattableExt(ext)) {
    const { formatContent } = await import("./format");
    const formatted = await formatContent(ext, content);
    if (formatted !== null) {
      editor.applyFormattedContent(tab, formatted);
      content = formatted;
    }
  }
  try {
    await writeFile(path, content);
  } catch (e) {
    void alertNative(`Save failed: ${e}`);
    return;
  }
  const mt = await fileMtime(path).catch(() => null);
  editor.markSaved(tab, path, basename(path), mt);
  renderWhisperBar();
  if (path !== prevPath) {
    // brand-new file or Save As → it now exists on disk; seed git baseline + tree
    tab.gitHead = await gitHeadContent(path).catch(() => null);
    tree.setActive(path);
  }
  void tree.refresh();
  if (currentRoot) void refreshGitState(currentRoot);
  editor.recomputeDiff();
}

editor.saveHandler = saveTab;

// ---- workspace open (single path shared by switcher rows, File menu, dialogs) ----
// `explicit` = the user picked a *fresh* folder via the File▸Open dialog → mark it
// trusted so its repo-defined commands may run. Only that dialog (and the Trust
// toast) grant trust. Everything else — OS file-association / CLI / single-instance
// forward, session restore, and switcher/worktree re-selects of a recents row —
// passes explicit=false and relies on persisted trust, so re-opening an
// OS-delivered folder never silently elevates it.
async function openWorkspace(dir: string, explicit = false): Promise<void> {
  if (!(await confirmWorkspaceClose(dir))) return;
  if (explicit) await trustWorkspace(dir);
  hideTrustToast(); // drop any leftover toast from the previous root
  persistWorkspaceSession();
  suppressSessionSave = true;
  try {
    editor.closeTabsOutsideWorkspace(dir);
    editor.setWorkspaceRoot(dir);
    currentRoot = dir;
    const turnsHydrated = hydrateTurnsForWorkspace(dir);
    void watchStop().catch(() => {});
    void mcpSetRoot(dir);
    void mcpWriteAgentConfig(dir).then((warnings) => {
      for (const w of warnings) console.warn("MCP config:", w);
    });
    agentStatus = { enabled: false, agentActive: false, changes: [] };
    editor.setAgentChanges([]);
    renderWhisperBar();
    tree.setActive(editor.active?.path ?? null);
    await tree.setRoot(dir);
    if (settings.restoreSession) await restoreWorkspaceTabs(dir);
    // Persisted task links need the complete turn manifest (not only the
    // consume-once turn_poll delta) before the panel renders files/test state.
    await turnsHydrated;
    if (currentRoot !== dir) return;
    await tasksPanel.reload();
  } finally {
    suppressSessionSave = false;
  }
  persistWorkspaceSession();
  search.setRoot(dir);
  workspaceBar.setCurrentWorkspace(dir);
  await terminals.reset(dir, drawerState.open);
  await recentsPush(dir, basename(dir));
  void loadRecents().then((r) => { recentsCache = r; });
  void refreshGitState(dir);
  automations = await loadAutomations(dir);
  automationBar.setAutomations(automations);
  stopGitPoll();
  const resolvedGitIndexPath = await resolveGitIndexPath(dir);
  if (currentRoot !== dir) return;
  gitIndexPath = resolvedGitIndexPath;
  void watchStart(dir).catch((e) => console.warn("watcher unavailable", e));
  // Kick off the workspace symbol index build (gracefully degrades if backend absent).
  void langIndexBuild(dir).catch(() => {});
  if (settings.agentTracking) startAgentTrackingPoll();
  void pollAgentChanges();
  startGitPoll();
}

/** Hydrate closed historical turns for task links after a restart. turn_poll
 * only delivers each close once, whereas turn_list is the durable manifest.
 * The root guard prevents an old IPC result populating a newly selected root. */
async function hydrateTurnsForWorkspace(root: string): Promise<void> {
  try {
    const turns = await turnList(root);
    if (currentRoot !== root) return;
    replaceTurns(root, turns);
  } catch {
    // A non-Git root or unavailable backend still opens normally; saved task
    // evidence remains visible without the live turn detail.
  }
}

async function openFolderDialog(): Promise<void> {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") await openWorkspace(dir, true); // explicit user pick → trusted
}

async function closeActiveTab(): Promise<void> {
  const a = editor.active;
  if (!a) return;
  if (!a.dirty || (await confirmNative(`Discard unsaved changes to ${a.name}?`))) {
    editor.closeTab(a);
  }
}

// ---- terminal toggle ----
const termArea = $("terminal-area");
const hres = $("hresizer");
const btnTerm = $("btn-term");
// Real value loaded async at boot (see boot() below); this placeholder
// (closed, default height) is only visible for the instant before then.
let drawerState: DrawerState = clampDrawerState(null);
const terminalSeam = document.createElement("button");
terminalSeam.id = "terminal-seam";
terminalSeam.type = "button";
terminalSeam.onclick = () => setTerminal(true);
termArea.prepend(terminalSeam);

function saveDrawerState(next: DrawerState): void {
  drawerState = clampDrawerState(next);
  void patchUiState({ terminalDrawer: drawerState }).catch(() => {});
}

function renderTerminalSeam(): void {
  terminalSeam.innerHTML = "";
  const chevron = document.createElement("span");
  chevron.className = "terminal-seam-chevron";
  chevron.textContent = drawerState.open ? "⌄" : "⌃";
  const label = document.createElement("span");
  label.className = "terminal-seam-label";
  label.textContent = `terminal · ${terminals.count} ${terminals.count === 1 ? "thread" : "threads"}`;
  const rule = document.createElement("span");
  rule.className = "terminal-seam-rule";
  const kbd = document.createElement("span");
  kbd.className = "kbd";
  kbd.textContent = "⌘J";
  terminalSeam.append(chevron, label, rule, kbd);
}

function setTerminal(on: boolean): void {
  saveDrawerState({ ...drawerState, open: on });
  termArea.classList.toggle("terminal-collapsed", !on);
  hres.classList.toggle("hidden", !on);
  btnTerm.classList.toggle("on", on);
  termArea.style.flex = on ? `0 1 ${drawerState.heightPx}px` : "0 0 30px";
  renderTerminalSeam();
  if (on) {
    if (terminals.count === 0) void terminals.create();
    // Refit, then focus so keystrokes reach the shell without a manual click.
    else requestAnimationFrame(() => { terminals.refit(); terminals.focusActive(); });
  }
}
btnTerm.onclick = () => setTerminal(!drawerState.open);
terminals.onTabsChanged = renderTerminalSeam;

// ---- turn strip (harness v2) ----
// Turn headers (Turn N · agent · N files · test chip) above the changed-file
// list; Rollback opens the per-file checklist dialog backed by turn snapshots,
// with live disk hashes powering human-touched detection.
function renderTurnStrip(root: string): void {
  const pane = document.getElementById("diff-pane");
  if (!pane) return;
  let strip = document.getElementById("turn-strip");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "turn-strip";
    pane.prepend(strip);
  }
  strip.textContent = "";
  const turns = getTurns(root);
  const onRollback = (turn: Turn) => {
    openRollbackDialog(root, turn, {
      turns,
      onApply: async (paths) => {
        // The rolled-back turn and any newer turn's code state is about to be
        // replaced — cancel their in-flight test runs BEFORE restoring so a
        // long-running suite can't finish against a tree that no longer
        // matches what it was testing and get recorded as that turn's result.
        await cancelTurnTestsFrom(root, turn.id);
        const res = await turnRollback(root, rollbackTargetId(turn), paths);
        // A turn has a rolled-back review disposition only when every file in
        // that turn was restored. A partial rollback leaves it unresolved for
        // later explicit review rather than claiming a false whole-turn result.
        if (turn.files.length > 0 && turn.files.every((file) => res.restored.includes(file.path))) {
          void queueTaskMetadataUpdate(root, (tasks) => setOwnedTurnReview(tasks, root, turn.id, "rolled_back"));
        }
        // turn_poll is consume-once and never re-delivers a closed turn, so
        // rolled_back (set server-side on the manifest) would otherwise never
        // reach turnsByRoot — re-fetch the full list so the strip reflects it
        // immediately instead of showing a stale live Rollback button.
        // Optimistically flag the rolled-back turn locally FIRST so the strip
        // disables its Rollback button even if the authoritative turnList
        // re-fetch below throws — otherwise an IPC failure would leave a live
        // button that re-applies into a false-success no-op. A successful
        // turnList overwrites this with the server truth.
        markRolledBack(root, turn.id);
        try {
          replaceTurns(root, await turnList(root));
        } catch (e) {
          console.warn("turnList refresh after rollback failed", e);
        }
        diffViewer.invalidate();
        void refreshDiffFileList();
        return res;
      },
      getDiskHashes: async (r, ps) =>
        Object.fromEntries(
          (await turnDiskHashes(r, ps)).filter(([, hash]) => hash != null),
        ) as Record<string, string>,
    });
  };
  // Synthetic pre-rollback turns (boundarySource "rollback") exist purely so a
  // rollback can itself be undone; they aren't a real agent turn and have no
  // useful strip entry of their own.
  for (const turn of turns) {
    if (turn.boundarySource === "rollback") continue;
    strip.appendChild(turnHeaderEl(turn, turns, onRollback));
  }
}

// ---- diff file list ----
async function refreshDiffFileList(): Promise<void> {
  if (!currentRoot) return;
  const root = currentRoot;
  renderTurnStrip(root);
  try {
    await editor.refreshCleanGitBaselines();
    if (currentRoot !== root) return;
    const gitFiles = await gitChangedFiles(root);
    if (currentRoot !== root) return;
    const files = mergeChangedFiles(gitFiles, agentStatus.changes);
    const activePath = editor.active?.path ?? null;
    const aiPaths = reviewablePaths(agentStatus.changes);
    diffViewer.renderFileList(files, activePath, {
      onFilePick: (path: string) => void viewChangedPath(path),
      reviewable: (path: string) => aiPaths.has(path),
      onExpand: async (path: string) => {
        const file = files.find((candidate) => candidate.path === path);
        if (!file || file.status === "D") return [];
        try {
          const source = baseSourceFor(agentStatus.changes.find((c) => c.path === path));
          // An empty agent base (agent-created file, no pre-agent content) falls
          // through to git HEAD so a file that exists in HEAD still shows a real
          // per-hunk diff instead of the whole file as one added hunk.
          const agentBase = source === "agent" ? await agentBaseContent(root, path).catch(() => null) : null;
          const base =
            (agentBase && agentBase.length > 0 ? agentBase : null) ??
            (await gitHeadContent(path).catch(() => "")) ??
            "";
          const current = await readFile(path);
          return hunkSummaries(computeLineDiff(base, current).hunks);
        } catch {
          return [];
        }
      },
      onHunkPick: (path: string, startLine: number) => {
        const file = files.find((candidate) => candidate.path === path);
        void editor.revealHunkPeek(path, startLine, file?.status ?? "M");
      },
      // Diagnostics count per hunk: Diagnostic.line is 1-based, HunkRow.newFrom
      // is 0-based with exclusive newTo, so the inclusive 1-based hunk range is
      // [newFrom+1, newTo]. Deleted hunks (newTo === newFrom) yield an empty
      // range and no badge.
      hunkBadge: (path, hunk) => hunkDiagBadgeEl(path, hunk.newFrom + 1, hunk.newTo),
      onAccept: (path: string) => {
        void agentAcceptPath(root, path).then((next) => {
          agentStatus = next;
          editor.setAgentChanges(next.changes);
          diffViewer.invalidate();
          void refreshDiffFileList();
          // Per-file acceptance becomes a task-level turn disposition only
          // after every file from that linked turn is no longer reviewable.
          const remainingPaths = new Set(next.changes.map((change) => change.path));
          for (const turn of getTurns(root)) {
            if (turn.files.some((file) => file.path === path)
              && turn.files.length > 0
              && turn.files.every((file) => !remainingPaths.has(file.path))) {
              void queueTaskMetadataUpdate(root, (tasks) => setOwnedTurnReview(tasks, root, turn.id, "accepted"));
            }
          }
        });
      },
      onReject: (path: string, hunk) => {
        void agentRevertHunk(root, path, hunk.newFrom, hunk.newTo, hunk.oldText).then((next) => {
          agentStatus = next;
          editor.setAgentChanges(next.changes);
          const tab = editor.tabByPath(path);
          if (tab && !tab.dirty) void editor.openLatestFile(path, "M");
          diffViewer.invalidate();
          void refreshDiffFileList();
        });
      },
    });
  } catch (e) {
    // Silently skip on error
  }
}

async function refreshFileSystemState(root: string): Promise<void> {
  if (currentRoot !== root) return;
  await tree.refresh();
  if (currentRoot !== root) return;
  await editor.refreshCleanGitBaselines();
  if (currentRoot !== root) return;
  void refreshGitState(root);
}

function scheduleFileSystemRefresh(root: string): void {
  fsRefreshPendingRoot = root;
  if (fsRefreshRunning) return;
  fsRefreshRunning = true;
  void (async () => {
    try {
      while (fsRefreshPendingRoot) {
        const nextRoot = fsRefreshPendingRoot;
        fsRefreshPendingRoot = null;
        try {
          await refreshFileSystemState(nextRoot);
        } catch (e) {
          console.warn("filesystem refresh failed", e);
        }
      }
    } finally {
      fsRefreshRunning = false;
      if (fsRefreshPendingRoot) scheduleFileSystemRefresh(fsRefreshPendingRoot);
    }
  })();
}

// ---- composer (prompt builder) ----
const composerPane = $("composer-pane");
const composerRes = $("composer-resizer");
const composerBody = $("composer-body");
const btnComposer = $("btn-composer");

// Recursive file walk for the composer's @file autocomplete (cached per root).
const COMPOSER_SKIP = new Set(["node_modules", ".git", "dist", ".cache", "build", "target", ".next"]);
let composerFileCache: string[] | null = null;
async function walkComposerFiles(dir: string, depth: number): Promise<string[]> {
  if (depth <= 0) return [];
  const entries = await listDir(dir).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDir) {
      if (!COMPOSER_SKIP.has(e.name)) out.push(...(await walkComposerFiles(e.path, depth - 1)));
    } else out.push(e.path);
  }
  return out;
}
async function getComposerFiles(root: string): Promise<string[]> {
  if (!composerFileCache) composerFileCache = await walkComposerFiles(root, 4);
  return composerFileCache;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", rs: "rust",
  py: "python", go: "go", java: "java", json: "json", md: "markdown",
  css: "css", html: "html", sh: "bash", toml: "toml", yml: "yaml", yaml: "yaml",
};
function composerSelection(): { path: string | null; text: string; line: number; endLine: number; lang: string } {
  const sel = editor.getSelection();
  const ext = sel.path?.split(".").pop()?.toLowerCase() ?? "";
  return { ...sel, endLine: sel.line, lang: LANG_BY_EXT[ext] ?? "" };
}

let composerPanel: ReturnType<typeof mountComposer> | null = null;
let composerMountedRoot: string | null = null;
function ensureComposer(): boolean {
  if (!currentRoot) return false;
  if (composerPanel && composerMountedRoot === currentRoot) return true;
  composerPanel?.dispose();
  composerFileCache = null;
  composerMountedRoot = currentRoot;
  composerPanel = mountComposer({
    root: currentRoot,
    trusted: false, // composer.ts re-checks localStorage trust
    container: composerBody,
    getFiles: () => getComposerFiles(currentRoot as string),
    getSelection: composerSelection,
  });
  return true;
}

function setComposer(on: boolean): void {
  if (on && !ensureComposer()) return; // no workspace open → nothing to compose against
  composerPane.classList.toggle("hidden", !on);
  composerRes.classList.toggle("hidden", !on);
  btnComposer.classList.toggle("on", on);
  if (on) composerPanel?.show();
  else composerPanel?.hide();
}
btnComposer.onclick = () => setComposer(composerPane.classList.contains("hidden"));
$("composer-close").onclick = () => setComposer(false);

// ---- tasks (control plane) ----
// Keep this panel dynamically mounted so T2 stays additive: it shares the
// editor column without taking ownership of the terminal or composer layout.
const tasksPane = document.createElement("div");
tasksPane.id = "tasks-panel-host";
tasksPane.className = "hidden";
tasksPane.style.cssText = "flex: 0 0 35%; min-width: 0; overflow: auto; padding: 10px; background: var(--bg-2); border-left: 1px solid var(--line);";
$("editor-area").appendChild(tasksPane);
const btnTasks = document.createElement("button");
btnTasks.id = "btn-tasks";
btnTasks.className = "glyph";
btnTasks.title = "Toggle tasks";
btnTasks.setAttribute("aria-label", "Toggle tasks");
btnTasks.textContent = "✓";
$("view-tools").appendChild(btnTasks);
const tasksPanel = mountTasksPanel({
  container: tasksPane,
  getRoot: () => currentRoot,
  getTurns: (root) => getTurns(root),
  getComposerDraft: () => {
    if (!ensureComposer()) return null;
    return composerPanel?.getTaskDraft() ?? null;
  },
  deliverPrompt: async (args) => {
    if (!ensureComposer()) return { ok: false, reason: "No workspace open" };
    return composerPanel?.deliverTaskPrompt(args) ?? { ok: false, reason: "Composer unavailable" };
  },
});
function setTasks(on: boolean): void {
  btnTasks.classList.toggle("on", on);
  if (on) tasksPanel.show(); else tasksPanel.hide();
}
btnTasks.onclick = () => setTasks(tasksPane.classList.contains("hidden"));

// ---- diff toggle ----
const diffPane = $("diff-pane");
const diffRes = $("diff-resizer");
const btnDiff = $("btn-diff");
function setDiff(on: boolean): void {
  diffPane.classList.toggle("hidden", !on);
  diffRes.classList.toggle("hidden", !on);
  btnDiff.classList.toggle("on", on);
  if (on) {
    editor.recomputeDiff();
    void refreshDiffFileList();
  }
}
btnDiff.onclick = () => setDiff(diffPane.classList.contains("hidden"));
$("diff-close").onclick = () => setDiff(false);

// ---- browser toggle ----
const browserArea = $("browser-area");
const browserRes = $("browser-resizer");
const btnBrowser = $("btn-browser");
const btnPalette = $("btn-palette");
const btnMenu = $("btn-menu");
function setBrowser(on: boolean): void {
  if (on) browser.show(); else browser.hide();
  browserRes.classList.toggle("hidden", !on);
  btnBrowser.classList.toggle("on", on);
}
btnBrowser.onclick = () => setBrowser(browserArea.classList.contains("hidden"));

// ---- open-editors switcher ----
// Toolbar button → .menu-card dropdown listing every open tab across panes;
// clicking a row activates that tab in its owning pane (mirrors gitbar pattern).
const btnOpenEditors = $("btn-open-editors");
let openEditorsMenu: HTMLElement | null = null;

function closeOpenEditorsMenu(): void {
  if (openEditorsMenu) {
    openEditorsMenu.remove();
    openEditorsMenu = null;
  }
  btnOpenEditors.classList.remove("on");
  document.removeEventListener("mousedown", onOpenEditorsOutside);
  document.removeEventListener("keydown", onOpenEditorsKey);
}

function onOpenEditorsOutside(e: MouseEvent): void {
  const t = e.target as Node;
  if (openEditorsMenu && !openEditorsMenu.contains(t) && !btnOpenEditors.contains(t)) {
    closeOpenEditorsMenu();
  }
}
function onOpenEditorsKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeOpenEditorsMenu();
}

function openOpenEditorsMenu(): void {
  closeOpenEditorsMenu();
  btnOpenEditors.classList.add("on");

  const dd = document.createElement("div");
  dd.className = "menu-card";

  const head = document.createElement("div");
  head.className = "menu-head";
  head.textContent = "open editors";
  dd.appendChild(head);

  const tabs = editor.tabs;
  if (tabs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "menu-row";
    empty.style.cursor = "default";
    empty.textContent = "No open editors";
    dd.appendChild(empty);
  } else {
    for (const tab of tabs) {
      const isActive = tab === editor.active;
      const row = document.createElement("div");
      row.className = "menu-row" + (isActive ? " current" : "");

      const name = document.createElement("span");
      name.textContent = tab.name + (tab.path ? "" : " *");
      row.appendChild(name);

      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.textContent = "●";
        dot.style.cssText = "font-size:9px;color:var(--em);";
        row.appendChild(dot);
      }

      if (tab.path) {
        const dir = tab.path.slice(0, tab.path.lastIndexOf("/"));
        if (dir) {
          const pathSpan = document.createElement("span");
          pathSpan.className = "menu-path";
          pathSpan.style.marginLeft = "auto";
          pathSpan.textContent = dir.replace(/^\/Users\/[^/]+/, "~");
          row.appendChild(pathSpan);
        }
      }

      row.onclick = () => {
        editor.activate(tab);
        closeOpenEditorsMenu();
      };
      dd.appendChild(row);
    }
  }

  document.body.appendChild(dd);
  // Right-align the card under the button (toolbar sits at the window's right edge).
  const rect = btnOpenEditors.getBoundingClientRect();
  dd.style.position = "fixed";
  dd.style.top = `${rect.bottom + 4}px`;
  dd.style.right = `${window.innerWidth - rect.right}px`;

  openEditorsMenu = dd;
  setTimeout(() => {
    document.addEventListener("mousedown", onOpenEditorsOutside);
    document.addEventListener("keydown", onOpenEditorsKey);
  }, 0);
}

btnOpenEditors.onclick = (e) => {
  e.stopPropagation();
  if (openEditorsMenu) closeOpenEditorsMenu();
  else openOpenEditorsMenu();
};

// ---- sidebar toggle ----
const sidebar = $("sidebar");
const vres = $("vresizer");
function setSidebar(on: boolean): void {
  sidebar.classList.toggle("hidden", !on);
  vres.classList.toggle("hidden", !on);
}

function togglePreview(): void {
  void editor
    .togglePreview()
    .catch((e) => void alertNative(`Preview failed: ${e instanceof Error ? e.message : e}`));
}

// ---- search view toggle ----
const treeEl = $("tree");
const searchView = $("search-view");
const btnSearchToggle = $("btn-search-toggle");
let searchViewOpen = false;
let searchIconHtml = "";

function openSearchView(): void {
  searchViewOpen = true;
  treeEl.classList.add("hidden");
  searchView.classList.remove("hidden");
  searchIconHtml = btnSearchToggle.innerHTML;
  btnSearchToggle.innerHTML = "←";
  btnSearchToggle.title = "Back to files";
  search.focus();
}

function closeSearchView(): void {
  searchViewOpen = false;
  searchView.classList.add("hidden");
  treeEl.classList.remove("hidden");
  if (searchIconHtml) btnSearchToggle.innerHTML = searchIconHtml;
  btnSearchToggle.title = "Search folder (⇧⌘F)";
}

function toggleSearchView(): void {
  if (searchViewOpen) closeSearchView(); else openSearchView();
}

// ---- background-poll idle gate ----
// macOS charges heavy energy to a backgrounded WebView that keeps polling and
// repainting. When the window is hidden (occluded/minimized) we disarm every
// cadence timer and pause CSS animations; on re-show we re-arm and run one
// catch-up tick. `*Wanted` = the poll should run (feature/workspace on);
// `bgPaused` = the window is currently hidden.
let bgPaused = false;
// Deferred fs-changed work while hidden: tree refresh + lang re-index accumulate
// and run once on re-show, instead of firing on every background FS event (e.g. a
// worktree agent editing files while the window is off-screen).
let fsChangedWhileHidden = false;
const hiddenFsPaths = new Set<string>();

// ---- integrated-agent workspace tracking ----
let pollTimer: number | undefined;
let agentPollWanted = false;

function armAgentPoll(): void {
  if (pollTimer === undefined && agentPollWanted && !bgPaused) {
    pollTimer = window.setInterval(pollAgentChanges, 1500);
  }
}

function startAgentTrackingPoll(): void {
  agentPollWanted = true;
  armAgentPoll();
}

// Halts agent-change polling and clears any whisper text it surfaced.
function stopAgentTrackingPoll(): void {
  agentPollWanted = false;
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  editor.setAgentChanges([]);
  agentStatus = { enabled: false, agentActive: false, changes: [] };
  renderWhisperBar();
}

// ---- git-index mtime watcher — refreshes tree badges after terminal git ops ----
let gitIndexMtime = 0;
let gitPollTimer: number | undefined;
let gitIndexPath: string | null = null;
let gitPollWanted = false;

function armGitPoll(): void {
  if (gitPollTimer === undefined && gitPollWanted && !bgPaused) {
    gitPollTimer = window.setInterval(() => void pollGitIndex(), 10000);
  }
}

function startGitPoll(): void {
  gitPollWanted = true;
  armGitPoll();
}

function stopGitPoll(): void {
  gitPollWanted = false;
  if (gitPollTimer !== undefined) {
    clearInterval(gitPollTimer);
    gitPollTimer = undefined;
    gitIndexMtime = 0;
    gitIndexPath = null;
  }
}

// Disarm every cadence timer + pause animations while hidden; re-arm and run a
// single catch-up tick on re-show. Preserves feature state (no teardown).
function setBackgroundPaused(hidden: boolean): void {
  if (hidden === bgPaused) return;
  bgPaused = hidden;
  document.body.classList.toggle("app-hidden", hidden);
  terminals.setBlinkPaused(hidden); // stop xterm's JS blink loop while off-screen
  if (hidden) {
    if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }
    if (gitPollTimer !== undefined) { clearInterval(gitPollTimer); gitPollTimer = undefined; }
    pauseSessionsPolling();
    composerPanel?.pausePolling();
    pauseDiagnosticsFsTrigger();
  } else {
    armAgentPoll();
    armGitPoll();
    resumeSessionsPolling();
    composerPanel?.resumePolling();
    resumeDiagnosticsFsTrigger();
    if (agentPollWanted) void pollAgentChanges();
    if (gitPollWanted) void pollGitIndex();
    if (fsChangedWhileHidden && currentRoot) {
      // One catch-up for FS churn accumulated while hidden.
      fsChangedWhileHidden = false;
      const paths = [...hiddenFsPaths];
      hiddenFsPaths.clear();
      if (paths.length) void langIndexInvalidate(paths).catch(() => {});
      scheduleFileSystemRefresh(currentRoot);
    }
  }
}

document.addEventListener("visibilitychange", () => setBackgroundPaused(document.hidden));

/** Resolve the real git index once per workspace, including linked worktrees. */
async function resolveGitIndexPath(root: string): Promise<string> {
  const defaultIndex = `${root}/.git/index`;
  try {
    const gitFile = await readFile(`${root}/.git`);
    const gitDir = parseGitDirLine(gitFile);
    if (gitDir) return resolveGitIndexPathFromGitDir(root, gitDir);
  } catch {
    // Regular repos have a .git directory, not a readable pointer file.
  }
  return defaultIndex;
}

async function pollGitIndex(): Promise<void> {
  if (!currentRoot) return;
  const indexPath = gitIndexPath ?? `${currentRoot}/.git/index`;
  try {
    const mtime = await fileMtime(indexPath);
    if (gitIndexMtime !== 0 && mtime !== gitIndexMtime) {
      void tree.refresh();
      void refreshGitState(currentRoot);
    }
    gitIndexMtime = mtime;
  } catch {
    // Not a git repo or .git/index absent — ignore.
  }
}

async function pollAgentChanges(): Promise<void> {
  if (!currentRoot) return;
  const root = currentRoot;
  try {
    const next = await agentTrackingPoll(currentRoot);
    if (currentRoot !== root) return;
    agentStatus = next;
    editor.setAgentChanges(next.changes);
    editor.setAgentActive(
      next.agentActive,
      next.changes.filter((c) => !c.humanTouched).map((c) => c.path),
    );
    renderWhisperBar();
    if (!diffPane.classList.contains("hidden")) void refreshDiffFileList();
    // Turn-boundary piggyback: same 1.5 s cadence, fires onTurnClosed subscribers.
    const res = await turnPoll(root);
    if (currentRoot !== root) return;
    setTurnState(root, res);
    // Strip re-render after state update (refreshDiffFileList above ran pre-poll).
    if (!diffPane.classList.contains("hidden")) renderTurnStrip(root);
  } catch {
    // Poll failures must not interrupt editing.
  }
}

// ---- harness v2 wiring (diagnostics, turns, sessions) ----
initDiagnostics(() => currentRoot);
initSessions(() => currentRoot);
setRollbackEditor(editor);

// ---- workspace-trust toast ----
// When diagnostics/automations are suppressed for an untrusted folder, offer a
// one-click Trust affordance. Suppression fires on every fs-settle, so the toast
// is idempotent per root and stays dismissed for the session once closed.
let trustToast: HTMLElement | null = null;
let trustToastRoot: string | null = null;
const trustDismissed = new Set<string>();

function hideTrustToast(): void {
  trustToast?.remove();
  trustToast = null;
  trustToastRoot = null;
}

function showTrustToast(root: string): void {
  if (trustDismissed.has(root)) return; // user closed it this session
  if (trustToast && trustToastRoot === root) return; // already shown for this root
  hideTrustToast();
  trustToastRoot = root;

  const el = document.createElement("div");
  el.className = "trust-toast";
  const msg = document.createElement("span");
  msg.className = "trust-toast-msg";
  msg.textContent = "Automations & diagnostics are disabled — this folder isn't trusted.";
  const trustBtn = document.createElement("button");
  trustBtn.className = "trust-toast-btn";
  trustBtn.textContent = "Trust folder";
  trustBtn.onclick = () => {
    void (async () => {
      await trustWorkspace(root); // must land before the trust re-check below
      hideTrustToast();
      void runDiagnostics(root); // run the now-permitted jobs immediately
    })();
  };
  const closeBtn = document.createElement("button");
  closeBtn.className = "trust-toast-close";
  closeBtn.title = "Dismiss";
  closeBtn.textContent = "✕";
  closeBtn.onclick = () => {
    trustDismissed.add(root);
    hideTrustToast();
  };
  el.append(msg, trustBtn, closeBtn);
  document.body.appendChild(el);
  trustToast = el;
}

setUntrustedDiagnosticsHandler(showTrustToast);

// Diagnostics squiggles are appended per-EditorState: fresh states created on
// tab open/switch lack the extension, so re-apply whenever tabs change. The
// marker facet detects states that already carry it.
const diagExtInstalled = Facet.define<boolean>();
function ensureDiagnosticsExtension(): void {
  for (const pane of editor.panes) {
    if (pane.view.state.facet(diagExtInstalled).length) continue;
    pane.view.dispatch({
      effects: StateEffect.appendConfig.of([
        diagExtInstalled.of(true),
        diagnosticsExtension(() => editor.active?.path ?? null),
      ]),
    });
  }
}
ensureDiagnosticsExtension();
{
  const prevActive = editor.onActiveTabChanged;
  editor.onActiveTabChanged = (tab) => {
    prevActive?.(tab);
    ensureDiagnosticsExtension();
  };
  const prevTabs = editor.onTabsChanged;
  editor.onTabsChanged = () => {
    prevTabs?.();
    ensureDiagnosticsExtension();
  };
}

// Serialize automatic task mutations per root. turn_poll can close several
// turns in one tick, and a stale concurrent read/write would otherwise lose a
// link. Corrupt task files remain read-only: automatic tracking must never
// "repair" externally malformed metadata by overwriting it.
const taskMetadataWrites = new Map<string, Promise<void>>();
function queueTaskMetadataUpdate(root: string, reduce: (tasks: readonly Task[]) => readonly Task[]): Promise<void> {
  const previous = taskMetadataWrites.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const loaded = await loadTasks(root);
    if (loaded.warnings.length) {
      console.warn("Task turn association skipped: tasks file has recoverable warnings", loaded.warnings);
      return;
    }
    const tasks = reduce(loaded.tasks);
    if (tasks === loaded.tasks) return;
    await saveTasks(root, tasks);
    if (currentRoot === root) await tasksPanel.reload();
  });
  taskMetadataWrites.set(root, next);
  void next.finally(() => {
    if (taskMetadataWrites.get(root) === next) taskMetadataWrites.delete(root);
  }).catch(() => {});
  return next;
}

// Auto-run the project's test automation when an agent turn closes.
onTurnClosed((root, turn) => {
  void (async () => {
    if (!isTestAutoRunEnabled(root)) return;
    if (!(await isWorkspaceTrusted(root))) return; // never auto-run a repo's test command for an untrusted folder
    const test = testAutomation(automations);
    if (!test) return;
    await turnTestRecord(root, turn.id, { state: "running", outputTail: "" })
      .then(() => runnerRun(`test:${root}:${turn.id}`, test.command, root, 600000))
      .catch(() => {});
  })();
});

// Root-level task attribution deliberately runs independently from terminal
// delivery and test automation. onTurnClosed carries no terminal identity, so
// a root's one running task is the sole authoritative association target.
onTurnClosed((root, turn) => {
  void queueTaskMetadataUpdate(root, (tasks) => attachClosedTurnToRunningTask(tasks, root, turn)).catch((error) => {
    console.warn("Task turn association failed", error);
  });
});

// Runner ids (test:<root>:<turnId>) cancelled by a rollback — consulted by
// onRunnerDone so the kill triggered below doesn't get misrecorded as that
// turn's pass/fail once the runner reports the (killed) job done.
const cancelledTestRunnerIds = new Set<string>();

// Cancel any in-flight turn-test run for `root` whose turn is >= `minTurnId`
// (the rolled-back turn and every newer one — a rollback is about to replace
// their code state). Only ids that runner_cancel ACTUALLY killed get added to
// the suppression set: adding an id unconditionally would poison a turn whose
// test hasn't started yet (e.g. a still-open newer turn, or when the backend
// then rejects the rollback) and silently drop that turn's future legitimate
// pass/fail once it runs for real.
async function cancelTurnTestsFrom(root: string, minTurnId: number): Promise<void> {
  const ids = getTurns(root)
    .filter((t) => t.id >= minTurnId)
    .map((t) => `test:${root}:${t.id}`);
  for (const id of await suppressibleCancelledIds(ids, runnerCancel)) {
    cancelledTestRunnerIds.add(id);
  }
}

// Record pass/fail when a `test:`-prefixed runner completes (id = test:<root>:<turnId>).
void onRunnerDone((p) => {
  if (!p.id.startsWith("test:")) return;
  // A rollback-driven cancel must not stamp a stale pass/fail for the turn
  // whose code state it just replaced.
  if (cancelledTestRunnerIds.delete(p.id)) return;
  const rest = p.id.slice("test:".length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return;
  const root = rest.slice(0, sep);
  const turnId = Number(rest.slice(sep + 1));
  if (!Number.isFinite(turnId)) return;
  void turnTestRecord(root, turnId, {
    state: p.exitCode === 0 ? "pass" : "fail",
    exitCode: p.exitCode,
    durationMs: p.durationMs,
    outputTail: (p.stdout + p.stderr).slice(-4000),
  }).catch(() => {});
});

// MCP/agent navigation: open file + reveal line.
window.addEventListener("sutra:goto", (e) => {
  const detail = (e as CustomEvent<{ path?: string; line?: number }>).detail;
  const path = detail?.path;
  if (!path) return;
  void editor
    .openFile(path, detail.line)
    .then(() => tree.setActive(path))
    .catch((err) => console.error(`[sutra:goto] failed to open ${path}`, err));
});

// Panel hosts (index.html) receive the module-owned singleton panel roots.
const problemsHost = $("problems-panel-host");
problemsHost.append(problemsPanelEl());
const sessionsHost = $("sessions-panel-host");
sessionsHost.append(sessionsPanelEl());
function setProblemsPanel(on: boolean): void {
  problemsHost.classList.toggle("hidden", !on);
}
function setSessionsPanel(on: boolean): void {
  sessionsHost.classList.toggle("hidden", !on);
}

async function viewChangedPath(path: string): Promise<void> {
  const change = agentStatus.changes.find((candidate) => candidate.path === path);
  setDiff(true);
  if (change?.status === "D") {
    diffViewer.renderStatus(basename(path), "File deleted by integrated agent. Git HEAD retains the review baseline.");
    return;
  }
  if (change?.binary) {
    diffViewer.renderStatus(basename(path), "Binary file changed by integrated agent. Text diff is unavailable.");
    return;
  }
  try {
    if (change && baseSourceFor(change) === "agent" && currentRoot) {
      const base = await agentBaseContent(currentRoot, path).catch(() => null);
      // Skip empty bases (agent-created files) so the editor gutter falls back to
      // git HEAD instead of rendering the whole file as one added hunk.
      if (base != null && base.length > 0) editor.setAgentBaseOverride(path, base);
    }
    await editor.openLatestFile(path, change?.status ?? "M");
    tree.setActive(path);
  } catch (e) {
    diffViewer.renderStatus(basename(path), `Cannot open changed file: ${e}`);
  }
}

let lastWhisperSig = "";
function renderWhisperBar(): void {
  const dirty = editor.tabs.some((tab) => tab.dirty);
  const activePath = editor.active?.path ?? null;
  const agentCopy = whisperText(agentStatus, activePath);
  const lnText = editor.active ? `ln ${editor.getSelection().line}` : "";
  // Called every 1.5 s by the agent poll — skip the DOM teardown/rebuild unless
  // something visible actually changed. diag chip + aggregate strip are singleton
  // nodes mutated in place elsewhere, so their live textContent is the source of truth.
  const sig = `${dirty}|${agentCopy}|${lnText}|${diagChipEl().textContent ?? ""}|${aggregateStripEl().textContent ?? ""}`;
  if (sig === lastWhisperSig) return;
  lastWhisperSig = sig;

  whisperBar.innerHTML = "";
  const left = document.createElement("div");
  left.className = "whisper-left";
  const saveState = document.createElement("span");
  saveState.className = "whisper-save" + (dirty ? " dirty" : "");
  saveState.textContent = dirty ? "unsaved changes" : "all changes saved";
  left.append(saveState);

  if (agentCopy) {
    const agent = document.createElement("button");
    agent.className = "whisper-agent";
    agent.textContent = agentCopy;
    agent.onclick = () => {
      const change = firstViewableAgentChange(agentStatus.changes);
      if (change) void viewChangedPath(change.path);
    };
    left.append(agent);
  }

  const right = document.createElement("div");
  right.className = "whisper-right";
  if (lnText) right.textContent = lnText;
  // Harness statusbar cluster: diagnostics chip + multi-session aggregate strip.
  whisperBar.append(left, diagChipEl(), aggregateStripEl(), right);
}

/** One-off error alert (e.g. branch checkout rejected on a dirty tree). */
function showErrorBanner(message: string): void {
  void alertNative(message);
}

// ---- resizers ----
vResizer(vres, sidebar, { min: 120, max: 600, onResize: () => terminals.refit() });
hResizer(hres, termArea, {
  min: 120,
  max: 800,
  fromEnd: true,
  onResize: () => {
    const heightPx = Math.round(termArea.getBoundingClientRect().height);
    saveDrawerState({ open: true, heightPx });
    terminals.refit();
  },
});
vResizer(composerRes, composerPane, { min: 220, fromEnd: true });
vResizer(diffRes, diffPane, { min: 220, fromEnd: true });
vResizer(browserRes, browserArea, { min: 220, fromEnd: true });
window.addEventListener("resize", () => terminals.refit());

// ---- file-tree drag to editor split ----
const panesEl = $("panes");

function hasEditorFileDrag(e: DragEvent): boolean {
  return dragHasType(e, FILE_DRAG_TYPE);
}

function clearPaneDropHint(): void {
  setSplitDropHint(panesEl, null);
}

panesEl.addEventListener("dragover", (e) => {
  if (!hasEditorFileDrag(e)) return;
  e.preventDefault();
  const side = splitSideFromClientX(e.clientX, panesEl.getBoundingClientRect());
  e.dataTransfer!.dropEffect = "copy";
  setSplitDropHint(panesEl, side);
}, SPLIT_DROP_TARGET_OPTIONS);
panesEl.addEventListener("dragleave", (e) => {
  const next = e.relatedTarget;
  if (!(next instanceof Node) || !panesEl.contains(next)) clearPaneDropHint();
}, SPLIT_DROP_TARGET_OPTIONS);
panesEl.addEventListener("drop", (e) => {
  const path = e.dataTransfer?.getData(FILE_DRAG_TYPE);
  if (!path) return;
  e.preventDefault();
  const side = splitSideFromClientX(e.clientX, panesEl.getBoundingClientRect());
  clearPaneDropHint();
  tree.onOpenFileInPane?.(path, side);
}, SPLIT_DROP_TARGET_OPTIONS);
window.addEventListener("dragend", clearPaneDropHint);

// ---- global shortcuts ----
window.addEventListener("keydown", (e) => {
  const mod = isMod(e);
  // e.code (physical key) not e.key — ⌥ remaps e.key on macOS, breaking ⌥⌘S
  if (mod && e.code === "KeyN") {
    e.preventDefault();
    if (e.shiftKey) void spawnWindow(); // ⇧⌘N New Window
    else editor.newUntitled(); // ⌘N New File
  } else if (mod && e.code === "KeyO") {
    e.preventDefault();
    void openFolderDialog();
  } else if (mod && e.code === "KeyW") {
    e.preventDefault();
    void closeActiveTab();
  } else if (mod && e.code === "KeyS") {
    e.preventDefault();
    if (e.altKey) {
      for (const t of editor.tabs) if (t.dirty) void saveTab(t); // ⌥⌘S Save All
    } else if (e.shiftKey && editor.active) {
      void saveTab(editor.active, true); // ⇧⌘S Save As
    } else if (editor.active) {
      void saveTab(editor.active); // ⌘S Save
    }
  } else if (mod && e.code === "KeyJ") {
    e.preventDefault();
    setTerminal(!drawerState.open);
  } else if (mod && e.code === "KeyB") {
    e.preventDefault();
    setSidebar(sidebar.classList.contains("hidden"));
  } else if (mod && e.shiftKey && e.code === "KeyP") {
    e.preventDefault();
    palette.open(">"); // ⌘⇧P command mode
  } else if (mod && e.code === "KeyP") {
    e.preventDefault();
    palette.open(); // ⌘P file mode
  } else if (mod && e.code === "KeyT") {
    e.preventDefault();
    palette.open("#"); // ⌘T symbol mode
  } else if (mod && e.code === "Backslash") {
    e.preventDefault();
    if (editor.isSplit) void editor.closeSplit();
    else editor.openSplit();
  } else if (isPreviewShortcut(e)) {
    e.preventDefault();
    togglePreview();
  } else if (mod && e.shiftKey && e.code === "KeyF") {
    e.preventDefault();
    if (!searchViewOpen) openSearchView();
    search.focus();
  } else if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setTerminal(!drawerState.open);
  } else if (mod && e.code === "Comma") {
    e.preventDefault();
    openSettings();
  } else if (e.key === "F5") {
    // F5: start when idle, continue when paused; ⇧F5 stops (VS Code parity).
    e.preventDefault();
    if (e.shiftKey) void debugSession.stop();
    else if (debugSession.active) void debugSession.continue();
    else void startDebugging();
  } else if (e.key === "F6") {
    e.preventDefault();
    void debugSession.pause();
  } else if (e.key === "F10") {
    e.preventDefault();
    void debugSession.stepOver();
  } else if (e.key === "F11") {
    e.preventDefault();
    if (e.shiftKey) void debugSession.stepOut();
    else void debugSession.stepIn();
  }
}, GLOBAL_SHORTCUT_OPTIONS);

// Autosave: flush dirty tabs when the window loses focus (opt-in via settings).
window.addEventListener("blur", () => {
  if (settings.autosaveOnBlur) actions.saveAllDirty();
});

// ---- chrome: icon buttons + menu bar ----
$("btn-open-editors").innerHTML = icon("openEditors", 17);
btnTerm.innerHTML = icon("terminal", 17);
btnComposer.innerHTML = icon("prompt-builder", 17);
btnDiff.innerHTML = icon("git-compare", 17);
btnBrowser.innerHTML = icon("world", 17);
btnPalette.innerHTML = `${icon("command", 14)}<span class="pal-text">Search files, run commands…</span><kbd>⌘P</kbd>`;
// Self-update pill beside the palette: hidden until a newer release is found.
const updater = mountUpdater($("btn-update") as HTMLButtonElement, {
  onError: (m) => void alertNative(m),
  onInfo: (m) => void alertNative(m),
});
btnMenu.innerHTML = icon("menu", 17);
// Post-update What's New badge on the app menu button (replaces the old
// permanent version pill; version now lives only in the About modal).
void getVersion().then((v) => {
  if (shouldShowWhatsNew(v, localStorage.getItem(WHATS_NEW_SEEN_KEY))) btnMenu.classList.add("badged");
}, () => undefined);
$("btn-back").innerHTML = icon("back", 16);
$("btn-reload").innerHTML = icon("reload", 16);
$("btn-refresh").innerHTML = icon("refresh", 15);
$("btn-search-toggle").innerHTML = icon("search", 15);
$("btn-new-file").innerHTML = icon("fileAdd", 15);
$("btn-new-folder").innerHTML = icon("folderAdd", 15);
$("btn-close-all-editors").innerHTML = icon("x", 15);
$("btn-new-file").onclick = () => void tree.beginCreate(tree.targetDirForCreate(), false);
$("btn-new-folder").onclick = () => void tree.beginCreate(tree.targetDirForCreate(), true);
$("btn-close-all-editors").onclick = () => editor.closeAllTabs();
$("btn-refresh").onclick = () => void tree.refresh();
btnSearchToggle.onclick = () => toggleSearchView();
btnPalette.onclick = () => palette.open();
// App menu: the global verbs that aren't pane toggles (palette + shortcuts own the rest).
btnMenu.onclick = () => {
  workspaceBar.openPopover(
    btnMenu,
    (el, close) => {
      const mk = (label: string, kbd: string, run: () => void): void => {
        const row = document.createElement("div");
        row.className = "menu-row";
        const text = document.createElement("span");
        text.textContent = label;
        row.appendChild(text);
        if (kbd) {
          const k = document.createElement("span");
          k.className = "kbd";
          k.textContent = kbd;
          row.appendChild(k);
        }
        row.onclick = () => {
          close();
          run();
        };
        el.appendChild(row);
      };
      mk(MENU_LABELS.commandPalette, "⌘P", () => palette.open());
      mk(MENU_LABELS.problems, "", () => setProblemsPanel(problemsHost.classList.contains("hidden")));
      mk(MENU_LABELS.sessions, "", () => setSessionsPanel(sessionsHost.classList.contains("hidden")));
      const foot = document.createElement("div");
      foot.className = "menu-foot";
      el.appendChild(foot);
      mk(MENU_LABELS.checkUpdates, "", () => void updater.checkNow());
      if (btnMenu.classList.contains("badged")) {
        mk(MENU_LABELS.whatsNew + " •", "", () => openAbout("What's New"));
      }
      mk(MENU_LABELS.settings, "⌘,", () => openSettings());
      mk(MENU_LABELS.about, "", () => openAbout());
    },
    "menu-card",
  );
};

const actions = {
  newFile: () => editor.newUntitled(),
  saveActive: () => {
    if (editor.active) void saveTab(editor.active);
  },
  saveActiveAs: () => {
    if (editor.active) void saveTab(editor.active, true);
  },
  saveAllDirty: () => {
    for (const t of editor.tabs) if (t.dirty) void saveTab(t);
  },
  openFolder: () => void openFolderDialog(),
  closeTab: () => void closeActiveTab(),
  toggleTerminal: () => setTerminal(!drawerState.open),
  toggleDiff: () => setDiff(diffPane.classList.contains("hidden")),
  toggleBrowser: () => setBrowser(browserArea.classList.contains("hidden")),
  toggleSidebar: () => setSidebar(sidebar.classList.contains("hidden")),
  newTerminal: () => void terminals.create(),
  increaseFontSize: () => persistSettings(nextFontSettings(settings, 1)),
  decreaseFontSize: () => persistSettings(nextFontSettings(settings, -1)),
  // Resets only the font sizes — other settings keep their values.
  resetFontSize: () =>
    persistSettings({
      ...settings,
      editorFontSize: DEFAULT_SETTINGS.editorFontSize,
      terminalFontSize: DEFAULT_SETTINGS.terminalFontSize,
    }),
  openInBrowser: () => {
    setBrowser(true);
    browser.show();
    $<HTMLInputElement>("browser-url").focus();
    $<HTMLInputElement>("browser-url").select();
  },
  recents: () => loadRecents(),
  switchWorkspace: (path: string) => void openWorkspace(path), // re-open only; trust is persisted, never granted by re-selecting a recents row
  addFolder: () => void openFolderDialog(),
  newWindow: () => void spawnWindow(),
};

workspaceBar = mountWorkspaceBar($("titlebar"), {
  recents: actions.recents,
  switchWorkspace: actions.switchWorkspace,
  addFolder: actions.addFolder,
  openFolder: actions.openFolder,
  newWindow: actions.newWindow,
});
workspaceBar.setCurrentWorkspace(null);

gitBar = createGitBar($("branch-whisper"));
gitBar.onWorktreeSelect = (path: string) => void openWorkspace(path); // worktree is its own root; re-open only, trust not auto-granted
gitBar.onBranchSelect = (branch: string) => void switchBranch(branch);

async function refreshGitState(root: string): Promise<void> {
  await editor.refreshCleanGitBaselines();
  await gitBar.refresh(root);
}

// ---- automations ----
let runningAutomationTermId: string | null = null;
automationBar = mountAutomationBar($("automations"), {
  run: (a) => void runAutomation(a),
  stop: () => {
    if (runningAutomationTermId) terminals.interrupt(runningAutomationTermId);
  },
  openCreate: () => openAutomationPanel(),
  edit: (a) => openAutomationPanel(a),
  remove: (a) => void deleteAutomation(a),
});

// Delete an automation after confirmation, then persist + refresh the picker.
async function deleteAutomation(a: Automation): Promise<void> {
  if (!currentRoot) return;
  if (!(await confirmNative(`Delete automation "${a.name}"?`))) return;
  automations = removeAutomation(automations, a.id);
  try {
    await saveAutomations(currentRoot, automations);
  } catch (e) {
    showErrorBanner(`Could not delete automation: ${e}`);
    return;
  }
  automationBar.setAutomations(automations);
}

// Run an automation in a free terminal; mark the bar "running" until that terminal idles.
async function runAutomation(a: Automation): Promise<void> {
  setTerminal(true);
  const termId = await terminals.runCommand(a.command).catch(() => null);
  if (!termId) return;
  runningAutomationTermId = termId;
  automationBar.setRunning(true);
  const poll = async (): Promise<void> => {
    const busy = await terminals.isBusyById(termId).catch(() => false);
    if (busy) window.setTimeout(() => void poll(), 1000);
    else {
      if (runningAutomationTermId === termId) runningAutomationTermId = null;
      automationBar.setRunning(false);
    }
  };
  window.setTimeout(() => void poll(), 800); // let the command take the foreground first
}

// Persist a new/edited automation and refresh the picker.
async function persistAutomation(a: Automation): Promise<void> {
  if (!currentRoot) return;
  const invalid = validateAutomation(a);
  if (invalid) {
    showErrorBanner(invalid);
    return;
  }
  automations = upsertAutomation(automations, a);
  try {
    await saveAutomations(currentRoot, automations);
  } catch (e) {
    showErrorBanner(`Could not save automation: ${e}`);
    return;
  }
  automationBar.setAutomations(automations);
}

// Full-width automation drawer fused under the titlebar (Variant 3). Creates a
// new automation, or edits `existing` in place when supplied (keeps its id).
function openAutomationPanel(existing?: Automation): void {
  if (!currentRoot) {
    showErrorBanner("Open a folder before saving automations.");
    return;
  }
  document.getElementById("auto-drawer")?.remove();

  const drawer = document.createElement("div");
  drawer.id = "auto-drawer";
  drawer.className = "auto-drawer";

  const row = document.createElement("div");
  row.className = "auto-drawer-row";

  const title = document.createElement("span");
  title.className = "auto-drawer-title";
  title.innerHTML = `${icon(existing ? "pencil" : "plus", 14)}<span>${existing ? "Edit automation" : "New automation"}</span>`;

  const nameField = document.createElement("label");
  nameField.className = "auto-field name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "e.g. Dev server";
  nameInput.spellcheck = false;
  nameInput.value = existing?.name ?? "";
  nameField.innerHTML = "<span>Name</span>";
  nameField.appendChild(nameInput);

  const cmdField = document.createElement("label");
  cmdField.className = "auto-field cmd";
  const cmdInput = document.createElement("input");
  cmdInput.type = "text";
  cmdInput.placeholder = "e.g. npm run dev";
  cmdInput.spellcheck = false;
  cmdInput.value = existing?.command ?? "";
  cmdField.innerHTML = "<span>Command</span>";
  cmdField.appendChild(cmdInput);

  const err = document.createElement("span");
  err.className = "auto-drawer-err";

  const acts = document.createElement("div");
  acts.className = "auto-drawer-acts";
  const cancel = document.createElement("button");
  cancel.className = "cancel";
  cancel.textContent = "Cancel";
  const saveBtn = document.createElement("button");
  saveBtn.className = "save";
  saveBtn.textContent = "Save";
  acts.append(cancel, saveBtn);

  row.append(title, nameField, cmdField, err, acts);
  drawer.appendChild(row);
  $("titlebar").after(drawer);
  requestAnimationFrame(() => terminals.refit());
  nameInput.focus();

  const close = (): void => {
    drawer.remove();
    document.removeEventListener("keydown", onKey);
    requestAnimationFrame(() => terminals.refit());
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);

  const submit = (): void => {
    const nameErr = validateName(nameInput.value, automations, existing?.id);
    const cmdErr = validateCommand(cmdInput.value);
    if (nameErr || cmdErr) {
      err.textContent = nameErr ?? cmdErr ?? "";
      (nameErr ? nameInput : cmdInput).focus();
      return;
    }
    void persistAutomation(makeAutomation(nameInput.value, cmdInput.value, existing?.id)).then(close);
  };

  cancel.onclick = close;
  saveBtn.onclick = submit;
  for (const input of [nameInput, cmdInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
  }
}

// Checkout a branch in place, then re-baseline open tabs against the new HEAD.
async function switchBranch(branch: string): Promise<void> {
  if (!currentRoot) return;
  try {
    await gitCheckout(currentRoot, branch);
  } catch (e) {
    showErrorBanner(`Checkout failed: ${e}. Commit or stash changes first.`);
    return;
  }
  await editor.reloadAllFromDisk();
  void tree.refresh();
  void refreshGitState(currentRoot);
  editor.recomputeDiff();
  renderWhisperBar();
}

// ---- command palette ----
// Named so the settings shortcuts reference can reuse it as the single source of truth.
const paletteCommands: Command[] = [
  { id: "new-file", title: "New File", run: actions.newFile, shortcut: fmtShortcut("N") },
  { id: "save", title: "Save", run: actions.saveActive, shortcut: fmtShortcut("S") },
  { id: "save-as", title: "Save As…", run: actions.saveActiveAs, shortcut: fmtShortcut("S", { shift: true }) },
  { id: "save-all", title: "Save All", run: actions.saveAllDirty, shortcut: fmtShortcut("S", { alt: true }) },
  { id: "open-folder", title: "Open Folder…", run: actions.openFolder, shortcut: fmtShortcut("O") },
  { id: "close-tab", title: "Close Tab", run: actions.closeTab, shortcut: fmtShortcut("W") },
  { id: "toggle-terminal", title: "Toggle Terminal", run: actions.toggleTerminal, shortcut: fmtShortcut("J") },
  { id: "toggle-diff", title: "Toggle Diff Viewer", run: actions.toggleDiff },
  { id: "toggle-browser", title: "Toggle Browser", run: actions.toggleBrowser },
  { id: "open-in-browser", title: "Open in Browser…", run: actions.openInBrowser },
  { id: "toggle-sidebar", title: "Toggle Sidebar", run: actions.toggleSidebar, shortcut: fmtShortcut("B") },
  { id: "toggle-split", title: "Toggle Split", run: () => {
    if (editor.isSplit) void editor.closeSplit();
    else editor.openSplit();
  }, shortcut: fmtShortcut("\\") },
  { id: "new-terminal", title: "New Terminal", run: actions.newTerminal },
  { id: "font-increase", title: "Increase Font Size", run: actions.increaseFontSize },
  { id: "font-decrease", title: "Decrease Font Size", run: actions.decreaseFontSize },
  { id: "font-reset", title: "Reset Font Size", run: actions.resetFontSize },
  { id: "new-automation", title: "New Automation…", run: () => openAutomationPanel() },
  { id: "search", title: "Search Folder", run: () => {
    if (!searchViewOpen) openSearchView();
    search.focus();
  }, shortcut: fmtShortcut("F", { shift: true }) },
  { id: "settings", title: "Settings", run: () => openSettings(), shortcut: fmtShortcut(",") },
  { id: "about", title: "About Sutra", run: () => openAbout() },
  { id: "whats-new", title: "What's New", run: () => openAbout("What's New") },
  { id: "debug-start", title: "Debug: Start", run: () => void startDebugging(), shortcut: "F5" },
  { id: "debug-continue", title: "Debug: Continue", run: () => void debugSession.continue(), shortcut: "F5" },
  { id: "debug-pause", title: "Debug: Pause", run: () => void debugSession.pause(), shortcut: "F6" },
  { id: "debug-step-over", title: "Debug: Step Over", run: () => void debugSession.stepOver(), shortcut: "F10" },
  { id: "debug-step-into", title: "Debug: Step Into", run: () => void debugSession.stepIn(), shortcut: "F11" },
  { id: "debug-step-out", title: "Debug: Step Out", run: () => void debugSession.stepOut(), shortcut: "⇧F11" },
  { id: "debug-stop", title: "Debug: Stop", run: () => void debugSession.stop(), shortcut: "⇧F5" },
];

function recentPaletteCommands(): Command[] {
  // mountPalette's builder must stay synchronous — read the cached snapshot
  // rather than loadRecents() (backend-async). Refreshed at boot and after
  // every recentsPush.
  return recentsCache
    .filter((recent) => recent.path !== currentRoot)
    .map((recent) => ({
      id: `recent:${recent.path}`,
      title: `Open ${recent.name}`,
      run: () => actions.switchWorkspace(recent.path),
      section: "recent" as const,
    }));
}

palette = mountPalette({
  commands: () => paletteCommands,
  workspaces: () => recentPaletteCommands(),
  files: () => listFiles(currentRoot ?? ""),
  symbols: (query, limit) => langWorkspaceSymbols(query, limit),
  onOpenFile: (path, line) => void editor.openFile(path, line),
  resolveFile: (rel) => `${currentRoot}/${rel}`,
});

// Shortcuts shown in the settings reference: palette entries + hardcoded extras.
function shortcutEntries(): ShortcutEntry[] {
  const fromPalette = paletteCommands
    .filter((c) => "shortcut" in c && c.shortcut)
    .map((c) => ({ title: c.title, keys: (c as { shortcut: string }).shortcut }));
  return [...fromPalette, { title: "Focus Terminal", keys: "⌃`" }];
}

// Opens the settings modal wired to live state and instant-apply persistence.
function openSettings(): void {
  openSettingsModal({
    get: () => settings,
    apply: persistSettings,
    openAbout: () => openAbout(),
    shortcuts: shortcutEntries(),
  });
}

// Opens the About panel (app menu, palette). Resolves the runtime version first, then
// marks What's New seen for this version so the ☰ badge clears.
function openAbout(tab: AboutTab = "What's New"): void {
  void getVersion().then(
    (v) => {
      localStorage.setItem(WHATS_NEW_SEEN_KEY, v);
      btnMenu.classList.remove("badged");
      openAboutModal(v, tab);
    },
    () => openAboutModal("", tab),
  );
}

// ---- quit guard ----
// Prompt before the window closes while unsaved buffers exist. Registering a
// close-requested listener defers the close to JS; without preventDefault the
// wrapper destroys the window (needs core:window:allow-destroy capability).
void getCurrentWindow().onCloseRequested(async (event) => {
  const dirtyTabs = editor.tabs.filter((t) => t.dirty);
  if (dirtyTabs.length === 0) return;
  const names = dirtyTabs.slice(0, 5).map((t) => t.name).join(", ");
  const more = dirtyTabs.length > 5 ? `, +${dirtyTabs.length - 5} more` : "";
  const quit = await confirmNative(`Quit and discard unsaved changes? ${names}${more}`);
  if (!quit) event.preventDefault();
});

// ---- outline view ----
// Mount the Files/Outline toggle in the sidebar above the file tree.
outlineView = new OutlineView(
  $("sidebar"),
  $("tree"),
  () => editor.active?.path ?? null,
  () => editor.getDocumentSymbols(),
);
outlineView.onRevealLine = (path, line) => {
  void editor.openFile(path, line).then(() => editor.revealLine(line));
};

// Refresh the outline when the active file changes.
const _origOnActiveTabChanged = editor.onActiveTabChanged;
editor.onActiveTabChanged = (tab) => {
  _origOnActiveTabChanged?.(tab);
  outlineView.onActiveFileChanged();
};
// Debounced outline refresh while editing the active file.
editor.onDocChanged = () => {
  outlineView.scheduleRefresh();
  // Harness: edits invalidate the active file's diagnostics (marked stale).
  const activePath = editor.active?.path;
  if (activePath) notifyDocChanged(activePath);
};

// ---- boot ----
editor.renderAllTabs();
renderWhisperBar();

// Settings/ui-state/recents/trust now live in the shared backend store (all
// windows + the Dock menu read the same files), so their initial load is
// async — everything that depends on them is deferred into this one boot
// sequence. Reopens the most-recently used folder so a relaunch resumes where
// the user left off instead of a blank window; skips silently if the folder
// was moved/deleted since last run.
void (async function boot(): Promise<void> {
  settings = await loadSettings();
  applySettings(settings);

  const ui = await readUiState({
    drawerRaw: localStorage.getItem(DRAWER_KEY),
    composerHRaw: localStorage.getItem(LEGACY_DRAWER_H_KEY),
  });
  drawerState = ui.terminalDrawer;
  setTerminal(drawerState.open);

  // One-shot on upgrade: port pre-migration recents/trustedRoots into the
  // backend, then seed the trusted set from folders already in recents so
  // workspaces the user opened deliberately before the trust gate existed are
  // not re-gated. Must run before any open below, whose watcher can fire the
  // diagnostics trust check. Idempotent after the first run (backend
  // trustMigrated flag).
  await seedRecentsFromLocalStorage();
  const recents = await loadRecents();
  recentsCache = recents;
  await ensureTrustSeeded(recents.map((r) => r.path));

  // A path handed to Sutra at launch (CLI arg / Finder "Open With") wins over
  // last-folder restore. Consume it once; on none, fall back to the last workspace.
  const launch = await takeLaunchPath().catch(() => null);
  if (launch) {
    await routeOpenPath(launch.path, launch.isDir);
    return;
  }
  const [last] = recents;
  if (!last) return; // first run — nothing to restore
  try {
    await listDir(last.path); // cheap existence/readability probe
  } catch {
    return; // folder gone or unreadable — stay on the blank state
  }
  await openWorkspace(last.path);
})();
