// App entry: instantiates the tree / editor / terminal / diff modules and wires
// the cross-cutting concerns — toolbar toggles, global shortcuts, save + save-as
// (native dialog), pane resizers, and integrated-agent workspace tracking.
import { open, save, ask, message } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { FileTree } from "./tree";
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
import { DiffViewer } from "./diff";
import { BrowserPane } from "./browser";
import { vResizer, hResizer } from "./layout";
import {
  agentTrackingAccept,
  agentTrackingPoll,
  agentTrackingRevert,
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
  type AgentChange,
  type AgentTrackingStatus,
} from "./ipc";
import { agentBannerText, aiChanges, firstViewableAgentChange, mergeChangedFiles } from "./agent-tracking";
import { mountWorkspaceBar, type WorkspaceBarHandle } from "./menubar";
import { mountPalette, type PaletteHandle } from "./palette";
import { createGitBar, type GitBarHandle } from "./gitbar";
import {
  mountAutomationBar,
  loadAutomations,
  saveAutomations,
  makeAutomation,
  upsertAutomation,
  validateName,
  validateCommand,
  type Automation,
  type AutomationBarHandle,
} from "./automations";
import { icon } from "./icons";
import { parseGitDirLine, resolveGitIndexPathFromGitDir } from "./git-index";
import {
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
  void refreshFileSystemState(root);
});

const banner = $("ai-banner");
let workspaceBar: WorkspaceBarHandle; // assigned at boot once toggle handlers exist
let palette: PaletteHandle; // assigned at boot once all actions are defined
let gitBar: GitBarHandle; // assigned at boot
let automationBar: AutomationBarHandle; // assigned at boot
let automations: Automation[] = []; // per-project automations for the current root
let currentRoot: string | null = null; // track opened workspace
let agentStatus: AgentTrackingStatus = { enabled: false, agentActive: false, changes: [] };
let suppressSessionSave = false;
let settings: UserSettings = loadSettings();

// ---- tabs (each pane renders its own strip; main wires cross-cutting hooks) ----
editor.onDiffChanged = (hunks, label) => diffViewer.render(hunks, label);
editor.onGutterClick = (idx) => {
  setDiff(true);
  diffViewer.highlightHunk(idx);
};
editor.onActiveTabChanged = (tab) => tree.setActive(tab?.path ?? null);
editor.onTabsChanged = () => persistWorkspaceSession();
editor.confirmCloseTab = (tab) =>
  tab.dirty ? confirmNative(`Discard unsaved changes to ${tab.name}?`) : true;
diffViewer.onRevert = (h) => editor.revertHunk(h);

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

tree.onCreate = async (parentDir: string, isDir: boolean) => {
  const type = isDir ? "folder" : "file";
  const name = await promptInput(`New ${type} name:`);
  if (!name) return;
  try {
    if (isDir) {
      const path = parentDir + "/" + name;
      await createDir(path);
    } else {
      const path = parentDir + "/" + name;
      await writeFile(path, "");
    }
    await tree.refresh();
  } catch (e) {
    void alertNative(`Create ${type} failed: ${e}`);
  }
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
    tree.setActive(editor.active?.path ?? null);
    await tree.setRoot(dir);
    if (settings.restoreSession) await restoreWorkspaceTabs(dir);
  } finally {
    suppressSessionSave = false;
  }
  persistWorkspaceSession();
  search.setRoot(dir);
  workspaceBar.setCurrentWorkspace(dir);
  hideBanner();
  await terminals.reset(dir, !termArea.classList.contains("hidden"));
  saveRecents(upsertRecent(loadRecents(), dir, Date.now()));
  void refreshGitState(dir);
  automations = await loadAutomations(dir);
  automationBar.setAutomations(automations);
  stopGitPoll();
  const resolvedGitIndexPath = await resolveGitIndexPath(dir);
  if (currentRoot !== dir) return;
  gitIndexPath = resolvedGitIndexPath;
  void watchStart(dir).catch((e) => console.warn("watcher unavailable", e));
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
function setTerminal(on: boolean): void {
  termArea.classList.toggle("hidden", !on);
  hres.classList.toggle("hidden", !on);
  btnTerm.classList.toggle("on", on);
  if (on) {
    if (terminals.count === 0) void terminals.create();
    else requestAnimationFrame(() => terminals.refit());
  }
}
btnTerm.onclick = () => setTerminal(termArea.classList.contains("hidden"));

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
    diffViewer.renderFileList(files, activePath, (path: string) => {
      void viewChangedPath(path);
    });
  } catch (e) {
    // Silently skip on error
  }
}

