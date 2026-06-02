// App entry: instantiates the tree / editor / terminal / diff modules and wires
// the cross-cutting concerns — toolbar toggles, global shortcuts, save + save-as
// (native dialog), pane resizers, and the optional AI-edit tracker.
import { open, save } from "@tauri-apps/plugin-dialog";
import { FileTree, paneSideFromClientX } from "./tree";
import { EditorManager, type Tab } from "./editor";
import { SearchPanel } from "./search";
import { TerminalManager } from "./terminal";
import { DiffViewer } from "./diff";
import { vResizer, hResizer } from "./layout";
import { writeFile, fileMtime, readFile, gitHeadContent, renamePath, deletePath, createDir, movePath } from "./ipc";
import { mountWorkspaceBar, type WorkspaceBarHandle } from "./menubar";
import { mountPalette, type PaletteHandle } from "./palette";
import { icon } from "./icons";
import { loadRecents, saveRecents, upsertRecent } from "./workspace";
import { GLOBAL_SHORTCUT_OPTIONS, isPreviewShortcut } from "./shortcuts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const tree = new FileTree($("tree"));
const editor = new EditorManager($("panes"));
const terminals = new TerminalManager($("term-host"), $("term-tab-list"));
const diffViewer = new DiffViewer();
const search = new SearchPanel(
  $<HTMLInputElement>("search-input"),
  $<HTMLButtonElement>("search-case"),
  $("search-results"),
);
search.onOpenMatch = (p, line) => { void editor.openFile(p, line); tree.setActive(p); };

const banner = $("ai-banner");
let workspaceBar: WorkspaceBarHandle; // assigned at boot once toggle handlers exist
let palette: PaletteHandle; // assigned at boot once all actions are defined

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
  const name = prompt(`New ${type} name:`);
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
  editor.recomputeDiff();
}

editor.saveHandler = saveTab;

