// App entry: instantiates the tree / editor / terminal / diff modules and wires
// the cross-cutting concerns — toolbar toggles, global shortcuts, save + save-as
// (native dialog), pane resizers, and integrated-agent workspace tracking.
import { open, save, ask, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { FileTree, OutlineView } from "./tree";
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
import { BrowserPane } from "./browser";
import { vResizer, hResizer, mountDebuggerSidebarSlot } from "./layout";
import { setBreakpointToggleHandler, setBreakpointMarks } from "./editor";
import { DebugSession } from "./debug-session";
import { detectAdapter, isTrusted, markTrusted, breakpointStore } from "./debug";
import {
  agentTrackingPoll,
  listDir,
  readFile,
  writeFile,
  fileMtime,
  gitHeadContent,
  renamePath,
  deletePath,
  createDir,
  movePath,
  gitChangedFiles,
  gitCheckout,
  onPreviewOpen,
  onDrive,
  onUiRequest,
  mcpUiReply,
  mcpSetRoot,
  mcpWriteAgentConfig,
  onFsChanged,
  watchStart,
  watchStop,
  langIndexBuild,
  langIndexInvalidate,
  type AgentTrackingStatus,
} from "./ipc";
import { firstViewableAgentChange, mergeChangedFiles, whisperText } from "./agent-tracking";
import { mountWorkspaceBar, type WorkspaceBarHandle } from "./menubar";
import { mountPalette, mountSymbolPalette, mountLocationPicker, type Command, type PaletteHandle } from "./palette";
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
  type Automation,
  type AutomationBarHandle,
} from "./automations";
import { icon } from "./icons";
import { mountUpdater } from "./updater";
import { parseGitDirLine, resolveGitIndexPathFromGitDir } from "./git-index";
import {
  breadcrumbSegments,
  loadRecents,
  loadWorkspaceSession,
  pathBelongsToRoot,
  pruneWorkspaceSession,
  saveRecents,
  saveWorkspaceSession,
  sessionFromTabs,
  upsertRecent,
} from "./workspace";
import {
  DEFAULT_SETTINGS,
  clampSettings,
  loadSettings,
  nextFontSettings,
  saveSettings,
  type UserSettings,
} from "./settings";
import { GLOBAL_SHORTCUT_OPTIONS, isPreviewShortcut } from "./shortcuts";
import { openSettingsModal, type ShortcutEntry } from "./settings-modal";
import { DRAWER_KEY, clampDrawerState, loadDrawerState, type DrawerState } from "./terminal-groups";

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
  // codelldb is resolved on PATH by the Rust spawn; a spawn failure surfaces in the console.
  const spec = detectAdapter(signals, "codelldb");
  if (!spec) {
    await message("No debug adapter detected for this project.", { title: "Sutra", kind: "warning" });
    return;
  }
  if (!isTrusted(spec, root)) {
    const cmd = spec.transport.kind === "stdio" ? spec.transport.command : "";
    if (!window.confirm(`Run debug adapter from this workspace?\n${cmd}`)) return;
    markTrusted(root);
  }
  const program = editor.active?.path ?? "";
  await debugSession.start(spec, root, program);
}
const diffViewer = new DiffViewer();
const search = new SearchPanel(
  $<HTMLInputElement>("search-input"),
  $<HTMLButtonElement>("search-case"),
  $("search-results"),
);
search.onOpenMatch = (p, line) => { void editor.openFile(p, line); tree.setActive(p); };
const browser = new BrowserPane(
  $("browser-area"),
  $<HTMLIFrameElement>("browser-frame"),
  $<HTMLInputElement>("browser-url"),
  $<HTMLButtonElement>("btn-back"),
  $<HTMLButtonElement>("btn-reload"),
);

// Wire terminal link clicks → embedded browser.
terminals.onLinkActivate = (url: string) => {
  setBrowser(true);
  browser.show();
  browser.open(url);
};

// Subscribe to MCP preview-open events emitted by the Rust MCP server tools.
void onPreviewOpen((p) => {
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
  }
});

