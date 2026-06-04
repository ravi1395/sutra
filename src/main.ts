// App entry: instantiates the tree / editor / terminal / diff modules and wires
// the cross-cutting concerns — toolbar toggles, global shortcuts, save + save-as
// (native dialog), pane resizers, and integrated-agent workspace tracking.
import { open, save } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./tree";
import {
  FILE_DRAG_TYPE,
  SPLIT_DROP_TARGET_OPTIONS,
  dragHasType,
  setSplitDropHint,
  splitSideFromClientX,
} from "./split-drop";
import { EditorManager, type Tab } from "./editor";
import { SearchPanel } from "./search";
import { TerminalManager } from "./terminal";
import { DiffViewer } from "./diff";
import { BrowserPane } from "./browser";
import { vResizer, hResizer } from "./layout";
import {
  agentTrackingAccept,
  agentTrackingPoll,
  agentTrackingRevert,
  writeFile,
  fileMtime,
  gitHeadContent,
  renamePath,
  deletePath,
  createDir,
  movePath,
  gitChangedFiles,
  gitCheckout,
  type AgentChange,
  type AgentTrackingStatus,
} from "./ipc";
import { agentBannerText, firstViewableAgentChange, mergeChangedFiles } from "./agent-tracking";
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
import { loadRecents, saveRecents, upsertRecent } from "./workspace";
import { GLOBAL_SHORTCUT_OPTIONS, isPreviewShortcut } from "./shortcuts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

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

const banner = $("ai-banner");
let workspaceBar: WorkspaceBarHandle; // assigned at boot once toggle handlers exist
let palette: PaletteHandle; // assigned at boot once all actions are defined
let gitBar: GitBarHandle; // assigned at boot
let automationBar: AutomationBarHandle; // assigned at boot
let automations: Automation[] = []; // per-project automations for the current root
let currentRoot: string | null = null; // track opened workspace
let agentStatus: AgentTrackingStatus = { enabled: false, agentActive: false, changes: [] };

// ---- tabs (each pane renders its own strip; main wires cross-cutting hooks) ----
editor.onDiffChanged = (hunks, label) => diffViewer.render(hunks, label);
editor.onGutterClick = (idx) => {
  setDiff(true);
  diffViewer.highlightHunk(idx);
};
editor.onActiveTabChanged = (tab) => tree.setActive(tab?.path ?? null);
editor.confirmCloseTab = (tab) =>
  !tab.dirty || confirm(`Discard unsaved changes to ${tab.name}?`);
diffViewer.onRevert = (h) => editor.revertHunk(h);

tree.onOpenFile = async (path) => {
  try {
    await editor.openFile(path);
    tree.setActive(path);
  } catch (e) {
    alert(`Cannot open ${path}: ${e}`);
  }
};
tree.onOpenFileInPane = (path, side) => {
  void editor
    .openFileInSide(path, side)
    .then(() => tree.setActive(path))
    .catch((e) => alert(`Cannot open ${path}: ${e}`));
};

// Tree context menu actions
tree.onRename = async (path: string, newName: string) => {
  try {
    await renamePath(path, newName);
    // Update open tabs with renamed path
    const parent = path.split("/").slice(0, -1).join("/");
    const newPath = parent ? parent + "/" + newName : newName;
    for (const tab of editor.tabs) {
      if (tab.path === path) {
        editor.markSaved(tab, newPath, newName, null);
      }
    }
    await tree.refresh();
  } catch (e) {
    alert(`Rename failed: ${e}`);
  }
};

tree.onDelete = async (path: string) => {
  if (!confirm(`Delete "${path.split("/").pop()}"?`)) return;
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
    alert(`Delete failed: ${e}`);
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
    alert(`Create ${type} failed: ${e}`);
  }
};

tree.onMove = async (src: string, destDir: string) => {
  try {
    // Compute destination path: destDir + "/" + basename(src)
    const srcBaseName = src.split("/").pop() || src;
    const destPath = destDir + "/" + srcBaseName;
    await movePath(src, destPath);
    // Update open tabs with moved path
    const srcPrefix = src.endsWith("/") ? src : src + "/";
    for (const tab of editor.tabs.slice()) {
      if (tab.path === src) {
        editor.markSaved(tab, destPath, srcBaseName, null);
      } else if (tab.path && tab.path.startsWith(srcPrefix)) {
        // Move children: /old/child -> /new/child
        const relPath = tab.path.slice(srcPrefix.length);
        const newPath = destPath + "/" + relPath;
        editor.markSaved(tab, newPath, tab.name, null);
      }
    }
    await tree.refresh();
  } catch (e) {
    alert(`Move failed: ${e}`);
  }
};

// ---- save / save-as ----
function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function confirmWorkspaceClose(dir: string): boolean {
  const dirtyTabs = editor.tabsOutsideWorkspace(dir).filter((tab) => tab.dirty);
  if (dirtyTabs.length === 0) return true;

  const names = dirtyTabs.slice(0, 5).map((tab) => tab.name).join(", ");
  const more = dirtyTabs.length > 5 ? `, +${dirtyTabs.length - 5} more` : "";
  return confirm(`Discard unsaved changes outside this folder? ${names}${more}`);
}

