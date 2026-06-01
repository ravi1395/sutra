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

function lineCount(p: Change): number {
  if (typeof p.count === "number") return p.count;
  const v = p.value;
  if (!v.length) return 0;
  return v.replace(/\n$/, "").split("\n").length;
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
    const startOld = oldLine;
    const startNew = newLine;
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const q = parts[i];
      const c = lineCount(q);
      if (q.removed) {
        rem += c;
        oldLine += c;
      } else {
        add += c;
        newLine += c;
      }
      i++;
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
      oldText: baseLines.slice(startOld, startOld + rem),
      newText: curLines.slice(startNew, startNew + add),
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
  private body = document.getElementById("diff-body")!;
  private titleEl = document.getElementById("diff-title")!;
  onRevert?: (h: Hunk) => void;

  render(hunks: Hunk[], label: string): void {
    this.titleEl.textContent = label;
    this.body.innerHTML = "";
    if (!hunks.length) {
      const e = document.createElement("div");
      e.id = "diff-empty";
      e.textContent = "No changes vs baseline.";
      this.body.appendChild(e);
      return;
    }
    hunks.forEach((h, idx) => {
      const box = document.createElement("div");
      box.className = "hunk";
      box.dataset.idx = String(idx);

      const head = document.createElement("div");
      head.className = "hunk-head";
      const k = document.createElement("span");
      k.className = "kind-" + h.kind;
      const range = h.kind === "deleted" ? `at line ${h.newFrom + 1}` : `lines ${h.newFrom + 1}-${h.newTo}`;
      k.textContent = `${h.kind.toUpperCase()} · ${range}`;
      const btn = document.createElement("button");
      btn.className = "hunk-revert";
      btn.textContent = "Revert";
      btn.onclick = () => this.onRevert?.(h);
      head.append(k, btn);
      box.append(head);

      if (h.oldText.length) {
        const pre = document.createElement("pre");
        pre.className = "old";
        pre.textContent = h.oldText.map((l) => "- " + l).join("\n");
        box.append(pre);
      }
      if (h.newText.length) {
        const pre = document.createElement("pre");
        pre.className = "new";
        pre.textContent = h.newText.map((l) => "+ " + l).join("\n");
        box.append(pre);
      }
      this.body.append(box);
    });
  }

  highlightHunk(idx: number): void {
    this.body.querySelectorAll(".hunk.highlight").forEach((e) => e.classList.remove("highlight"));
    const el = this.body.querySelector<HTMLElement>(`.hunk[data-idx="${idx}"]`);
    if (el) {
      el.classList.add("highlight");
      el.scrollIntoView({ block: "nearest" });
    }
  }
}
