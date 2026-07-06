// Turn rollback dialog (harness v2, Task E): per-file restore checklist over a
// turn's snapshots, dirty-buffer guard, per-file failure reporting.
import type { RollbackResult, Turn } from "./ipc";
import type { EditorManager } from "./editor";

// Wired by main.ts (Task H) so the dialog can see dirty buffers without a
// direct singleton dependency; unset (e.g. in tests) means "nothing dirty".
let editorRef: EditorManager | null = null;
export function setRollbackEditor(editor: EditorManager): void {
  editorRef = editor;
}

function dirtyOpenPaths(): Set<string> {
  const out = new Set<string>();
  for (const tab of editorRef?.getOpenTabs() ?? []) {
    if (tab.dirty && tab.path) out.add(tab.path);
  }
  return out;
}

type ChecklistRow = {
  path: string;
  checkedByDefault: boolean;
  reason: "clean" | "human-touched" | "unsnapshotted" | "unsafe";
};

/** Restore boundary for "undo turn N": the end of the *previous* turn (N-1).
 * Restore logic keeps turns with `id <= boundary` and reverts everything after,
 * so undoing turn N requires boundary N-1 — passing N would keep N and turn the
 * newest/only turn's rollback into a silent no-op. */
export function rollbackTargetId(turn: Turn): number {
  return turn.id - 1;
}

function affectedTurns(turns: Turn[], targetId: number): Turn[] {
  return turns.filter((t) => !t.rolledBack && t.id > targetId).sort((a, b) => a.id - b.id);
}

function affectedPaths(turns: Turn[], targetId: number): string[] {
  const paths = new Set<string>();
  for (const t of affectedTurns(turns, targetId)) for (const f of t.files) paths.add(f.path);
  return [...paths];
}

/** Pure checklist model: which paths default-checked and why.
 * Affected = files touched by non-rolled-back turns with id > targetId.
 * unsnapshotted → any needed entry skipped by the size cap;
 * human-touched → disk hash diverged from that path's newest after-hash;
 * else clean (checked by default). */
export function rollbackChecklist(
  turns: Turn[],
  targetId: number,
  diskHashes: Map<string, string | null>,
): ChecklistRow[] {
  const affected = affectedTurns(turns, targetId);

  const entries = new Map<string, { afterHash: string | null; snapshotted: boolean; unsafeBefore: boolean }[]>();
  for (const turn of affected) {
    for (const file of turn.files) {
      const list = entries.get(file.path) ?? [];
      list.push({
        afterHash: file.afterHash ?? null,
        snapshotted: file.snapshotted,
        unsafeBefore: file.unsafeBefore ?? false,
      });
      entries.set(file.path, list);
    }
  }

  const rows: ChecklistRow[] = [];
  for (const [path, list] of entries) {
    if (list.some((e) => !e.snapshotted)) {
      rows.push({ path, checkedByDefault: false, reason: "unsnapshotted" });
    } else if (list.some((e) => e.unsafeBefore)) {
      // Backend excludes unsafe-before files from the restore plan (original
      // content was never captured); surface that with a visible label.
      rows.push({ path, checkedByDefault: false, reason: "unsafe" });
    } else if ((diskHashes.get(path) ?? null) !== list[list.length - 1].afterHash) {
      rows.push({ path, checkedByDefault: false, reason: "human-touched" });
    } else {
      rows.push({ path, checkedByDefault: true, reason: "clean" });
    }
  }
  return rows;
}

/** Self-referential fallback: newest recorded after-hash per path across all
 * known turns, compared against itself in `rollbackChecklist`. Only used when
 * no live `getDiskHashes` provider is supplied (e.g. unit tests, or a caller
 * that hasn't wired the disk-hash IPC) — it can never flag human-touched
 * files since both sides come from the same snapshot data. */
function fallbackDiskHashes(turns: Turn[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const t of [...turns].sort((a, b) => a.id - b.id)) {
    for (const f of t.files) m.set(f.path, f.afterHash ?? null);
  }
  return m;
}

