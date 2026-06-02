// File tree with VS Code-style compact folders. Single-subfolder chains arrive
// pre-collapsed from Rust (label `a/b/c`, path = deepest dir), so expanding one
// node reveals real content instead of a corridor of empty folders.
import { listDir, gitStatus, type Entry, type GitStatusEntry } from "./ipc";

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

export type TreePaneSide = "left" | "right";

export function paneSideFromClientX(
  clientX: number,
  rect: Pick<DOMRect, "left" | "width">,
): TreePaneSide {
  return clientX < rect.left + rect.width / 2 ? "left" : "right";
}

export class FileTree {
  private el: HTMLElement;
  private root: string | null = null;
  private expanded = new Set<string>();
  private activePath: string | null = null;
  private status = new Map<string, "M" | "A" | "D">();
  private changedDirs = new Set<string>();
  onOpenFile?: (path: string) => void;
  onOpenFileInPane?: (path: string, side: TreePaneSide) => void;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  async setRoot(path: string): Promise<void> {
    this.root = path;
    this.expanded.clear();
    this.expanded.add(path);
    await this.loadStatus();
    await this.render();
  }

  private async loadStatus(): Promise<void> {
    this.status.clear();
    this.changedDirs.clear();
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
    this.el.innerHTML = "";
    if (!this.root) return;
    await this.renderDir(this.root, 0, this.el);
  }

  private async renderDir(path: string, depth: number, container: HTMLElement): Promise<void> {
    let entries: Entry[];
    try {
      entries = await listDir(path);
    } catch {
      return;
    }
    const seen = new Set(entries.map((e) => e.path));
    entries = entries.concat(this.deletedEntriesForDir(path, seen));
    for (const e of entries) {
      const row = this.makeRow(e, depth);
      container.appendChild(row);
      if (e.isDir) {
        const childBox = document.createElement("div");
        container.appendChild(childBox);
        if (this.expanded.has(e.path)) {
          await this.renderDir(e.path, depth + 1, childBox);
        }
      }
    }
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
    row.style.paddingLeft = `${depth * 12 + 8}px`;

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
      const badge = document.createElement("span");
      badge.className = "tree-status";
      badge.textContent = s;
      row.appendChild(badge);
    } else if (e.isDir && this.changedDirs.has(e.path)) {
      row.classList.add("status-dir-changed");
    }

    if (e.path === this.activePath) row.classList.add("active");

    if (!e.isDir) {
      row.draggable = true;
      row.addEventListener("dragstart", (ev) => {
        if (!ev.dataTransfer) return;
        ev.dataTransfer.effectAllowed = "copy";
        ev.dataTransfer.setData("application/x-sutra-file", e.path);
        ev.dataTransfer.setData("text/plain", e.path);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
    }

    row.onclick = () => {
      if (e.isDir) {
        if (this.expanded.has(e.path)) this.expanded.delete(e.path);
        else this.expanded.add(e.path);
        void this.render();
      } else {
        this.onOpenFile?.(e.path);
      }
    };
    return row;
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
