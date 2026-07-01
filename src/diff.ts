// Line-level diff: classify changed lines (new=yellow, modified=blue, deleted=red)
// and group them into hunks the viewer can render and revert individually.
import { diffLines, type Change } from "diff";

export type DiffKind = "added" | "modified" | "deleted";

export interface LineMark {
  line: number; // 0-based line in the current document
  kind: DiffKind;
}

export interface Hunk {
  kind: DiffKind;
  newFrom: number; // 0-based start line in current doc
  newTo: number; // exclusive
  oldText: string[]; // baseline lines for this hunk
  newText: string[]; // current lines for this hunk
}

export interface LensModel {
  title: string;
  oldLines: string[];
  newLines: string[];
  attribution: string | null;
}

/** Assemble display model for the inline hunk lens. */
export function lensModel(hunks: readonly Hunk[], index: number, attribution: string | null): LensModel {
  const h = hunks[index];
  const last = Math.max(h.newFrom + 1, h.newTo);
  const lineLabel = last > h.newFrom + 1 ? `lines ${h.newFrom + 1}–${last}` : `line ${h.newFrom + 1}`;
  return {
    title: `hunk ${index + 1} of ${hunks.length} · ${lineLabel}`,
    oldLines: h.oldText,
    newLines: h.newText,
    attribution,
  };
}

export interface HunkRow {
  kind: DiffKind;
  startLine: number; // 0-based start line in current doc (= hunk.newFrom)
  label: string;
  newFrom: number;
  newTo: number;
  oldText: string[];
}

/** Compact per-hunk index rows for the diff viewer; labels mirror lensModel. */
export function hunkSummaries(hunks: readonly Hunk[]): HunkRow[] {
  return hunks.map((h) => {
    const last = Math.max(h.newFrom + 1, h.newTo);
    const label =
      h.kind === "deleted"
        ? `at line ${h.newFrom + 1}`
        : last > h.newFrom + 1
          ? `lines ${h.newFrom + 1}–${last}`
          : `line ${h.newFrom + 1}`;
    return { kind: h.kind, startLine: h.newFrom, label, newFrom: h.newFrom, newTo: h.newTo, oldText: h.oldText };
  });
}

function lineCount(p: Change): number {
  if (typeof p.count === "number") return p.count;
  const v = p.value;
  if (!v.length) return 0;
  return v.replace(/\n$/, "").split("\n").length;
}

function preservesOnlyFinalNewline(removed: string, added: string): boolean {
  return (
    removed !== added &&
    removed.replace(/\n$/, "") === added.replace(/\n$/, "") &&
    (removed.endsWith("\n") || added.endsWith("\n"))
  );
}

/**
 * Diff `current` against `baseline` (git HEAD, or a captured pre-AI buffer).
 * A removed+added pair is a modification; a lone addition is new; a lone removal
 * is a deletion marked at its boundary line.
 */
export function computeLineDiff(
  baseline: string,
  current: string,
): { marks: LineMark[]; hunks: Hunk[] } {
  const parts = diffLines(baseline, current);
  const baseLines = baseline.split("\n");
  const curLines = current.split("\n");
  const marks: LineMark[] = [];
  const hunks: Hunk[] = [];

  let oldLine = 0;
  let newLine = 0;
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      const n = lineCount(p);
      oldLine += n;
      newLine += n;
      i++;
      continue;
    }
    // Absorb a contiguous run of removed/added parts into one hunk.
    let rem = 0;
    let add = 0;
    let removedValue = "";
    let addedValue = "";
    const startOld = oldLine;
    const startNew = newLine;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const q = parts[i];
      const c = lineCount(q);
      if (q.removed) {
        rem += c;
        removedValue += q.value;
        oldLine += c;
      } else {
        add += c;
        addedValue += q.value;
        newLine += c;
      }
      i++;
    }
    let oldText = baseLines.slice(startOld, startOld + rem);
    let newText = curLines.slice(startNew, startNew + add);
    if (rem > 0 && add > 0 && preservesOnlyFinalNewline(removedValue, addedValue)) {
      oldText = removedValue.split("\n");
      newText = addedValue.split("\n");
      rem = oldText.length;
      add = newText.length;
    }
    const kind: DiffKind = rem > 0 && add > 0 ? "modified" : add > 0 ? "added" : "deleted";
    if (add > 0) {
      // The first min(rem, add) added lines replace removed lines (modified);
      // any added lines beyond the removed count are genuinely new.
      for (let l = startNew; l < startNew + add; l++) {
        marks.push({ line: l, kind: l - startNew < rem ? "modified" : "added" });
      }
    } else {
      // pure deletion: flag the surviving line at the deletion boundary
      marks.push({ line: Math.max(0, Math.min(startNew, curLines.length - 1)), kind: "deleted" });
    }
    hunks.push({
      kind,
      newFrom: startNew,
      newTo: startNew + add,
      oldText,
      newText,
    });
  }
  return { marks, hunks };
}

/** Index of the hunk covering a clicked line, or -1. */
export function hunkIndexAtLine(hunks: Hunk[], line0: number): number {
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (h.kind === "deleted") {
      if (line0 === h.newFrom) return i;
    } else if (line0 >= h.newFrom && line0 < h.newTo) {
      return i;
    }
  }
  return -1;
}

// ---- Diff viewer panel ----

