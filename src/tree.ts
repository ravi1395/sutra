// File tree with VS Code-style compact folders. Single-subfolder chains arrive
// pre-collapsed from Rust (label `a/b/c`, path = deepest dir), so expanding one
// node reveals real content instead of a corridor of empty folders.
// Also exports OutlineView for the Files/Outline sidebar toggle.
import { listDir, gitStatus, fileMtime, type Entry, type GitStatusEntry, type DocumentSymbol } from "./ipc";
import { showContextMenu } from "./contextmenu";
import { icon } from "./icons";
import {
  FILE_DRAG_TYPE,
  TREE_ENTRY_DRAG_TYPE,
  splitSideFromClientX,
  type SplitDropSide,
} from "./split-drop";

export interface FileTypeMeta {
  icon: string;
  className: string;
}

const fileTypeByExt: Record<string, FileTypeMeta> = {
  css: { icon: "CSS", className: "type-css" },
  go: { icon: "GO", className: "type-go" },
  html: { icon: "<>", className: "type-html" },
  htm: { icon: "<>", className: "type-html" },
  java: { icon: "JV", className: "type-java" },
  js: { icon: "JS", className: "type-js" },
  jsx: { icon: "JSX", className: "type-js" },
  json: { icon: "{}", className: "type-json" },
  md: { icon: "MD", className: "type-md" },
  markdown: { icon: "MD", className: "type-md" },
  py: { icon: "PY", className: "type-py" },
  rb: { icon: "RB", className: "type-rb" },
  rs: { icon: "RS", className: "type-rs" },
  sql: { icon: "SQL", className: "type-sql" },
  ts: { icon: "TS", className: "type-ts" },
  tsx: { icon: "TSX", className: "type-ts" },
};

export function fileTypeMeta(name: string, isDir = false): FileTypeMeta {
  if (isDir) return { icon: "DIR", className: "type-folder" };
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? name.toLowerCase();
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  return fileTypeByExt[ext] ?? { icon: "TXT", className: "type-file" };
}

/** Validate a new file/folder name (may be a nested path). Returns an error
 *  string to show inline, or null when the name is acceptable. Sibling-conflict
 *  is only checked for simple (non-nested) names; nested paths merge into
 *  existing folders and are conflict-checked authoritatively at commit time. */
export function validateNewName(name: string, siblingNames: string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name cannot be empty.";
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return "Invalid name.";
  if (trimmed.includes("\0")) return "Invalid name.";
  const segs = trimmed.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return "Invalid name.";
  }
  if (segs.length === 1 && siblingNames.includes(trimmed)) {
    return `A file or folder "${trimmed}" already exists here.`;
  }
  return null;
}

/** Resolve the directory a header-button create should target: the selected
 *  directory itself, the parent of a selected file, or the root when nothing
 *  is selected. */
export function resolveCreateTargetDir(
  selectedPath: string | null,
  selectedIsDir: boolean,
  root: string,
): string {
  if (!selectedPath) return root;
  if (selectedIsDir) return selectedPath;
  return selectedPath.split("/").slice(0, -1).join("/");
}

/** Return absolute path prefixes needed to expand ancestors for `path`. */
export function ancestorPathsForReveal(path: string): string[] {
  const out: string[] = [];
  let prefix = "";
  for (const seg of path.split("/")) {
    if (!seg) {
      prefix = "/";
      continue;
    }
    prefix = prefix === "/" || prefix === "" ? `/${seg}` : `${prefix}/${seg}`;
    out.push(prefix);
  }
  return out;
}

export type TreePaneSide = SplitDropSide;
export const paneSideFromClientX = splitSideFromClientX;
type TreeContainer = HTMLElement | DocumentFragment;

export class FileTree {
  private el: HTMLElement;
  private root: string | null = null;
  private expanded = new Set<string>();
  private activePath: string | null = null;
  private selectedPath: string | null = null;
  private selectedIsDir = false;
  private status = new Map<string, "M" | "A" | "D">();
  private changedDirs = new Set<string>();
  private deletedDirs = new Set<string>(); // dirs containing deleted entries (visible signal while collapsed)
  private renderSeq = 0;
  onOpenFile?: (path: string) => void;
  onOpenFileInPane?: (path: string, side: TreePaneSide) => void;
  onRename?: (path: string, newName: string) => void;
  onDelete?: (path: string) => void;
  onCreate?: (parentDir: string, name: string, isDir: boolean) => Promise<void>;
  onMove?: (src: string, destDir: string) => void;