/** Resolve checklist rows for `targetId`, sourcing disk hashes from
 * `getDiskHashes(root, paths)` when supplied — this is what makes
 * human-touched detection real, comparing actual on-disk content against
 * the turn's recorded after-hash. Falls back to `fallbackDiskHashes` (dead
 * human-touched detection) when no provider is given. DOM-free, unit-testable. */
export async function resolveRollbackChecklist(
  root: string,
  turns: Turn[],
  targetId: number,
  getDiskHashes?: (root: string, paths: string[]) => Promise<Record<string, string>>,
): Promise<ChecklistRow[]> {
  if (!getDiskHashes) return rollbackChecklist(turns, targetId, fallbackDiskHashes(turns));
  const paths = affectedPaths(turns, targetId);
  const disk = await getDiskHashes(root, paths);
  const diskHashes = new Map<string, string | null>(paths.map((p) => [p, disk[p] ?? null]));
  return rollbackChecklist(turns, targetId, diskHashes);
}

/** Open the rollback overlay for `turn`; applies via `opts.onApply`.
 * Rows populate once `resolveRollbackChecklist` resolves (real human-touched
 * detection when `opts.getDiskHashes` is supplied; safe fallback otherwise).
 * Apply stays disabled until rows load (or a load failure renders an inline
 * `.rollback-error`), and while any checked path has a dirty editor buffer.
 * Esc/backdrop close; per-file restore failures render inline. */