// Subscribe to MCP UI-state requests and reply through the typed IPC command.
void onUiRequest((r) => {
  const payload =
    r.query === "openTabs"
      ? { tabs: editor.getOpenTabs() }
      : editor.getSelection();
  void mcpUiReply(r.id, payload);
});

// Native workspace watcher refreshes the visible tree and git badges after
// filesystem changes from terminals, external tools, or Finder.
void onFsChanged((payload) => {
  if (!currentRoot) return;
  const root = currentRoot;
  if (payload.paths.length > 0 && !payload.paths.some((path) => pathBelongsToRoot(path, root))) {
    return;
  }
  // Inform the lang engine to re-index changed files (gracefully degrades if backend absent).
  if (payload.paths.length > 0) void langIndexInvalidate(payload.paths).catch(() => {});
  scheduleFileSystemRefresh(root);
});

const whisperBar = $("whisper-bar");
let workspaceBar: WorkspaceBarHandle; // assigned at boot once toggle handlers exist
let palette: PaletteHandle; // assigned at boot once all actions are defined
let symbolPalette: { open(): void }; // Cmd+T workspace symbol picker
let gitBar: GitBarHandle; // assigned at boot
let automationBar: AutomationBarHandle; // assigned at boot
let outlineView: OutlineView; // Files/Outline toggle in the sidebar
let automations: Automation[] = []; // per-project automations for the current root
let currentRoot: string | null = null; // track opened workspace
let fsRefreshRunning = false;
let fsRefreshPendingRoot: string | null = null;
let agentStatus: AgentTrackingStatus = { enabled: false, agentActive: false, changes: [] };
let suppressSessionSave = false;
let settings: UserSettings = loadSettings();

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