  constructor(el: HTMLElement) {
    this.el = el;
    // Right-click on empty tree space (not a row) creates at the workspace root.
    this.el.addEventListener("contextmenu", (ev) => {
      if ((ev.target as HTMLElement).closest(".tree-row")) return; // row menu handles it
      if (!this.root) return;
      ev.preventDefault();
      showContextMenu(
        ev.clientX,
        ev.clientY,
        [
          { label: "New File", action: () => void this.beginCreate(this.root!, false) },
          { label: "New Folder", action: () => void this.beginCreate(this.root!, true) },
        ],
        this.el,
      );
    });
  }

  async setRoot(path: string): Promise<void> {
    this.root = path;
    this.expanded.clear();
    this.expanded.add(path);
    this.selectedPath = null;
    this.selectedIsDir = false;
    await this.loadStatus();
    await this.render();
    if (this.root !== path) return;
    this.el.scrollTop = 0; // a fresh root starts at the top, not the prior tree's offset
  }

  private async loadStatus(): Promise<void> {
    this.status.clear();
    this.changedDirs.clear();
    this.deletedDirs.clear();
    if (!this.root) return;
    let entries: GitStatusEntry[];
    try {
      entries = await gitStatus(this.root);
    } catch {
      return;
    }
    const rootPrefix = this.root.endsWith("/") ? this.root : this.root + "/";
    for (const e of entries) {
      this.status.set(e.path, e.status);
      if (e.path.startsWith(rootPrefix)) {
        const parts = e.path.slice(rootPrefix.length).split("/");
        let cur = this.root;
        for (let i = 0; i < parts.length - 1; i++) {
          cur = cur + "/" + parts[i];
          this.changedDirs.add(cur);
          if (e.status === "D") this.deletedDirs.add(cur);
        }
      }
    }
  }

  setActive(path: string | null): void {
    this.activePath = path;
    this.el.querySelectorAll(".tree-row.active").forEach((e) => e.classList.remove("active"));
    if (path) {
      this.el
        .querySelector<HTMLElement>(`.tree-row[data-path="${cssEscape(path)}"]`)
        ?.classList.add("active");
    }
  }

  async render(): Promise<void> {
    const root = this.root;
    if (!root) {
      this.el.replaceChildren();
      return;
    }
    const seq = ++this.renderSeq;
    const prevScroll = this.el.scrollTop;
    const fragment = document.createDocumentFragment();
    if (!(await this.renderDir(root, 0, fragment, seq, root))) return;
    if (!this.isCurrentRender(seq, root)) return;
    this.el.replaceChildren(fragment);
    this.el.scrollTop = prevScroll; // browser clamps if content shrank
  }

  /** Expand every ancestor of `path`, activate it, and re-render the tree. */
  async reveal(path: string): Promise<void> {
    if (!this.root) return;
    for (const ancestor of ancestorPathsForReveal(path)) {
      this.expanded.add(ancestor);
    }
    await this.render();
    this.setActive(path);
  }

  /** Directory a header-button create targets (selected dir, file's parent, or root). */
  targetDirForCreate(): string {
    return resolveCreateTargetDir(this.selectedPath, this.selectedIsDir, this.root ?? "");
  }

