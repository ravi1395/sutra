import type { AgentChange, AgentTrackingStatus, ChangedFile, Diagnostic, Turn, TurnPollResult } from "./ipc";
import { getDiagnosticsFor } from "./diagnostics";

export interface ReviewFile extends ChangedFile {
  humanTouched?: boolean;
  binary?: boolean;
}

export function mergeChangedFiles(gitFiles: ChangedFile[], agentChanges: AgentChange[]): ReviewFile[] {
  const files = new Map<string, ReviewFile>();
  for (const file of gitFiles) files.set(file.path, file);
  for (const change of agentChanges) files.set(change.path, change);
  return Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
}

export function aiChanges(changes: AgentChange[]): AgentChange[] {
  return changes.filter((change) => !change.humanTouched);
}

export function firstViewableAgentChange(changes: AgentChange[]): AgentChange | undefined {
  const ai = aiChanges(changes);
  const isViewable = (change: AgentChange) => change.status !== "D" && !change.binary;
  return ai.find(isViewable) ?? changes.find(isViewable) ?? ai[0] ?? changes[0];
}

/** Lowercase whisper-bar summary of agent activity; "" when nothing to say. */
export function whisperText(status: AgentTrackingStatus, activeFile: string | null, agentName = "agent"): string {
  const ai = aiChanges(status.changes);
  if (status.agentActive && activeFile && ai.some((change) => change.path === activeFile)) {
    return `${agentName} is editing ${activeFile.split("/").pop()}`;
  }
  if (ai.length === 0) return "";
  const noun = ai.length === 1 ? "change" : "changes";
  return `${ai.length} ${noun} woven by ${agentName}`;
}

export type BaseSource = "agent" | "git-head";

/** AI-authored, non-binary, non-deleted files with a recoverable base diff
 * against the captured agent base; everything else against git HEAD. */
export function baseSourceFor(change: AgentChange | undefined): BaseSource {
  if (change && !change.humanTouched && change.status !== "D" && !change.binary) return "agent";
  return "git-head";
}

/** Paths eligible for per-hunk reject / per-file accept: agent-attributed
 * changes the tracker holds (baseSourceFor === "agent"). Other changed files —
 * human edits, git-only/hand-made changes not in the agent session — are not
 * reviewable this way and use the in-editor gutter revert instead. */
export function reviewablePaths(changes: readonly AgentChange[]): Set<string> {
  return new Set(changes.filter((change) => baseSourceFor(change) === "agent").map((change) => change.path));
}

// --- Turn state + review-panel turn UI (harness v2, Task E) ---

const turnsByRoot = new Map<string, Turn[]>();
const turnClosedSubscribers: ((root: string, turn: Turn) => void)[] = [];

/** Absorb a turnPoll result into local turn state for `root`; fires
 * onTurnClosed subscribers once per newly closed turn. */
export function setTurnState(root: string, res: TurnPollResult): void {
  const byId = new Map((turnsByRoot.get(root) ?? []).map((t) => [t.id, t]));
  for (const closed of res.closed) byId.set(closed.id, closed);
  if (res.openTurn) byId.set(res.openTurn.id, res.openTurn);
  turnsByRoot.set(root, Array.from(byId.values()).sort((a, b) => a.id - b.id));
  for (const closed of res.closed) for (const cb of turnClosedSubscribers) cb(root, closed);
}

/** Known turns for `root` (open turn last, if any). */
export function getTurns(root: string): Turn[] {
  return turnsByRoot.get(root) ?? [];
}

/** Overwrite `root`'s full turn list wholesale (vs. setTurnState's consume-once
 * merge). Needed after turnRollback: rolled_back is set server-side on the
 * manifest, but turn_poll only ever delivers a closed turn once, so it never
 * reaches turnsByRoot on its own — callers must re-fetch via turnList and
 * replace the cached list so the strip reflects rolled_back immediately. */
export function replaceTurns(root: string, turns: Turn[]): void {
  turnsByRoot.set(root, [...turns].sort((a, b) => a.id - b.id));
}