export function openRollbackDialog(
  root: string,
  turn: Turn,
  opts: {
    turns: Turn[];
    onApply: (paths: string[]) => Promise<RollbackResult>;
    getDiskHashes?: (root: string, paths: string[]) => Promise<Record<string, string>>;
  },
): void {
  const overlay = document.createElement("div");
  overlay.className = "rollback-overlay";
  const dialog = document.createElement("div");
  dialog.className = "rollback-dialog";
  overlay.appendChild(dialog);

  const title = document.createElement("div");
  title.className = "rollback-title";
  title.textContent = `Undo turn ${turn.id} and later changes in ${root.split("/").pop() || root}`;
  dialog.appendChild(title);

  const dirtyBanner = document.createElement("div");
  dirtyBanner.className = "rollback-dirty-banner";
  dirtyBanner.style.display = "none";
  dialog.appendChild(dirtyBanner);

  const checkboxes = new Map<string, HTMLInputElement>();
  // Rows-loaded gate: Apply stays disabled until real rows (or an error state)
  // has been rendered, so a click during the async resolve can't fire
  // opts.onApply([]) — a silent no-op rollback that looks successful.
  let rowsLoaded = false;
  // Last-rendered rows, keyed by path — apply() re-resolves against this to
  // detect drift (see below).
  let lastRows = new Map<string, ChecklistRow>();
  const list = document.createElement("div");
  list.className = "rollback-file-list";
  list.textContent = "Checking file status…";
  dialog.appendChild(list);

  function renderRows(rows: ChecklistRow[]) {
    checkboxes.clear();
    lastRows = new Map(rows.map((row) => [row.path, row]));
    list.textContent = "";
    for (const row of rows) {
      const rowEl = document.createElement("label");
      rowEl.className = "rollback-file-row" + (row.reason === "human-touched" ? " rollback-row--human" : "");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = row.checkedByDefault;
      checkbox.onchange = refreshGuard;
      checkboxes.set(row.path, checkbox);
      const label = document.createElement("span");
      label.textContent = row.reason === "clean" ? row.path : `${row.path} (${row.reason})`;
      rowEl.append(checkbox, label);
      list.appendChild(rowEl);
    }
    rowsLoaded = true;
    refreshGuard();
  }

  // Provider rejection (e.g. getDiskHashes IPC failure): surface a visible
  // error instead of leaving the "Checking file status…" placeholder forever
  // or letting the rejection go unhandled. Apply stays disabled — rowsLoaded
  // never flips true.
  function renderError(err: unknown) {
    checkboxes.clear();
    list.textContent = "";
    const rowEl = document.createElement("div");
    rowEl.className = "rollback-error";
    rowEl.textContent = `Failed to load file status: ${err instanceof Error ? err.message : String(err)}`;
    list.appendChild(rowEl);
    refreshGuard();
  }

  const failuresEl = document.createElement("div");
  failuresEl.className = "rollback-failures";
  dialog.appendChild(failuresEl);

  const actions = document.createElement("div");
  actions.className = "rollback-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = close;
  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply rollback";
  applyBtn.onclick = () => void apply();
  actions.append(cancelBtn, applyBtn);
  dialog.appendChild(actions);

  function checkedPaths(): string[] {
    return [...checkboxes.entries()].filter(([, cb]) => cb.checked).map(([path]) => path);
  }

  // Dirty-buffer guard: a checked path with unsaved editor edits blocks Apply.
  // Also gated on rowsLoaded — no real rows yet (still loading, or load failed)
  // means Apply must stay disabled regardless of the (empty) checked set.
  function refreshGuard() {
    if (!rowsLoaded) {
      applyBtn.disabled = true;
      return;
    }
    const dirty = dirtyOpenPaths();
    // Editor tabs carry absolute paths; checklist rows are root-relative
    // (TurnFileEntry.path) — resolve to absolute before comparing, else the
    // guard never matches and unsaved edits get silently overwritten.
    const toAbs = (p: string) => (p.startsWith("/") ? p : `${root}/${p}`);
    const blocked = checkedPaths().filter((p) => dirty.has(toAbs(p)));
    if (blocked.length > 0) {
      dirtyBanner.textContent = `Unsaved edits — save first or uncheck: ${blocked.join(", ")}`;
      dirtyBanner.style.display = "";
      applyBtn.disabled = true;
    } else {
      dirtyBanner.style.display = "none";
      applyBtn.disabled = false;
    }
  }

  async function apply() {
    // Rows not loaded yet: the button is visually disabled, but guard the
    // handler directly too (a stray click event, or a test invoking onclick
    // manually) so a concurrent re-resolve can't race the initial load's
    // in-flight getDiskHashes call.
    if (!rowsLoaded) return;
    failuresEl.textContent = "";
    applyBtn.disabled = true;
    const paths = checkedPaths();
    try {
      // Rows are resolved once at open, but the workspace can change while the
      // dialog sits open (e.g. an agent turn closes mid-review). Re-resolve
      // against the same turns + live disk hashes and refuse to apply if any
      // CHECKED path's row now differs from what was displayed — silently
      // reverting content the checklist never showed would bypass the
      // human-touched/unsnapshotted/unsafe protections entirely.
      // TODO: longer-term fix is a compare-and-swap (expected hash) argument
      // on turn_rollback itself; this is a frontend-only stopgap.
      const freshRows = await resolveRollbackChecklist(root, opts.turns, rollbackTargetId(turn), opts.getDiskHashes);
      const freshByPath = new Map(freshRows.map((row) => [row.path, row]));
      const drifted = paths.filter((p) => {
        const fresh = freshByPath.get(p);
        const was = lastRows.get(p);
        return !fresh || !was || fresh.reason !== was.reason;
      });
      if (drifted.length > 0) {
        failuresEl.textContent = `Workspace changed — review again: ${drifted.join(", ")}`;
        renderRows(freshRows); // re-renders + re-runs refreshGuard()
        return;
      }
      const result = await opts.onApply(paths);
      if (result.failed.length > 0) {
        failuresEl.textContent = result.failed.map((f) => `${f.path}: ${f.error}`).join("\n");
        applyBtn.disabled = false;
        return;
      }
      close();
    } catch (err) {
      failuresEl.textContent = String(err);
      applyBtn.disabled = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
  function close() {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  }
  document.addEventListener("keydown", onKeydown);
  overlay.onmousedown = (e) => {
    if (e.target === overlay) close();
  };

  refreshGuard();
  document.body.appendChild(overlay);

  void resolveRollbackChecklist(root, opts.turns, rollbackTargetId(turn), opts.getDiskHashes).then(renderRows, renderError);
}