async function saveTab(tab: Tab, forceDialog = false): Promise<void> {
  const prevPath = tab.path;
  let path = prevPath;
  if (!path || forceDialog) {
    const chosen = await save({ defaultPath: path ?? terminals.cwd ?? undefined });
    if (!chosen) return;
    path = chosen;
  }
  const content = editor.contentOf(tab);
  try {
    await writeFile(path, content);
  } catch (e) {
    alert(`Save failed: ${e}`);
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
  if (currentRoot) void gitBar.refresh(currentRoot);
  editor.recomputeDiff();
}

editor.saveHandler = saveTab;

// ---- workspace open (single path shared by switcher rows, File menu, dialogs) ----
async function openWorkspace(dir: string): Promise<void> {
  if (!confirmWorkspaceClose(dir)) return;
  editor.closeTabsOutsideWorkspace(dir);
  editor.setWorkspaceRoot(dir);
  currentRoot = dir;
  agentStatus = { enabled: false, agentActive: false, changes: [] };
  tree.setActive(editor.active?.path ?? null);
  await tree.setRoot(dir);
  search.setRoot(dir);
  workspaceBar.setCurrentWorkspace(dir);
  hideBanner();
  await terminals.reset(dir, !termArea.classList.contains("hidden"));
  saveRecents(upsertRecent(loadRecents(), dir, Date.now()));
  void gitBar.refresh(dir);
  automations = await loadAutomations(dir);
  automationBar.setAutomations(automations);
  startAgentTrackingPoll();
  void pollAgentChanges();
}

async function openFolderDialog(): Promise<void> {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir === "string") await openWorkspace(dir);
}

function closeActiveTab(): void {
  const a = editor.active;
  if (!a) return;
  if (!a.dirty || confirm(`Discard unsaved changes to ${a.name}?`)) editor.closeTab(a);
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
  try {
    const gitFiles = await gitChangedFiles(currentRoot);
    const files = mergeChangedFiles(gitFiles, agentStatus.changes);
    const activePath = editor.active?.path ?? null;
    diffViewer.renderFileList(files, activePath, (path: string) => {
      void viewChangedPath(path);
    });
  } catch (e) {
    // Silently skip on error
  }
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
    .catch((e) => alert(`Preview failed: ${e instanceof Error ? e.message : e}`));
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

async function pollAgentChanges(): Promise<void> {
  if (!currentRoot) return;
  const root = currentRoot;
  try {
    const next = await agentTrackingPoll(currentRoot);
    if (currentRoot !== root) return;
    agentStatus = next;
    if (next.changes.length > 0) showAgentBanner(next.changes);
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

function bannerBtn(text: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = fn;
  return b;
}

function showAgentBanner(changes: AgentChange[]): void {
  banner.innerHTML = "";
  banner.dataset.kind = "agent";
  const span = document.createElement("span");
  span.textContent = agentBannerText(changes);
  banner.append(
    span,
    bannerBtn("View", () => {
      const change = firstViewableAgentChange(changes);
      if (change) void viewChangedPath(change.path);
    }),
    bannerBtn("Keep AI changes", () => {
      if (!currentRoot) return;
      void agentTrackingAccept(currentRoot).then((status) => {
        agentStatus = status;
        hideAgentBanner();
        void refreshDiffFileList();
      });
    }),
    bannerBtn("Revert agent changes", () => {
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
          alert(`${unsafe}${errors}`.trim());
        }
      }).catch((e) => alert(`Revert failed: ${e}`));
    }),
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
    closeActiveTab();
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
    if (editor.isSplit) editor.closeSplit();
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
  }
}, GLOBAL_SHORTCUT_OPTIONS);

// ---- chrome: icon buttons + menu bar ----
btnTerm.innerHTML = icon("terminal", 17);
btnDiff.innerHTML = icon("diff", 17);
btnBrowser.innerHTML = icon("browser", 17);
$("btn-back").innerHTML = icon("back", 16);
$("btn-reload").innerHTML = icon("reload", 16);
$("btn-refresh").innerHTML = icon("refresh", 15);
$("btn-search-toggle").innerHTML = icon("search", 15);
$("btn-refresh").onclick = () => void tree.refresh();
btnSearchToggle.onclick = () => toggleSearchView();

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
  closeTab: () => closeActiveTab(),
  toggleTerminal: () => setTerminal(termArea.classList.contains("hidden")),
  toggleDiff: () => setDiff(diffPane.classList.contains("hidden")),
  toggleBrowser: () => setBrowser(browserArea.classList.contains("hidden")),
  toggleSidebar: () => setSidebar(sidebar.classList.contains("hidden")),
  newTerminal: () => void terminals.create(),
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
  void gitBar.refresh(currentRoot);
  editor.recomputeDiff();
  hideBanner();
}

// ---- command palette ----
palette = mountPalette([
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
    if (editor.isSplit) editor.closeSplit();
    else editor.openSplit();
  }, shortcut: "⌘\\" },
  { id: "new-terminal", title: "New Terminal", run: actions.newTerminal },
  { id: "new-automation", title: "New Automation…", run: () => openCreatePanel() },
  { id: "search", title: "Search Folder", run: () => {
    if (!searchViewOpen) openSearchView();
    search.focus();
  }, shortcut: "⇧⌘F" },
]);

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

// ---- boot ----
editor.renderAllTabs();
setTerminal(true); // panel visible by default → spawns first shell