  /** Start inline creation of a file/folder inside `parentDir`. Shows a focused
   *  input row; Enter commits (with validation), Esc/blur cancels. */
  async beginCreate(parentDir: string, isDir: boolean): Promise<void> {
    if (!this.root) return;
    this.expanded.add(parentDir);
    await this.render();

    const siblingNames = Array.from(
      this.el.querySelectorAll<HTMLElement>(".tree-row"),
    )
      .map((r) => r.dataset.path ?? "")
      .filter(
        (p) =>
          p &&
          p.startsWith(parentDir + "/") &&
          !p.slice(parentDir.length + 1).includes("/"),
      )
      .map((p) => p.slice(parentDir.length + 1));

    const parentRow = this.el.querySelector<HTMLElement>(
      `.tree-row[data-path="${cssEscape(parentDir)}"]`,
    );
    const depth =
      parentDir === this.root
        ? 0
        : Math.round((parseFloat(parentRow?.style.paddingLeft || "14") - 14) / 12) + 1;

    const wrap = document.createElement("div");
    wrap.className = "tree-create-wrap";

    const inputRow = document.createElement("div");
    inputRow.className = "tree-row " + (isDir ? "dir" : "file");
    inputRow.style.paddingLeft = `${depth * 12 + 14}px`;
    const meta = fileTypeMeta(isDir ? "" : "x", isDir);
    const iconEl = document.createElement("span");
    iconEl.className = `tree-icon ${meta.className}`;
    iconEl.textContent = meta.icon;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tree-edit-input";
    input.style.width = "100%";
    inputRow.append(iconEl, input);

    const errEl = document.createElement("div");
    errEl.className = "tree-create-error";
    errEl.style.paddingLeft = `${depth * 12 + 14}px`;
    errEl.style.display = "none";

    wrap.append(inputRow, errEl);

    // Insert as the first child entry of the parent (or top of tree for root).
    if (parentRow && parentRow.nextSibling) {
      parentRow.parentElement!.insertBefore(wrap, parentRow.nextSibling);
    } else {
      this.el.insertBefore(wrap, this.el.firstChild);
    }
    input.focus();

    const cleanup = () => {
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      wrap.remove();
    };
    const showError = (msg: string) => {
      errEl.textContent = msg;
      errEl.style.display = "";
    };

    const commit = async () => {
      const name = input.value.trim();
      const syncErr = validateNewName(name, siblingNames);
      if (syncErr) {
        showError(syncErr);
        return;
      }
      const fullPath = parentDir + "/" + name;
      if (await this.pathExists(fullPath)) {
        showError(`A file or folder "${name}" already exists here.`);
        return;
      }
      try {
        await this.onCreate?.(parentDir, name, isDir);
      } catch (err) {
        showError(String(err));
        return;
      }
      cleanup();
      await this.refresh();
      await this.reveal(fullPath);
      this.selectedPath = fullPath;
      this.selectedIsDir = isDir;
      if (!isDir) this.onOpenFile?.(fullPath);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cleanup();
      } else {
        errEl.style.display = "none"; // clear error on next keystroke
      }
    };
    const onBlur = () => cleanup();

    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
  }

  /** Existence probe via file_mtime (resolves for existing paths). */
  private async pathExists(path: string): Promise<boolean> {
    return fileMtime(path).then(
      () => true,
      () => false,
    );
  }

  private async renderDir(
    path: string,
    depth: number,
    container: TreeContainer,
    renderSeq: number,
    renderRoot: string,
  ): Promise<boolean> {
    if (!this.isCurrentRender(renderSeq, renderRoot)) return false;
    let entries: Entry[];
    try {
      entries = await listDir(path);
    } catch {
      return true;
    }
    if (!this.isCurrentRender(renderSeq, renderRoot)) return false;
    const seen = new Set(entries.map((e) => e.path));
    entries = entries.concat(this.deletedEntriesForDir(path, seen));
    for (const e of entries) {
      const row = this.makeRow(e, depth);
      container.appendChild(row);
      if (e.isDir) {
        const childBox = document.createElement("div");
        container.appendChild(childBox);
        if (this.expanded.has(e.path)) {
          if (!(await this.renderDir(e.path, depth + 1, childBox, renderSeq, renderRoot))) {
            return false;
          }
        }
      }
    }
    return true;
  }

  private isCurrentRender(renderSeq: number, renderRoot: string): boolean {
    return renderSeq === this.renderSeq && this.root === renderRoot;
  }

  private deletedEntriesForDir(path: string, seen: Set<string>): Entry[] {
    const prefix = path.endsWith("/") ? path : path + "/";
    const deleted: Entry[] = [];
    for (const [statusPath, status] of this.status) {
      if (status !== "D" || seen.has(statusPath) || !statusPath.startsWith(prefix)) continue;
      const name = statusPath.slice(prefix.length);
      if (!name) continue;
      if (name.includes("/") && seen.has(prefix + name.split("/")[0])) continue;
      deleted.push({ name, path: statusPath, isDir: false });
    }
    return deleted.sort((a, b) => a.name.localeCompare(b.name));
  }

  private makeRow(e: Entry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = `tree-row ${e.isDir ? "dir" : "file"}`;
    row.dataset.path = e.path;
    row.style.paddingLeft = `calc(${depth * 12 + 14}px - var(--tree-active-stitch, 0px))`;

    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    twisty.textContent = e.isDir ? (this.expanded.has(e.path) ? "▾" : "▸") : "";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = e.name;
    const meta = fileTypeMeta(e.name, e.isDir);
    const icon = document.createElement("span");
    icon.className = `tree-icon ${meta.className}`;
    icon.textContent = meta.icon;
    icon.title = e.isDir ? "Folder" : `${meta.icon} file`;
    row.append(twisty, icon, label);

    if (!e.isDir && this.status.has(e.path)) {
      const s = this.status.get(e.path)!;
      const cls = s === "M" ? "modified" : s === "A" ? "added" : "deleted";
      row.classList.add(`status-${cls}`);
      const dot = document.createElement("span");
      dot.className = `tree-dot ${cls}`;
      row.appendChild(dot);
    } else if (e.isDir && this.changedDirs.has(e.path)) {
      row.classList.add("status-dir-changed");
      const dot = document.createElement("span");
      // Deleted-in-dir wins: a collapsed folder's dot is the only signal for deletions inside.
      dot.className = `tree-dot ${this.deletedDirs.has(e.path) ? "deleted" : "modified"}`;
      row.appendChild(dot);
    }

    if (e.path === this.activePath) row.classList.add("active");

    // Drag source: files and directories can be dragged
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.effectAllowed = e.isDir ? "move" : "copyMove";
      ev.dataTransfer.setData(TREE_ENTRY_DRAG_TYPE, e.path);
      ev.dataTransfer.setData("text/plain", e.path);
      if (!e.isDir) ev.dataTransfer.setData(FILE_DRAG_TYPE, e.path);
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));

    // Drop target: directories accept drops (ignore drops onto self/ancestor/descendant)
    if (e.isDir) {
      row.addEventListener("dragover", (ev) => {
        const src = ev.dataTransfer?.getData(TREE_ENTRY_DRAG_TYPE);
        if (!src) return;
        // Reject drops onto self or a descendant
        if (src === e.path || src.startsWith(e.path + "/")) return;
        ev.preventDefault();
        ev.dataTransfer!.dropEffect = "move";
        row.classList.add("drop-target");
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drop-target");
      });
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove("drop-target");
        const src = ev.dataTransfer?.getData(TREE_ENTRY_DRAG_TYPE);
        if (!src || src === e.path || src.startsWith(e.path + "/")) return;
        this.onMove?.(src, e.path);
      });
    }

    row.onclick = () => {
      this.selectedPath = e.path;
      this.selectedIsDir = e.isDir;
      if (e.isDir) {
        if (this.expanded.has(e.path)) this.expanded.delete(e.path);
        else this.expanded.add(e.path);
        void this.render();
      } else {
        this.onOpenFile?.(e.path);
      }
    };

    // Context menu on right-click
    row.oncontextmenu = (ev) => {
      ev.preventDefault();
      showContextMenu(
        ev.clientX,
        ev.clientY,
        [
          {
            label: "Rename",
            action: () => this.startInlineEdit(label, e.path, e.name),
          },
          {
            label: "Delete",
            action: () => this.onDelete?.(e.path),
            danger: true,
          },
          {
            label: "New File",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, false);
            },
          },
          {
            label: "New Folder",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, true);
            },
          },
        ],
        this.el,
      );
    };

    return row;
  }

  /** Start inline editing of a tree label; commit on Enter/blur. */
  private startInlineEdit(
    labelEl: HTMLElement,
    path: string,
    currentName: string,
  ): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tree-edit-input";
    input.value = currentName;
    input.style.width = "100%";

    const commit = async () => {
      input.removeEventListener("blur", commit);
      input.removeEventListener("keydown", onKeyDown);
      const newName = input.value.trim();
      labelEl.textContent = currentName; // restore original
      if (newName && newName !== currentName) {
        this.onRename?.(path, newName);
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        input.removeEventListener("blur", commit);
        input.removeEventListener("keydown", onKeyDown);
        labelEl.textContent = currentName;
      }
    };

    labelEl.textContent = "";
    labelEl.appendChild(input);
    input.focus();
    input.select();
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", onKeyDown);
  }

  /** Re-read the tree from disk (after a new file is saved). */
  async refresh(): Promise<void> {
    await this.loadStatus();
    await this.render();
  }
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Outline view: toggleable sidebar panel showing DocumentSymbol tree.
// Reuses the same tree-row/tree-icon/tree-label CSS classes as FileTree.
// ---------------------------------------------------------------------------