async function refreshFileSystemState(root: string): Promise<void> {
  await tree.refresh();
  if (currentRoot !== root) return;
  await editor.refreshCleanGitBaselines();
  if (currentRoot !== root) return;
  void refreshGitState(root);
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
const btnSettings = $("btn-settings");
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
const sidebarTitle = $("sidebar-title");
const btnSearchToggle = $("btn-search-toggle");
let searchViewOpen = false;
let searchIconHtml = "";

function openSearchView(): void {
  searchViewOpen = true;
  treeEl.classList.add("hidden");
  searchView.classList.remove("hidden");
  sidebarTitle.textContent = "SEARCH";
  searchIconHtml = btnSearchToggle.innerHTML;
  btnSearchToggle.innerHTML = "←";
  btnSearchToggle.title = "Back to files";
  search.focus();
}

function closeSearchView(): void {
  searchViewOpen = false;
  searchView.classList.add("hidden");
  treeEl.classList.remove("hidden");
  sidebarTitle.textContent = "FILES";
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

// Halts agent-change polling and clears any banner it surfaced.
function stopAgentTrackingPoll(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  hideAgentBanner();
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
    if (aiChanges(next.changes).length > 0) showAgentBanner(next.changes);
    else hideAgentBanner();
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

function bannerBtn(text: string, fn: () => void, tone = "secondary"): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.className = `ai-banner-btn ${tone}`;
  b.onclick = fn;
  return b;
}

function showAgentBanner(changes: AgentChange[]): void {
  banner.innerHTML = "";
  banner.dataset.kind = "agent";
  const mark = document.createElement("span");
  mark.className = "ai-banner-mark";
  mark.innerHTML = icon("trackAI", 16, 1.7);

  const copy = document.createElement("span");
  copy.className = "ai-banner-copy";
  const kicker = document.createElement("span");
  kicker.className = "ai-banner-kicker";
  kicker.textContent = "Agent review";
  const message = document.createElement("span");
  message.className = "ai-banner-message";
  message.textContent = agentBannerText(changes);
  copy.append(kicker, message);

  const actions = document.createElement("span");
  actions.className = "ai-banner-actions";
  actions.append(
    bannerBtn("View", () => {
      const change = firstViewableAgentChange(changes);
      if (change) void viewChangedPath(change.path);
    }, "primary"),
    bannerBtn("Keep", () => {
      if (!currentRoot) return;
      void agentTrackingAccept(currentRoot).then((status) => {
        agentStatus = status;
        hideAgentBanner();
        void refreshDiffFileList();
      });
    }),
    bannerBtn("Revert", () => {
      if (!currentRoot) return;
      void agentTrackingRevert(currentRoot).then(async (result) => {
        await tree.refresh();
        await editor.reloadAllFromDisk();
        await pollAgentChanges();
        if (result.unsafePaths.length || result.errors.length) {
          const unsafe = result.unsafePaths.length
            ? `${result.unsafePaths.length} human-touched file(s) need manual review.`
            : "";
          const errors = result.errors.length ? ` ${result.errors.join("; ")}` : "";
          void alertNative(`${unsafe}${errors}`.trim());
        }
      }).catch((e) => void alertNative(`Revert failed: ${e}`));
    }, "danger"),
  );
  banner.append(
    mark,
    copy,
    actions,
  );
  banner.classList.remove("hidden");
}

function hideAgentBanner(): void {
  if (banner.dataset.kind === "agent") {
    hideBanner();
  }
}

function hideBanner(): void {
  banner.classList.add("hidden");
  banner.innerHTML = "";
  delete banner.dataset.kind;
}

/** One-off error banner (e.g. branch checkout rejected on a dirty tree). */
function showErrorBanner(message: string): void {
  banner.innerHTML = "";
  banner.dataset.kind = "error";
  const span = document.createElement("span");
  span.textContent = message;
  banner.append(span, bannerBtn("Dismiss", hideBanner));
  banner.classList.remove("hidden");
}

// ---- resizers ----
vResizer(vres, sidebar, { min: 120, max: 600, onResize: () => terminals.refit() });
hResizer(hres, termArea, { min: 80, fromEnd: true, onResize: () => terminals.refit() });
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
    setTerminal(termArea.classList.contains("hidden"));
  } else if (mod && e.code === "KeyB") {
    e.preventDefault();
    setSidebar(sidebar.classList.contains("hidden"));
  } else if ((mod && e.code === "KeyP") || (mod && e.shiftKey && e.code === "KeyP")) {
    e.preventDefault();
    palette.open();
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
    setTerminal(termArea.classList.contains("hidden"));
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
btnDiff.innerHTML = icon("diff", 17);
btnBrowser.innerHTML = icon("browser", 17);
btnSettings.innerHTML = icon("settings", 17);
$("btn-back").innerHTML = icon("back", 16);
$("btn-reload").innerHTML = icon("reload", 16);
$("btn-refresh").innerHTML = icon("refresh", 15);
$("btn-search-toggle").innerHTML = icon("search", 15);
$("btn-refresh").onclick = () => void tree.refresh();
btnSearchToggle.onclick = () => toggleSearchView();
btnSettings.onclick = () => openSettings();

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
  toggleTerminal: () => setTerminal(termArea.classList.contains("hidden")),
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
});
workspaceBar.setCurrentWorkspace(null);

