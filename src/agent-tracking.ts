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

/** Optimistically mark `turnId` rolled back in the local cache. Fallback for
 * when the authoritative turnList re-fetch after a rollback fails (IPC error):
 * without it the strip keeps a live Rollback button and re-applying no-ops into
 * a false success. A later successful replaceTurns overwrites this. */
export function markRolledBack(root: string, turnId: number): void {
  const turns = turnsByRoot.get(root);
  const turn = turns?.find((t) => t.id === turnId);
  if (turn) turn.rolledBack = true;
}

/** Of `ids`, the turn-test runner ids a cancel actually KILLED (returned true).
 * Only these may be suppressed in onRunnerDone — poisoning an id with nothing
 * running (cancel → false, e.g. a still-open newer turn whose test hasn't
 * started, or a rollback the backend then rejects) would silently drop that
 * turn's future *legitimate* test result. */
export async function suppressibleCancelledIds(
  ids: string[],
  cancel: (id: string) => Promise<boolean>,
): Promise<string[]> {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return (await cancel(id)) ? id : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((id): id is string => id !== null);
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

/** `agentKind == "unknown"` (quiet-window boundaries have no Stop-hook
 * reporter, so attribution is genuinely absent) degrades to the user-facing
 * "agent" label rather than surfacing the internal sentinel. */
export function agentLabel(agentKind: string): string {
  return agentKind === "unknown" ? "agent" : agentKind;
}

/** Coarse relative-time bucket from `fromMs` to `nowMs`: "just now" (<60s),
 * "{n}m ago" (<60m), "{n}h ago" (<24h), else "{n}d ago". Never negative. */
export function relTime(fromMs: number, nowMs: number): string {
  const deltaS = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (deltaS < 60) return "just now";
  const deltaM = Math.floor(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.floor(deltaM / 60);
  if (deltaH < 24) return `${deltaH}h ago`;
  return `${Math.floor(deltaH / 24)}d ago`;
}

const isSyntheticTurn = (t: Turn) => t.boundarySource === "rollback";

/** Closed (non-open, non-synthetic-rollback) turns, newest-closed first. */
export function closedTurns(turns: Turn[]): Turn[] {
  return turns
    .filter((t) => !isSyntheticTurn(t) && t.closedAt != null)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
}

/** The still-open turn for a root, if any (`closedAt == null`). */
export function openTurnOf(turns: Turn[]): Turn | undefined {
  return turns.find((t) => t.closedAt == null);
}

/** Last `limit` closed turns, newest first — dropdown contents. */
export function recentClosedTurns(turns: Turn[], limit = 6): Turn[] {
  return closedTurns(turns).slice(0, limit);
}

/** Count of closed turns beyond the dropdown's `limit` — footer stub count. */
export function olderTurnsCount(turns: Turn[], limit = 6): number {
  return Math.max(0, closedTurns(turns).length - limit);
}

export type TurnSummaryState =
  | { kind: "hidden" }
  | { kind: "open"; fileCount: number }
  | { kind: "resting"; count: number; agent: string; relTime: string; chipClass: string; chipLabel: string };

/** Resting-vs-open-vs-hidden state for the `.turn-summary` row, derived from
 * `turns` as of `nowMs`. `count` is non-synthetic CLOSED turns only. */
export function turnSummaryState(turns: Turn[], nowMs: number): TurnSummaryState {
  const open = openTurnOf(turns);
  if (open) return { kind: "open", fileCount: open.files.length };
  const closed = closedTurns(turns);
  if (closed.length === 0) return { kind: "hidden" };
  const latest = closed[0];
  return {
    kind: "resting",
    count: closed.length,
    agent: agentLabel(latest.agentKind),
    relTime: relTime(latest.closedAt ?? latest.openedAt, nowMs),
    chipClass: turnChipClass(latest),
    chipLabel: latest.testStatus?.state ?? "",
  };
}

/** `.turn-summary` row: `⟲ {N} turns · {agent} · {relTime} [chip]` at rest, or
 * a pulsing-dot "turn open · {n} files…" while a turn is open. Caller wires
 * `onClick` (dropdown toggle) and hides the row itself (e.g. leaves the
 * mount point empty) when state is "hidden". */
export function turnSummaryEl(turns: Turn[], nowMs: number, onClick: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "turn-summary";
  row.onclick = onClick;
  const state = turnSummaryState(turns, nowMs);
  if (state.kind === "hidden") {
    row.style.display = "none";
    return row;
  }
  const label = document.createElement("span");
  label.className = "turn-summary-label";
  if (state.kind === "open") {
    const dot = document.createElement("span");
    dot.className = "turn-summary-dot";
    row.appendChild(dot);
    const n = state.fileCount;
    label.textContent = `turn open · ${n} file${n === 1 ? "" : "s"}…`;
    row.appendChild(label);
    return row;
  }
  const n = state.count;
  label.textContent = `⟲ ${n} turn${n === 1 ? "" : "s"} · ${state.agent} · ${state.relTime}`;
  row.appendChild(label);
  if (state.chipLabel) {
    const chip = document.createElement("span");
    chip.className = `turn-chip ${state.chipClass}`;
    chip.textContent = state.chipLabel;
    row.appendChild(chip);
  }
  return row;
}

/** `.turn-header` row (`Turn {id} · {agent} · {n} files · {relTime} [chip] [↶]`)
 * used both standalone and as a `.turn-dropdown` row; chip title carries the
 * test output tail (popover). Rolled-back turns render dimmed + strikethrough
 * with the rollback button hidden entirely (nothing left to roll back).
 * Otherwise Rollback is disabled while any turn is still open (agent mid-write). */
export function turnHeaderEl(
  turn: Turn,
  allTurns: Turn[],
  nowMs: number,
  onRollback: (turn: Turn) => void,
): HTMLElement {
  const header = document.createElement("div");
  header.className = "turn-header" + (turn.rolledBack ? " turn-header--rolled-back" : "");
  const label = document.createElement("span");
  label.className = "turn-header-label";
  const n = turn.files.length;
  const when = relTime(turn.closedAt ?? turn.openedAt, nowMs);
  label.textContent = `Turn ${turn.id} · ${agentLabel(turn.agentKind)} · ${n} file${n === 1 ? "" : "s"} · ${when}`;
  header.appendChild(label);
  const chipClass = turnChipClass(turn);
  if (chipClass) {
    const chip = document.createElement("span");
    chip.className = `turn-chip ${chipClass}`;
    chip.textContent = turn.testStatus!.state;
    chip.title = turn.testStatus!.outputTail; // output-tail popover
    header.appendChild(chip);
  }
  if (!turn.rolledBack) {
    const rollback = document.createElement("button");
    rollback.className = "turn-rollback";
    rollback.textContent = "rollback";
    rollback.disabled = !isRollbackable(turn, allTurns);
    rollback.onclick = (ev) => {
      ev.stopPropagation();
      onRollback(turn);
    };
    header.appendChild(rollback);
  }
  return header;
}

/** `.turn-dropdown` overlay: last `limit` closed turns (newest first) via
 * `turnHeaderEl`, plus a non-interactive "{n} older turns…" footer stub when
 * more exist (paging lands in a later task). */
export function turnDropdownEl(
  turns: Turn[],
  nowMs: number,
  onRollback: (turn: Turn) => void,
  limit = 6,
): HTMLElement {
  const dropdown = document.createElement("div");
  dropdown.className = "turn-dropdown";
  for (const turn of recentClosedTurns(turns, limit)) {
    dropdown.appendChild(turnHeaderEl(turn, turns, nowMs, onRollback));
  }
  const older = olderTurnsCount(turns, limit);
  if (older > 0) {
    const footer = document.createElement("div");
    footer.className = "turn-dropdown-footer";
    footer.textContent = `${older} older turn${older === 1 ? "" : "s"}…`;
    dropdown.appendChild(footer);
  }
  return dropdown;
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