// ---- workspace open (single path shared by switcher rows, File menu, dialogs) ----
async function openWorkspace(dir: string): Promise<void> {
  if (!confirmWorkspaceClose(dir)) return;
  editor.closeTabsOutsideWorkspace(dir);
  editor.setWorkspaceRoot(dir);
  tree.setActive(editor.active?.path ?? null);
  await tree.setRoot(dir);
  search.setRoot(dir);
  workspaceBar.setCurrentWorkspace(dir);
  hideBanner();
  await terminals.reset(dir, !termArea.classList.contains("hidden"));
  saveRecents(upsertRecent(loadRecents(), dir, Date.now()));
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
$("term-add").onclick = () => void terminals.create();

// ---- diff toggle ----
const diffPane = $("diff-pane");
const diffRes = $("diff-resizer");
const btnDiff = $("btn-diff");
function setDiff(on: boolean): void {
  diffPane.classList.toggle("hidden", !on);
  diffRes.classList.toggle("hidden", !on);
  btnDiff.classList.toggle("on", on);
  if (on) editor.recomputeDiff();
}
btnDiff.onclick = () => setDiff(diffPane.classList.contains("hidden"));
$("diff-close").onclick = () => setDiff(false);

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

// ---- AI-edit tracking ----
const btnTrack = $("btn-track");
let tracking = false;
let pollTimer: number | undefined;

function setTracking(on: boolean): void {
  tracking = on;
  btnTrack.classList.toggle("on", on);
  if (on) {
    // baseline current mtimes so only future external edits trip the tracker
    for (const t of editor.tabs) if (t.path) void fileMtime(t.path).then((m) => (t.lastMtime = m));
    pollTimer = window.setInterval(checkExternal, 1500);
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}
btnTrack.onclick = () => setTracking(!tracking);

async function checkExternal(): Promise<void> {
  for (const tab of editor.tabs) {
    if (!tab.path) continue;
    let mt: number;
    try {
      mt = await fileMtime(tab.path);
    } catch {
      continue;
    }
    if (tab.lastMtime == null) {
      tab.lastMtime = mt;
      continue;
    }
    if (mt <= tab.lastMtime) continue;
    tab.lastMtime = mt;
    let disk: string;
    try {
      disk = await readFile(tab.path);
    } catch {
      continue;
    }
    const buf = editor.active === tab ? editor.getContent() : tab.state.doc.toString();
    if (disk === buf) continue; // already in sync (e.g. our own save)
    onExternalEdit(tab, buf, disk);
  }
}

function onExternalEdit(tab: Tab, oldBuf: string, disk: string): void {
  tab.override = oldBuf; // diff baseline = pre-AI content
  tab.savedContent = disk;
  tab.dirty = false;
  editor.activate(tab);
  editor.setContent(disk); // show the AI version; recompute uses override baseline
  setDiff(true);
  showAiBanner(tab);
}

function bannerBtn(text: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  b.onclick = fn;
  return b;
}

function showAiBanner(tab: Tab): void {
  banner.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = `External edit detected in ${tab.name} (Claude/Codex). Review in the diff viewer.`;
  banner.append(
    span,
    bannerBtn("View", () => {
      editor.activate(tab);
      setDiff(true);
    }),
    bannerBtn("Keep AI changes", () => {
      tab.override = null;
      editor.recomputeDiff();
      hideBanner();
    }),
    bannerBtn("Revert to mine", async () => {
      const mine = tab.override ?? "";
      editor.activate(tab);
      editor.setContent(mine);
      tab.savedContent = mine;
      tab.override = null;
      try {
        await writeFile(tab.path!, mine);
        tab.lastMtime = await fileMtime(tab.path!).catch(() => tab.lastMtime);
      } catch (e) {
        alert(`Revert failed: ${e}`);
      }
      tab.dirty = false;
      editor.recomputeDiff();
      editor.renderAllTabs();
      hideBanner();
    }),
  );
  banner.classList.remove("hidden");
}
function hideBanner(): void {
  banner.classList.add("hidden");
  banner.innerHTML = "";
}

// ---- resizers ----
vResizer(vres, sidebar, { min: 120, max: 600 });
hResizer(hres, termArea, { min: 80, fromEnd: true, onResize: () => terminals.refit() });
vResizer(diffRes, diffPane, { min: 220, fromEnd: true });
window.addEventListener("resize", () => terminals.refit());

// ---- file-tree drag to editor split ----
const panesEl = $("panes");

function hasTreeFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("application/x-sutra-file");
}

function setPaneDropHint(side: "left" | "right" | null): void {
  panesEl.classList.toggle("drop-left", side === "left");
  panesEl.classList.toggle("drop-right", side === "right");
}

panesEl.addEventListener("dragover", (e) => {
  if (!hasTreeFileDrag(e)) return;
  e.preventDefault();
  const side = paneSideFromClientX(e.clientX, panesEl.getBoundingClientRect());
  e.dataTransfer!.dropEffect = "copy";
  setPaneDropHint(side);
});
panesEl.addEventListener("dragleave", (e) => {
  const next = e.relatedTarget;
  if (!(next instanceof Node) || !panesEl.contains(next)) setPaneDropHint(null);
});
panesEl.addEventListener("drop", (e) => {
  const path = e.dataTransfer?.getData("application/x-sutra-file");
  if (!path) return;
  e.preventDefault();
  const side = paneSideFromClientX(e.clientX, panesEl.getBoundingClientRect());
  setPaneDropHint(null);
  tree.onOpenFileInPane?.(path, side);
});

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
btnTrack.innerHTML = icon("trackAI", 17);
btnTerm.innerHTML = icon("terminal", 17);
btnDiff.innerHTML = icon("diff", 17);
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
  toggleSidebar: () => setSidebar(sidebar.classList.contains("hidden")),
  toggleTrackAI: () => setTracking(!tracking),
  newTerminal: () => void terminals.create(),
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
  { id: "toggle-sidebar", title: "Toggle Sidebar", run: actions.toggleSidebar, shortcut: "⌘B" },
  { id: "toggle-split", title: "Toggle Split", run: () => {
    if (editor.isSplit) editor.closeSplit();
    else editor.openSplit();
  }, shortcut: "⌘\\" },
  { id: "toggle-ai-track", title: "Track AI Edits", run: actions.toggleTrackAI },
  { id: "new-terminal", title: "New Terminal", run: actions.newTerminal },
  { id: "search", title: "Search Folder", run: () => {
    if (!searchViewOpen) openSearchView();
    search.focus();
  }, shortcut: "⇧⌘F" },
]);

// ---- boot ----
editor.renderAllTabs();
setTerminal(true); // panel visible by default → spawns first shell