gitBar = createGitBar($("gitbar"));
gitBar.onWorktreeSelect = (path: string) => void openWorkspace(path);
gitBar.onBranchSelect = (branch: string) => void switchBranch(branch);

async function refreshGitState(root: string): Promise<void> {
  await editor.refreshCleanGitBaselines();
  await gitBar.refresh(root);
}

// ---- automations ----
automationBar = mountAutomationBar($("automations"), {
  run: (a) => void runAutomation(a),
  openCreate: () => openCreatePanel(),
});

// Run an automation in a free terminal; mark the bar "running" until that terminal idles.
async function runAutomation(a: Automation): Promise<void> {
  setTerminal(true);
  const termId = await terminals.runCommand(a.command).catch(() => null);
  if (!termId) return;
  automationBar.setRunning(true);
  const poll = async (): Promise<void> => {
    const busy = await terminals.isBusyById(termId).catch(() => false);
    if (busy) window.setTimeout(() => void poll(), 1000);
    else automationBar.setRunning(false);
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

// Full-width "New automation" drawer fused under the titlebar (Variant 3).
function openCreatePanel(): void {
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
  title.innerHTML = `${icon("plus", 14)}<span>New automation</span>`;

  const nameField = document.createElement("label");
  nameField.className = "auto-field name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Build";
  nameInput.spellcheck = false;
  nameField.innerHTML = "<span>Name</span>";
  nameField.appendChild(nameInput);

  const cmdField = document.createElement("label");
  cmdField.className = "auto-field cmd";
  const cmdInput = document.createElement("input");
  cmdInput.type = "text";
  cmdInput.placeholder = "npm run tauri build";
  cmdInput.spellcheck = false;
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
    const nameErr = validateName(nameInput.value, automations);
    const cmdErr = validateCommand(cmdInput.value);
    if (nameErr || cmdErr) {
      err.textContent = nameErr ?? cmdErr ?? "";
      (nameErr ? nameInput : cmdInput).focus();
      return;
    }
    void persistAutomation(makeAutomation(nameInput.value, cmdInput.value)).then(close);
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
  hideBanner();
}

// ---- command palette ----
// Named so the settings shortcuts reference can reuse it as the single source of truth.
const paletteCommands = [
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
  { id: "new-automation", title: "New Automation…", run: () => openCreatePanel() },
  { id: "search", title: "Search Folder", run: () => {
    if (!searchViewOpen) openSearchView();
    search.focus();
  }, shortcut: "⇧⌘F" },
  { id: "settings", title: "Settings", run: () => openSettings(), shortcut: "⌘," },
];
palette = mountPalette(paletteCommands);

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

/** Custom input dialog replacing window.prompt() — WKWebView silently returns null for native JS dialogs. */
function promptInput(message: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "prompt-overlay";

    const box = document.createElement("div");
    box.className = "prompt-box";

    const lbl = document.createElement("div");
    lbl.className = "prompt-label";
    lbl.textContent = message;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "prompt-input tree-edit-input";

    const btns = document.createElement("div");
    btns.className = "prompt-btns";

    const btnOk = document.createElement("button");
    btnOk.className = "prompt-btn";
    btnOk.textContent = "OK";

    const btnCancel = document.createElement("button");
    btnCancel.className = "prompt-btn secondary";
    btnCancel.textContent = "Cancel";

    const done = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };

    btnOk.onclick = () => done(input.value.trim() || null);
    btnCancel.onclick = () => done(null);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); done(input.value.trim() || null); }
      if (ev.key === "Escape") { ev.preventDefault(); done(null); }
    });

    btns.append(btnCancel, btnOk);
    box.append(lbl, input, btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
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

// ---- boot ----
applySettings(settings);
editor.renderAllTabs();
setTerminal(true); // panel visible by default → spawns first shell
