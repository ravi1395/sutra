// App entry: instantiates the tree / editor / terminal / diff modules and wires
// the cross-cutting concerns — toolbar toggles, global shortcuts, save + save-as
// (native dialog), pane resizers, and the optional AI-edit tracker.
import { open, save } from "@tauri-apps/plugin-dialog";
import { FileTree } from "./tree";
import { EditorManager, type Tab } from "./editor";
import { TerminalManager } from "./terminal";
import { DiffViewer } from "./diff";
import { vResizer, hResizer } from "./layout";
import { writeFile, fileMtime, readFile, gitHeadContent } from "./ipc";
import { mountMenuBar, type MenuBarHandle } from "./menubar";
import { icon } from "./icons";
import { loadRecents, saveRecents, upsertRecent } from "./workspace";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const tree = new FileTree($("tree"));
const editor = new EditorManager($("editor-host"));
const terminals = new TerminalManager($("term-host"), $("term-tab-list"));
const diffViewer = new DiffViewer();

const tabsEl = $("tabs");
const banner = $("ai-banner");
let menu: MenuBarHandle; // assigned at boot once toggle handlers exist

// ---- tabs ----
function renderTabs(): void {
  tabsEl.innerHTML = "";
  for (const tab of editor.tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (tab === editor.active ? " active" : "");

    const name = document.createElement("span");
    name.textContent = tab.name + (tab.path ? "" : " *");
    const dot = document.createElement("span");
    dot.className = "tab-dirty";
    dot.textContent = tab.dirty ? "●" : "";
    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";

    el.onclick = () => {
      editor.activate(tab);
      tree.setActive(tab.path);
    };
    close.onclick = (e) => {
      e.stopPropagation();
      if (tab.dirty && !confirm(`Discard unsaved changes to ${tab.name}?`)) return;
      editor.closeTab(tab);
    };
    el.append(name, dot, close);
    tabsEl.append(el);
  }
}

editor.onTabsChanged = renderTabs;
editor.onDiffChanged = (hunks, label) => diffViewer.render(hunks, label);
editor.onGutterClick = (idx) => {
  setDiff(true);
  diffViewer.highlightHunk(idx);
};
diffViewer.onRevert = (h) => editor.revertHunk(h);

tree.onOpenFile = async (path) => {
  try {
    await editor.openFile(path);
    tree.setActive(path);
  } catch (e) {
    alert(`Cannot open ${path}: ${e}`);
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
  const content = editor.active === tab ? editor.getContent() : tab.state.doc.toString();
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
    tree.refresh();
    tree.setActive(path);
  }
  editor.recomputeDiff();
}

editor.saveHandler = saveTab;

// ---- workspace open (single path shared by switcher rows, File menu, dialogs) ----
async function openWorkspace(dir: string): Promise<void> {
  if (!confirmWorkspaceClose(dir)) return;
  editor.closeTabsOutsideWorkspace(dir);
  tree.setActive(editor.active?.path ?? null);
  tree.setRoot(dir);
  menu.setCurrentWorkspace(dir);
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
      renderTabs();
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
  } else if (e.ctrlKey && e.key === "`") {
    e.preventDefault();
    setTerminal(termArea.classList.contains("hidden"));
  }
});

// ---- chrome: icon buttons + menu bar ----
btnTrack.innerHTML = icon("trackAI", 17);
btnTerm.innerHTML = icon("terminal", 17);
btnDiff.innerHTML = icon("diff", 17);

menu = mountMenuBar($("titlebar"), {
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
  switchWorkspace: (path) => void openWorkspace(path),
  addFolder: () => void openFolderDialog(),
});
menu.setCurrentWorkspace(null);

// ---- boot ----
renderTabs();
setTerminal(true); // panel visible by default → spawns first shell