tree.onDelete = async (path: string) => {
  if (!(await confirmNative(`Delete "${path.split("/").pop()}"?`))) return;
  try {
    await deletePath(path);
    // Close any open tabs for deleted path and its children
    const pathPrefix = path.endsWith("/") ? path : path + "/";
    for (const tab of editor.tabs.slice()) {
      if (tab.path && (tab.path === path || tab.path.startsWith(pathPrefix))) {
        editor.closeTab(tab);
      }
    }
    await tree.refresh();
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

tree.onMove = async (src: string, destDir: string) => {
  try {
    // Compute destination path: destDir + "/" + basename(src)
    const srcBaseName = src.split("/").pop() || src;
    const destPath = destDir + "/" + srcBaseName;
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
    await tree.refresh();
  } catch (e) {
    void alertNative(`Move failed: ${e}`);
  }
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
  saveSettings(settings);
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
  const content = editor.contentOf(tab);
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
async function openWorkspace(dir: string): Promise<void> {
  if (!(await confirmWorkspaceClose(dir))) return;
  persistWorkspaceSession();
  suppressSessionSave = true;
  try {
    editor.closeTabsOutsideWorkspace(dir);
    editor.setWorkspaceRoot(dir);
    currentRoot = dir;
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
  } finally {
    suppressSessionSave = false;
  }
  persistWorkspaceSession();
  search.setRoot(dir);
  workspaceBar.setCurrentWorkspace(dir);
  await terminals.reset(dir, drawerState.open);
  saveRecents(upsertRecent(loadRecents(), dir, Date.now()));
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

async function openFolderDialog(): Promise<void> {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") await openWorkspace(dir);
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
let drawerState: DrawerState = loadDrawerState(localStorage.getItem(DRAWER_KEY));
const terminalSeam = document.createElement("button");
terminalSeam.id = "terminal-seam";
terminalSeam.type = "button";
terminalSeam.onclick = () => setTerminal(true);
termArea.prepend(terminalSeam);

function saveDrawerState(next: DrawerState): void {
  drawerState = clampDrawerState(next);
  localStorage.setItem(DRAWER_KEY, JSON.stringify(drawerState));
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
    else requestAnimationFrame(() => terminals.refit());
  }
}
btnTerm.onclick = () => setTerminal(!drawerState.open);
terminals.onTabsChanged = renderTerminalSeam;

// ---- diff file list ----
async function refreshDiffFileList(): Promise<void> {
  if (!currentRoot) return;
  const root = currentRoot;
  try {
    await editor.refreshCleanGitBaselines();
    if (currentRoot !== root) return;
    const gitFiles = await gitChangedFiles(root);
    if (currentRoot !== root) return;
    const files = mergeChangedFiles(gitFiles, agentStatus.changes);
    const activePath = editor.active?.path ?? null;
    diffViewer.renderFileList(files, activePath, {
      onFilePick: (path: string) => void viewChangedPath(path),
      onExpand: async (path: string) => {
        const file = files.find((candidate) => candidate.path === path);
        if (!file || file.status === "D") return [];
        try {
          const base = (await gitHeadContent(path).catch(() => "")) ?? "";
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
  browserArea.classList.toggle("hidden", !on);
  browserRes.classList.toggle("hidden", !on);
  btnBrowser.classList.toggle("on", on);
}
btnBrowser.onclick = () => setBrowser(browserArea.classList.contains("hidden"));

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

// ---- integrated-agent workspace tracking ----
let pollTimer: number | undefined;

function startAgentTrackingPoll(): void {
  if (pollTimer !== undefined) return;
  pollTimer = window.setInterval(pollAgentChanges, 1500);
}

// Halts agent-change polling and clears any whisper text it surfaced.
function stopAgentTrackingPoll(): void {
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

function startGitPoll(): void {
  if (gitPollTimer !== undefined) return;
  gitPollTimer = window.setInterval(() => void pollGitIndex(), 10000);
}

function stopGitPoll(): void {
  if (gitPollTimer !== undefined) {
    clearInterval(gitPollTimer);
    gitPollTimer = undefined;
    gitIndexMtime = 0;
    gitIndexPath = null;
  }
}

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
    renderWhisperBar();
    if (!diffPane.classList.contains("hidden")) void refreshDiffFileList();
  } catch {
    // Poll failures must not interrupt editing.
  }
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
    await editor.openLatestFile(path, change?.status ?? "M");
    tree.setActive(path);
  } catch (e) {
    diffViewer.renderStatus(basename(path), `Cannot open changed file: ${e}`);
  }
}

function renderWhisperBar(): void {
  whisperBar.innerHTML = "";
  const left = document.createElement("div");
  left.className = "whisper-left";
  const saveState = document.createElement("span");
  saveState.className = "whisper-save" + (editor.tabs.some((tab) => tab.dirty) ? " dirty" : "");
  saveState.textContent = editor.tabs.some((tab) => tab.dirty) ? "unsaved changes" : "all changes saved";
  left.append(saveState);

  const activePath = editor.active?.path ?? null;
  const agentCopy = whisperText(agentStatus, activePath);
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
  if (editor.active) {
    const selection = editor.getSelection();
    right.textContent = `ln ${selection.line}`;
  }
  whisperBar.append(left, right);
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
  const mod = e.metaKey || e.ctrlKey;
  // e.code (physical key) not e.key — ⌥ remaps e.key on macOS, breaking ⌥⌘S
  if (mod && e.code === "KeyN") {
    e.preventDefault();
    editor.newUntitled();
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
  } else if ((mod && e.code === "KeyP") || (mod && e.shiftKey && e.code === "KeyP") || (mod && e.code === "KeyK")) {
    e.preventDefault();
    palette.open();
  } else if (mod && e.code === "KeyT") {
    // Cmd+T / Ctrl+T: workspace symbol search backed by the lang engine.
    e.preventDefault();
    symbolPalette.open();
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
  }
}, GLOBAL_SHORTCUT_OPTIONS);

// Autosave: flush dirty tabs when the window loses focus (opt-in via settings).
window.addEventListener("blur", () => {
  if (settings.autosaveOnBlur) actions.saveAllDirty();
});

// ---- chrome: icon buttons + menu bar ----
btnTerm.innerHTML = icon("terminal", 17);
btnDiff.innerHTML = icon("git-compare", 17);
btnBrowser.innerHTML = icon("world", 17);
btnPalette.innerHTML = `${icon("command", 14)}<span class="pal-text">Search files, run commands…</span><kbd>⌘K</kbd>`;
// Self-update pill beside the palette: hidden until a newer release is found.
mountUpdater($("btn-update") as HTMLButtonElement, { onError: (m) => void alertNative(m) });
btnMenu.innerHTML = icon("menu", 17);
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
      mk("open folder…", "⌘O", () => actions.openFolder());
      mk("command palette", "⌘K", () => palette.open());
      const foot = document.createElement("div");
      foot.className = "menu-foot";
      el.appendChild(foot);
      mk("settings…", "⌘,", () => openSettings());
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
  switchWorkspace: (path: string) => void openWorkspace(path),
  addFolder: () => void openFolderDialog(),
};

workspaceBar = mountWorkspaceBar($("titlebar"), {
  recents: actions.recents,
  switchWorkspace: actions.switchWorkspace,
  addFolder: actions.addFolder,
  openFolder: actions.openFolder,
  openSettings: () => openSettings(),
});
workspaceBar.setCurrentWorkspace(null);

gitBar = createGitBar($("branch-whisper"));
gitBar.onWorktreeSelect = (path: string) => void openWorkspace(path);
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
  { id: "new-file", title: "New File", run: actions.newFile, shortcut: "⌘N" },
  { id: "save", title: "Save", run: actions.saveActive, shortcut: "⌘S" },
  { id: "save-as", title: "Save As…", run: actions.saveActiveAs, shortcut: "⇧⌘S" },
  { id: "save-all", title: "Save All", run: actions.saveAllDirty, shortcut: "⌥⌘S" },
  { id: "open-folder", title: "Open Folder…", run: actions.openFolder, shortcut: "⌘O" },
  { id: "close-tab", title: "Close Tab", run: actions.closeTab, shortcut: "⌘W" },
  { id: "toggle-terminal", title: "Toggle Terminal", run: actions.toggleTerminal, shortcut: "⌘J" },
  { id: "toggle-diff", title: "Toggle Diff Viewer", run: actions.toggleDiff },
  { id: "toggle-browser", title: "Toggle Browser", run: actions.toggleBrowser },
  { id: "open-in-browser", title: "Open in Browser…", run: actions.openInBrowser },
  { id: "toggle-sidebar", title: "Toggle Sidebar", run: actions.toggleSidebar, shortcut: "⌘B" },
  { id: "toggle-split", title: "Toggle Split", run: () => {
    if (editor.isSplit) void editor.closeSplit();
    else editor.openSplit();
  }, shortcut: "⌘\\" },
  { id: "new-terminal", title: "New Terminal", run: actions.newTerminal },
  { id: "font-increase", title: "Increase Font Size", run: actions.increaseFontSize },
  { id: "font-decrease", title: "Decrease Font Size", run: actions.decreaseFontSize },
  { id: "font-reset", title: "Reset Font Size", run: actions.resetFontSize },
  { id: "new-automation", title: "New Automation…", run: () => openAutomationPanel() },
  { id: "search", title: "Search Folder", run: () => {
    if (!searchViewOpen) openSearchView();
    search.focus();
  }, shortcut: "⇧⌘F" },
  { id: "settings", title: "Settings", run: () => openSettings(), shortcut: "⌘," },
  { id: "debug-start", title: "Debug: Start", run: () => void startDebugging() },
  { id: "debug-stop", title: "Debug: Stop", run: () => void debugSession.stop() },
];

function recentPaletteCommands(): Command[] {
  return loadRecents()
    .filter((recent) => recent.path !== currentRoot)
    .slice(0, 5)
    .map((recent) => ({
      id: `recent:${recent.path}`,
      title: `Open ${recent.name}`,
      run: () => actions.switchWorkspace(recent.path),
      section: "recent" as const,
    }));
}

palette = mountPalette(() => [...recentPaletteCommands(), ...paletteCommands]);

// Workspace symbol picker (Cmd+T) backed by the lang engine.
symbolPalette = mountSymbolPalette((path, line) => void editor.openFile(path, line));

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
    version: getVersion(),
    shortcuts: shortcutEntries(),
  });
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
editor.onDocChanged = () => outlineView.scheduleRefresh();

// ---- boot ----
applySettings(settings);
editor.renderAllTabs();
renderWhisperBar();
setTerminal(drawerState.open);