/** Whether `turn`'s Rollback button should be live: not itself already rolled
 * back, and no turn in the root (any id) is still open (agent mid-write). */
export function isRollbackable(turn: Turn, allTurns: Turn[]): boolean {
  return !turn.rolledBack && !allTurns.some((t) => t.boundarySource === "open");
}

/** Subscribe to turn-closed events; multiple subscribers allowed. */
export function onTurnClosed(cb: (root: string, turn: Turn) => void): void {
  turnClosedSubscribers.push(cb);
}

/** Groups review files under the newest turn (descending id) whose file list
 * contains them; files no turn claims land in a trailing turn:null group. */
export function groupHunksByTurn(
  turns: Turn[],
  files: ReviewFile[],
): { turn: Turn | null; files: ReviewFile[] }[] {
  const claimed = new Set<string>();
  const groups: { turn: Turn | null; files: ReviewFile[] }[] = [];
  for (const turn of [...turns].sort((a, b) => b.id - a.id)) {
    const paths = new Set(turn.files.map((f) => f.path));
    const matched = files.filter((f) => paths.has(f.path) && !claimed.has(f.path));
    for (const f of matched) claimed.add(f.path);
    groups.push({ turn, files: matched });
  }
  groups.push({ turn: null, files: files.filter((f) => !claimed.has(f.path)) });
  return groups;
}

/** Chip CSS class for a turn's test state; "" (no chip) when untested. */
export function turnChipClass(t: Turn): string {
  return t.testStatus?.state ? `turn-chip--${t.testStatus.state}` : "";
}

/** Count of diagnostics with line in [hunkFrom, hunkTo] (inclusive). */
export function hunkDiagBadge(diags: Diagnostic[], hunkFrom: number, hunkTo: number): number {
  return diags.filter((d) => d.line >= hunkFrom && d.line <= hunkTo).length;
}

/** `.turn-header` row (`Turn {id} · {agent} · {n} files · chip`) for the review
 * list; chip title carries the test output tail (popover), Rollback disabled
 * while any turn is still open (agent mid-write). */
export function turnHeaderEl(
  turn: Turn,
  allTurns: Turn[],
  onRollback: (turn: Turn) => void,
): HTMLElement {
  const header = document.createElement("div");
  header.className = "turn-header";
  const label = document.createElement("span");
  const n = turn.files.length;
  label.textContent = `Turn ${turn.id} · ${turn.agentKind} · ${n} file${n === 1 ? "" : "s"}`;
  header.appendChild(label);
  const chipClass = turnChipClass(turn);
  if (chipClass) {
    const chip = document.createElement("span");
    chip.className = `turn-chip ${chipClass}`;
    chip.textContent = turn.testStatus!.state;
    chip.title = turn.testStatus!.outputTail; // output-tail popover
    header.appendChild(chip);
  }
  const rollback = document.createElement("button");
  rollback.className = "turn-rollback";
  rollback.textContent = turn.rolledBack ? "rolled back" : "rollback";
  rollback.disabled = !isRollbackable(turn, allTurns);
  rollback.onclick = (ev) => {
    ev.stopPropagation();
    onRollback(turn);
  };
  header.appendChild(rollback);
  return header;
}

/** `.hunk-diag-badge` count element for a hunk row, sourced from the live
 * diagnostics store for `path`; null when no diagnostics intersect the hunk. */
export function hunkDiagBadgeEl(path: string, hunkFrom: number, hunkTo: number): HTMLElement | null {
  const count = hunkDiagBadge(getDiagnosticsFor(path), hunkFrom, hunkTo);
  if (count === 0) return null;
  const badge = document.createElement("span");
  badge.className = "hunk-diag-badge";
  badge.textContent = String(count);
  return badge;
}

export function isIntegratedAgentCommand(command: string): boolean {
  const first = command.trim().split(/\s+/, 1)[0] ?? "";
  const name = first.split("/").pop()?.toLowerCase();
  return name === "claude" || name === "codex";
}