/**
 * Outline sidebar view — renders the DocumentSymbol tree for the active file.
 * Handles the Files/Outline toggle and delegates navigation to the editor.
 */
export class OutlineView {
  private toggleBar: HTMLElement;
  private contentEl: HTMLElement;
  private filesBtn: HTMLButtonElement;
  private outlineBtn: HTMLButtonElement;
  private mode: "files" | "outline" = "files";
  private symbols: DocumentSymbol[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Callback: navigate editor to a symbol's selection range start line (1-based). */
  onRevealLine?: (path: string, line: number) => void;

  constructor(
    _sidebarEl: HTMLElement,
    private treeEl: HTMLElement,
    private getActivePath: () => string | null,
    private fetchSymbols: () => Promise<DocumentSymbol[] | null>,
  ) {
    // Build a toggle bar above the existing tree container.
    this.toggleBar = document.createElement("div");
    this.toggleBar.className = "outline-toggle-bar";

    // Icon + label markup mirrors the file-tree row vocabulary (mono, gutter-aligned).
    this.filesBtn = document.createElement("button");
    this.filesBtn.className = "outline-tab active";
    this.filesBtn.innerHTML = `${icon("folder", 14)}<span>Files</span>`;
    this.filesBtn.onclick = () => this.setMode("files");

    this.outlineBtn = document.createElement("button");
    this.outlineBtn.className = "outline-tab";
    this.outlineBtn.innerHTML = `${icon("list", 14)}<span>Outline</span>`;
    this.outlineBtn.onclick = () => this.setMode("outline");

    this.toggleBar.append(this.filesBtn, this.outlineBtn);

    // Outline content area (sits alongside treeEl, shown/hidden by mode).
    this.contentEl = document.createElement("div");
    this.contentEl.className = "outline-content hidden";

    // Insert toggle bar before the tree, then the outline panel after.
    treeEl.before(this.toggleBar);
    treeEl.after(this.contentEl);
  }

  /** Switch between "files" and "outline" modes. */
  setMode(mode: "files" | "outline"): void {
    this.mode = mode;
    this.filesBtn.classList.toggle("active", mode === "files");
    this.outlineBtn.classList.toggle("active", mode === "outline");
    this.treeEl.classList.toggle("hidden", mode === "outline");
    this.contentEl.classList.toggle("hidden", mode === "files");
    if (mode === "outline") void this.refresh();
  }

  /** Notify the outline that the active file changed; refresh if visible. */
  onActiveFileChanged(): void {
    if (this.mode === "outline") void this.refresh();
  }

  /** Debounce outline refresh after doc changes (called from editor update listener). */
  scheduleRefresh(): void {
    if (this.mode !== "outline") return;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 300);
  }

