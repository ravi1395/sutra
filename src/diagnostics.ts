// Diagnostics pipeline (harness v2): squiggles, problems panel, statusbar chip,
// and the fs-changed → diagDetect/diagRun trigger.
// Pure model (DiagState + reducers) is unit-tested without a DOM; the CM6/DOM
// layer below is a thin consumer of that model.
import {
  EditorView,
  Decoration,
  ViewPlugin,
  GutterMarker,
  gutter,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { diagDetect, diagRun, onDiagnosticsUpdated, onFsChanged, type Diagnostic } from "./ipc";
import { loadSettings } from "./settings";
import { diagnosticsAutomations, loadAutomations } from "./automations";

const TOOLFAIL_MARK = ":toolfail:";

// ---- pure model ----

export interface DiagState {
  byRoot: Map<string, Map<string, Diagnostic[]>>; // root -> source key -> diagnostics
  stalePaths: Set<string>;
}

/** Fresh, empty diagnostics state. */
export function emptyDiagState(): DiagState {
  return { byRoot: new Map(), stalePaths: new Set() };
}

/** Tolerant path equality: exact, or one is a suffix path segment of the other (relative vs absolute forms). */
function pathsMatch(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Source key minus any ":toolfail:<stderr>" suffix — the tool's stable identity. */
function sourceBase(key: string): string {
  const idx = key.indexOf(TOOLFAIL_MARK);
  return idx === -1 ? key : key.slice(0, idx);
}

/** Replace diagnostics for (root, source). Any prior key with the same source base
 * (e.g. an earlier "tsc:toolfail:…" once "tsc" recovers, or a previous excerpt) is
 * dropped, and staleness is cleared for paths present in the fresh batch. */
export function reduceUpdate(s: DiagState, root: string, source: string, diags: Diagnostic[]): DiagState {
  const byRoot = new Map(s.byRoot);
  const bySource = new Map(byRoot.get(root) ?? new Map<string, Diagnostic[]>());
  const base = sourceBase(source);
  for (const key of [...bySource.keys()]) {
    if (key !== source && sourceBase(key) === base) bySource.delete(key);
  }
  bySource.set(source, diags);
  byRoot.set(root, bySource);
  const stalePaths = new Set(
    [...s.stalePaths].filter((p) => !diags.some((d) => pathsMatch(p, d.path))),
  );
  return { byRoot, stalePaths };
}

/** Diagnostics for `path` across all roots/sources, with per-item staleness flag.
 * Both retrieval and staleness use suffix-tolerant path matching. */
export function diagsForPath(s: DiagState, path: string): { diag: Diagnostic; stale: boolean }[] {
  const out: { diag: Diagnostic; stale: boolean }[] = [];
  for (const bySource of s.byRoot.values()) {
    for (const [source, diags] of bySource) {
      if (source.includes(TOOLFAIL_MARK)) continue;
      for (const diag of diags) {
        if (pathsMatch(path, diag.path)) {
          const stale = [...s.stalePaths].some((p) => pathsMatch(p, diag.path));
          out.push({ diag, stale });
        }
      }
    }
  }
  return out;
}

/** Tool failures for a root: source name + stderr excerpt, parsed from ":toolfail:" source keys. */
export function toolFailures(s: DiagState, root: string): { source: string; excerpt: string }[] {
  const bySource = s.byRoot.get(root);
  if (!bySource) return [];
  const out: { source: string; excerpt: string }[] = [];
  for (const key of bySource.keys()) {
    const idx = key.indexOf(TOOLFAIL_MARK);
    if (idx === -1) continue;
    out.push({ source: key.slice(0, idx), excerpt: key.slice(idx + TOOLFAIL_MARK.length) });
  }
  return out;
}

/** Statusbar chip state for a root: running > toolfail > dirty > clean. */
export function chipState(s: DiagState, root: string, running: boolean): "running" | "clean" | "dirty" | "toolfail" {
  if (running) return "running";
  const bySource = s.byRoot.get(root);
  if (!bySource) return "clean";
  let dirty = false;
  for (const [source, diags] of bySource) {
    if (source.includes(TOOLFAIL_MARK)) return "toolfail";
    if (diags.length > 0) dirty = true;
  }
  return dirty ? "dirty" : "clean";
}

/** True when `settleMs` has elapsed since `lastFireMs` (or never fired). Pure; caller supplies the clock. */
export function settleTrigger(nowMs: number, lastFireMs: number | null, settleMs: number): boolean {
  if (lastFireMs === null) return true;
  return nowMs - lastFireMs >= settleMs;
}

// Build outputs the diag jobs themselves write into: `cargo check` touches
// target/** on every run, so an unfiltered fs trigger re-runs the jobs forever.
const DIAG_IGNORED_SEGMENTS = new Set(["node_modules", "target", "dist"]);

/** True when a changed path should (re)schedule diagnostics: excludes build
 * outputs and hidden dirs (.git/.sutra/.remember/…) so tool self-writes and
 * VCS/state churn can't sustain a spawn loop. Pure; segment match, not substring. */
export function isDiagRelevantPath(path: string): boolean {
  return !path
    .split(/[\\/]/)
    .some((seg) => DIAG_IGNORED_SEGMENTS.has(seg) || (seg.length > 1 && seg.startsWith(".")));
}

// ---- module state (DOM/CM6 layer) ----

let state: DiagState = emptyDiagState();
let currentRoot: string | null = null;
let running = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
// Window-hidden gate for the fs-settle trigger: while off-screen we don't run
// tsc/cargo jobs on background FS churn (e.g. an agent editing). A single
// catch-up runs on re-show if anything relevant changed meanwhile.
let diagFsPaused = false;
let diagFsPendingWhileHidden = false;
let diagGetRoot: (() => string | null) | null = null;
let inFlight = false;
const views = new Set<EditorView>();

const forceRepaint = StateEffect.define<null>();

/** Replace the current diagnostics for (root, source); repaints editors, chip, panel. */
export function setDiagnostics(root: string, source: string, diags: Diagnostic[]): void {
  state = reduceUpdate(state, root, source, diags);
  repaint();
  updateChip();
  renderProblemsPanel();
}

/** Current, non-stale diagnostics for a file path. */
export function getDiagnosticsFor(path: string): Diagnostic[] {
  return diagsForPath(state, path)
    .filter((d) => !d.stale)
    .map((d) => d.diag);
}

/** Mark a path's diagnostics stale after a doc edit. */
export function notifyDocChanged(path: string): void {
  state.stalePaths.add(path);
  repaint();
}

function buildDecorations(view: EditorView, getPath: () => string | null): DecorationSet {
  const path = getPath();
  if (!path) return Decoration.none;
  const items = diagsForPath(state, path);
  if (items.length === 0) return Decoration.none;
  const doc = view.state.doc;
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = items
    .map(({ diag, stale }) => {
      if (diag.line < 1 || diag.line > doc.lines) return null;
      const lineObj = doc.line(diag.line);
      const col = Math.max(0, diag.col - 1);
      const from = Math.min(lineObj.from + col, lineObj.to);
      const to = Math.max(from + 1, Math.min(lineObj.to, from + 1));
      return { from, to, diag, stale };
    })
    .filter((x): x is { from: number; to: number; diag: Diagnostic; stale: boolean } => x !== null)
    .sort((a, b) => a.from - b.from);
  for (const { from, to, diag, stale } of sorted) {
    const cls = `${diag.severity === "warning" ? "diag-squiggle-warning" : "diag-squiggle-error"}${stale ? " diag-stale" : ""}`;
    builder.add(from, to, Decoration.mark({ class: cls, attributes: { title: `[${diag.source}] ${diag.message}` } }));
  }
  return builder.finish();
}

/** Gutter dot marker rendered into .cm-gutters for lines carrying diagnostics. */
class DiagDotMarker extends GutterMarker {
  constructor(readonly stale: boolean) {
    super();
  }
  eq(other: DiagDotMarker): boolean {
    return other.stale === this.stale;
  }
  toDOM(): Node {
    const el = document.createElement("span");
    el.className = this.stale ? "diag-gutter-dot diag-stale" : "diag-gutter-dot";
    return el;
  }
}
const dotFresh = new DiagDotMarker(false);
const dotStale = new DiagDotMarker(true);

function isRepaintUpdate(u: ViewUpdate): boolean {
  return u.transactions.some((tr) => tr.effects.some((e) => e.is(forceRepaint)));
}

/** CM6 extension rendering squiggles + gutter dots for the file identified by `getPath`.
 * (Signature amended post-review: path comes from a callback, matching langHoverTooltipExt.) */
export function diagnosticsExtension(getPath: () => string | null): Extension {
  const squiggles = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        this.decorations = buildDecorations(view, getPath);
        views.add(view);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || isRepaintUpdate(u)) {
          this.decorations = buildDecorations(u.view, getPath);
        }
      }
      destroy(): void {
        views.delete(this.view);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const diagGutter = gutter({
    class: "diag-gutter",
    lineMarker(view, line) {
      const path = getPath();
      if (!path) return null;
      const lineNo = view.state.doc.lineAt(line.from).number;
      let present = false;
      let allStale = true;
      for (const { diag, stale } of diagsForPath(state, path)) {
        if (diag.line !== lineNo) continue;
        present = true;
        if (!stale) allStale = false;
      }
      if (!present) return null;
      return allStale ? dotStale : dotFresh;
    },
    lineMarkerChange: isRepaintUpdate,
  });

  return [squiggles, diagGutter];
}

function repaint(): void {
  for (const view of views) {
    view.dispatch({ effects: [forceRepaint.of(null)] });
  }
}

function updateChip(): void {
  const chip = diagChipEl();
  if (!currentRoot) return;
  const st = chipState(state, currentRoot, running);
  chip.classList.remove("diag-chip--running", "diag-chip--clean", "diag-chip--dirty", "diag-chip--toolfail");
  chip.classList.add(`diag-chip--${st}`);
  chip.title = toolFailures(state, currentRoot)
    .map((f) => `${f.source}: ${f.excerpt}`)
    .join("\n");
}

let problemsPanel: HTMLElement | null = null;
/** Singleton problems-panel root (id="problems-panel"). */
export function problemsPanelEl(): HTMLElement {
  if (!problemsPanel) {
    problemsPanel = document.createElement("div");
    problemsPanel.id = "problems-panel";
  }
  return problemsPanel;
}

let diagChip: HTMLElement | null = null;
/** Singleton statusbar diagnostics chip (id="diag-chip"). */
export function diagChipEl(): HTMLElement {
  if (!diagChip) {
    diagChip = document.createElement("div");
    diagChip.id = "diag-chip";
  }
  return diagChip;
}

function renderProblemsPanel(): void {
  const panel = problemsPanelEl();
  panel.innerHTML = "";
  if (!currentRoot) return;
  // Tool failures render first as banner rows so a broken tool is never a silent empty state.
  for (const f of toolFailures(state, currentRoot)) {
    const row = document.createElement("div");
    row.className = "problem-row problem-row--toolfail";
    row.textContent = `${f.source} failed: ${f.excerpt}`;
    panel.appendChild(row);
  }
  const bySource = state.byRoot.get(currentRoot);
  if (!bySource) return;
  for (const [source, diags] of bySource) {
    if (source.includes(TOOLFAIL_MARK)) continue;
    for (const diag of diags) {
      const row = document.createElement("div");
      row.className = "problem-row";
      row.textContent = `${diag.severity} ${diag.path}:${diag.line}:${diag.col} ${diag.message}`;
      row.onclick = () => {
        window.dispatchEvent(new CustomEvent("sutra:goto", { detail: { path: diag.path, line: diag.line, col: diag.col } }));
      };
      panel.appendChild(row);
    }
  }
}

const SETTLE_MS = 1000;

async function runDiagnostics(root: string): Promise<void> {
  if (inFlight) return;
  if (!loadSettings().diagnosticsEnabled) return;
  inFlight = true;
  running = true;
  updateChip();
  try {
    const autos = diagnosticsAutomations(await loadAutomations(root));
    const jobs = autos.length
      ? autos.map((a) => ({ source: a.id, command: a.command, cwd: root, parser: a.parser ?? "regex", regex: a.regex }))
      : await diagDetect(root);
    await diagRun(root, jobs);
  } finally {
    running = false;
    inFlight = false;
    updateChip();
  }
}

/** Wire the diagnostics trigger loop to the active workspace root. */
export function initDiagnostics(getRoot: () => string | null): void {
  currentRoot = getRoot();
  diagGetRoot = getRoot;

  void onDiagnosticsUpdated(({ root, source, diagnostics }) => {
    setDiagnostics(root, source, diagnostics);
  });

  void onFsChanged(({ paths }) => {
    const relevant = paths.some(isDiagRelevantPath);
    if (!relevant) return;
    if (diagFsPaused) {
      diagFsPendingWhileHidden = true; // defer the tsc/cargo job to re-show
      return;
    }
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      currentRoot = getRoot();
      if (currentRoot) void runDiagnostics(currentRoot);
    }, SETTLE_MS);
  });
}

// Window-hidden gate: called by the main idle gate so background FS churn
// doesn't spin up tsc/cargo diagnostics jobs while the window is off-screen.
export function pauseDiagnosticsFsTrigger(): void {
  diagFsPaused = true;
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

// Re-arm on re-show; run one catch-up job if anything changed while hidden.
export function resumeDiagnosticsFsTrigger(): void {
  diagFsPaused = false;
  if (!diagFsPendingWhileHidden) return;
  diagFsPendingWhileHidden = false;
  const root = diagGetRoot?.() ?? currentRoot;
  if (root) {
    currentRoot = root;
    void runDiagnostics(root);
  }
}