export class DiffViewer {
  private titleEl = document.getElementById("diff-title")!;
  private filesEl = document.getElementById("diff-files")!;
  private expandedPaths = new Set<string>();
  private lastFileListKey = "";

  private syncActive(active: string | null): void {
    this.filesEl.querySelectorAll<HTMLDivElement>(".diff-file-row").forEach((row) => {
      row.classList.toggle("active", row.title === active);
    });
  }

  // Force the next renderFileList to fully rebuild (and re-fetch hunk rows for
  // expanded files) even if the status\0path key is unchanged. Call after a
  // reject/accept mutates file content so stale hunk offsets can't be reused.
  invalidate(): void {
    this.lastFileListKey = "";
  }

  // Show a one-line status (deleted/binary/unreadable) above the file list without clearing it.
  renderStatus(label: string, message: string): void {
    this.titleEl.textContent = label;
    let status = this.filesEl.querySelector<HTMLDivElement>("#diff-empty");
    if (!status) {
      status = document.createElement("div");
      status.id = "diff-empty";
      this.filesEl.prepend(status);
    }
    status.textContent = message;
  }

  // Render the changed-files list; each row expands (lazily) into a per-hunk
  // index, and hunk rows jump into the editor peek.
  renderFileList(
    files: { path: string; status: string }[],
    active: string | null,
    handlers: {
      onFilePick: (path: string) => void;
      onExpand: (path: string) => Promise<HunkRow[]>;
      onHunkPick: (path: string, startLine: number) => void;
      onAccept?: (path: string) => void;
      onReject?: (path: string, hunk: HunkRow) => void;
    },
  ): void {
    const nextKey = files.map((file) => `${file.status}\0${file.path}`).join("\0");
    if (!this.filesEl.querySelector("#diff-empty") && nextKey === this.lastFileListKey) {
      this.syncActive(active);
      return;
    }

    this.lastFileListKey = nextKey;
    this.filesEl.innerHTML = "";
    if (!files.length) return;
    const visiblePaths = new Set(files.map((file) => file.path));
    for (const path of this.expandedPaths) {
      if (!visiblePaths.has(path)) this.expandedPaths.delete(path);
    }

    const list = document.createElement("div");
    list.className = "diff-file-list";

    for (const file of files) {
      const row = document.createElement("div");
      row.className = "diff-file-row";
      row.title = file.path;
      if (file.path === active) row.classList.add("active");

      const chevron = document.createElement("span");
      chevron.className = "diff-file-chevron";
      chevron.textContent = "▸";

      const status = document.createElement("span");
      status.className = `diff-file-status status-${file.status.toLowerCase()}`;
      status.textContent = file.status;

      const name = document.createElement("span");
      name.className = "diff-file-name";
      name.textContent = file.path.split("/").pop() || file.path;
      name.title = file.path; // Full path in tooltip

      row.append(chevron, status, name);
      if (handlers.onAccept) {
        const accept = document.createElement("button");
        accept.className = "diff-file-action accept";
        accept.textContent = "accept";
        accept.title = "Accept all AI changes in this file (rebase to current)";
        accept.onclick = (ev) => {
          ev.stopPropagation();
          handlers.onAccept!(file.path);
        };
        row.append(accept);
      }

      const hunksBox = document.createElement("div");
      hunksBox.className = "diff-hunk-list hidden";
      let loaded = false;

      const loadHunks = async () => {
        if (loaded) return;
        loaded = true;
        const rows = await handlers.onExpand(file.path);
        if (!this.expandedPaths.has(file.path)) return;
        if (!rows.length) {
          const empty = document.createElement("div");
          empty.className = "diff-hunk-empty";
          empty.textContent = "no text hunks";
          hunksBox.append(empty);
          return;
        }
        for (const hr of rows) {
          const hrow = document.createElement("div");
          hrow.className = "diff-hunk-row";
          const dot = document.createElement("span");
          dot.className = `diff-hunk-dot ${hr.kind}`;
          const label = document.createElement("span");
          label.className = "diff-hunk-label";
          label.textContent = hr.label;
          hrow.append(dot, label);
          if (handlers.onReject) {
            const reject = document.createElement("button");
            reject.className = "diff-hunk-action reject";
            reject.textContent = "reject";
            reject.title = "Restore this hunk from the pre-agent base";
            reject.onclick = (ev) => {
              ev.stopPropagation();
              handlers.onReject!(file.path, hr);
            };
            hrow.append(reject);
          }
          hrow.onclick = (ev) => {
            ev.stopPropagation();
            handlers.onHunkPick(file.path, hr.startLine);
          };
          hunksBox.append(hrow);
        }
      };

      const setExpanded = (expanded: boolean) => {
        hunksBox.classList.toggle("hidden", !expanded);
        chevron.textContent = expanded ? "▾" : "▸";
        if (expanded) {
          this.expandedPaths.add(file.path);
          void loadHunks();
        } else {
          this.expandedPaths.delete(file.path);
        }
      };

      chevron.onclick = (event) => {
        event.stopPropagation();
        setExpanded(hunksBox.classList.contains("hidden"));
      };

      row.onclick = () => {
        list.querySelectorAll(".diff-file-row.active").forEach((e) => e.classList.remove("active"));
        row.classList.add("active");
        handlers.onFilePick(file.path);
      };

      if (this.expandedPaths.has(file.path)) setExpanded(true);
      list.append(row, hunksBox);
    }

    this.filesEl.appendChild(list);
  }
}