  /** Fetch and re-render the outline for the active file. */
  async refresh(): Promise<void> {
    const syms = await this.fetchSymbols();
    this.symbols = syms ?? [];
    this.render();
  }

  /** Render the symbol list into the outline content element. */
  private render(): void {
    this.contentEl.innerHTML = "";
    if (this.symbols.length === 0) {
      const empty = document.createElement("div");
      empty.className = "outline-empty";
      empty.textContent = "No symbols";
      this.contentEl.appendChild(empty);
      return;
    }
    const path = this.getActivePath();
    this.renderSymbols(this.symbols, 0, path);
  }

  /** Recursively render a DocumentSymbol[] array at the given indentation depth. */
  private renderSymbols(symbols: DocumentSymbol[], depth: number, path: string | null): void {
    for (const sym of symbols) {
      const row = this.makeSymbolRow(sym, depth, path);
      this.contentEl.appendChild(row);
      if (sym.children.length > 0) {
        this.renderSymbols(sym.children, depth + 1, path);
      }
    }
  }

  /** Build a single tree-row element for a DocumentSymbol. */
  private makeSymbolRow(sym: DocumentSymbol, depth: number, path: string | null): HTMLElement {
    const row = document.createElement("div");
    row.className = "tree-row file outline-row";
    row.style.paddingLeft = `${depth * 12 + 14}px`;

    const meta = symbolMeta(sym.kind);
    const icon = document.createElement("span");
    icon.className = `tree-icon ${meta.className}`;
    icon.textContent = meta.icon;

    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = sym.name;

    const badge = document.createElement("span");
    badge.className = "outline-kind-badge";
    badge.textContent = sym.kind;

    row.append(icon, label, badge);

    row.onclick = () => {
      if (path) {
        const line = sym.selectionRange.start.line + 1;
        this.onRevealLine?.(path, line);
      }
    };

    return row;
  }
}

/** Map a DocumentSymbol kind string to a tree icon/class pair for the outline. */
function symbolMeta(kind: string): { icon: string; className: string } {
  switch (kind) {
    case "function":
    case "method":
      return { icon: "fn", className: "type-js" };
    case "class":
    case "struct":
    case "interface":
      return { icon: "cls", className: "type-ts" };
    case "variable":
    case "const":
    case "let":
      return { icon: "var", className: "type-file" };
    case "module":
    case "namespace":
      return { icon: "mod", className: "type-folder" };
    case "enum":
    case "enumMember":
      return { icon: "enm", className: "type-json" };
    case "field":
    case "property":
      return { icon: "fld", className: "type-css" };
    case "constructor":
      return { icon: "ctr", className: "type-rs" };
    case "type":
    case "typeAlias":
      return { icon: "typ", className: "type-ts" };
    default:
      return { icon: "sym", className: "type-file" };
  }
}
