// Worktree sessions dashboard (harness v2): pure row model (buildRows /
// shouldFullPoll / aggregate) plus the panel. Refresh loop: listWorktreeRoots →
// cheap agentTrackingPoll per root → expensive turnList only where
// shouldFullPoll passes → per-section re-render.
import {
  agentTrackingPoll,
  hookInstall,
  hookStatus,
  listWorktreeRoots,
  turnList,
  type Turn,
  type WorktreeRoot,
} from "./ipc";

export interface SessionRow {
  root: string;
  label: string;
  branch: string;
  agentKind: string | null;
  busy: boolean;
  pendingFiles: number;
  latestTurn: Turn | null;
}

export interface RootPoll {
  agentKind: string | null;
  pending: number;
  turns: Turn[];
}

/** Last path segment (worktree display label). */
function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Most recent turn by id (ids are monotonic per root). */
function latestOf(turns: Turn[]): Turn | null {
  if (turns.length === 0) return null;
  return turns.reduce((latest, t) => (t.id > latest.id ? t : latest));
}

/**
 * Assemble rows: primary first (label "workspace"), then worktrees sorted by
 * branch. A root missing from `polls` never throws — it renders with
 * agentKind:null, pendingFiles:0, latestTurn:null.
 */
export function buildRows(
  primary: string,
  worktrees: WorktreeRoot[],
  polls: Map<string, RootPoll>,
): SessionRow[] {
  const rowFor = (root: string, label: string, branch: string): SessionRow => {
    const poll = polls.get(root);
    return {
      root,
      label,
      branch,
      agentKind: poll?.agentKind ?? null,
      busy: (poll?.agentKind ?? null) !== null,
      pendingFiles: poll?.pending ?? 0,
      latestTurn: poll ? latestOf(poll.turns) : null,
    };
  };
  const sorted = [...worktrees].sort((a, b) => a.branch.localeCompare(b.branch));
  return [
    rowFor(primary, "workspace", ""),
    ...sorted.map((w) => rowFor(w.path, lastSegment(w.path), w.branch)),
  ];
}

/** Gate for the expensive per-root poll: agent detected OR pending changes. */
export function shouldFullPoll(row: { agentKind: string | null; pendingFiles: number }): boolean {
  return row.agentKind !== null || row.pendingFiles > 0;
}

/**
 * Merge full-poll turns into a cheap poll. The turn-derived agent kind refines
 * the cheap kind only when the cheap poll detected a live agent — historical
 * (closed) turns must never flip an idle root to busy.
 */
export function refinePoll(cheap: RootPoll, turns: Turn[]): RootPoll {
  return {
    pending: cheap.pending,
    turns,
    agentKind: cheap.agentKind === null ? null : latestOf(turns)?.agentKind ?? cheap.agentKind,
  };
}

/** Sum pending files; count rows whose latest turn's test state is "fail". */
export function aggregate(rows: SessionRow[]): { pending: number; failingTurns: number } {
  return rows.reduce(
    (acc, r) => ({
      pending: acc.pending + r.pendingFiles,
      failingTurns: acc.failingTurns + (r.latestTurn?.testStatus?.state === "fail" ? 1 : 0),
    }),
    { pending: 0, failingTurns: 0 },
  );
}

// --- Panel state ---

const expanded = new Set<string>(); // roots expanded in-memory (not persisted)
const hookOffers = new Map<string, boolean>(); // root → claude hook missing
let latestRows: SessionRow[] = [];
let primaryRootGetter: (() => string | null) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;

function turnChipText(turn: Turn | null): string {
  if (!turn) return "";
  const state = turn.testStatus?.state;
  return state ? ` · Turn ${turn.id} ${state}` : ` · Turn ${turn.id}`;
}

function renderSection(row: SessionRow): HTMLElement {
  const section = document.createElement("div");
  section.className = "session-section";
  section.dataset.root = row.root;

  const header = document.createElement("div");
  header.className = "session-section__header";
  header.addEventListener("click", () => {
    if (expanded.has(row.root)) expanded.delete(row.root);
    else expanded.add(row.root);
    renderPanel();
  });

  const badge = document.createElement("span");
  badge.className = row.busy ? "session-badge--busy" : "session-badge--idle";
  header.appendChild(badge);

  const title = document.createElement("span");
  const branchPart = row.branch ? ` (${row.branch})` : "";
  title.textContent =
    `${row.label}${branchPart} · ${row.agentKind ?? "idle"} · ` +
    `${row.pendingFiles} files${turnChipText(row.latestTurn)}`;
  header.appendChild(title);

  // One-click hook install for agent-active roots without a turn-signal hook.
  if (row.busy && hookOffers.get(row.root)) {
    const btn = document.createElement("button");
    btn.className = "session-hook-install";
    btn.textContent = "Install turn hook";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await hookInstall(row.root, "claude");
        hookOffers.set(row.root, false);
        renderPanel();
      } catch {
        /* offer stays visible for retry */
      }
    });
    header.appendChild(btn);
  }

  section.appendChild(header);

  if (expanded.has(row.root)) {
    const body = document.createElement("div");
    body.className = "session-section__body";
    for (const file of row.latestTurn?.files ?? []) {
      const line = document.createElement("div");
      line.className = "session-file-row";
      line.textContent = file.path;
      line.addEventListener("click", () => {
        // Contract (addendum): window target, detail {path, line?, col?}; path absolute.
        const abs = file.path.startsWith("/") ? file.path : `${row.root}/${file.path}`;
        window.dispatchEvent(new CustomEvent("sutra:goto", { detail: { path: abs } }));
      });
      body.appendChild(line);
    }
    section.appendChild(body);
  }

  return section;
}

/** Re-render the panel and aggregate strip from cached rows (no IPC). */
function renderPanel(): void {
  sessionsPanelEl().replaceChildren(...latestRows.map(renderSection));
  const totals = aggregate(latestRows);
  aggregateStripEl().textContent = `${totals.pending} pending · ${totals.failingTurns} failing`;
}

/** Wire the sessions refresh loop to the primary workspace root (3 s). */
export function initSessions(primaryRoot: () => string | null): void {
  primaryRootGetter = primaryRoot;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => void refreshSessions(), 3000);
  void refreshSessions(); // immediate first paint; don't wait 3 s
}

/** Re-query worktree roots + per-root state and re-render the panel. */
export async function refreshSessions(): Promise<void> {
  if (refreshing) return; // skip overlapping ticks
  const primary = primaryRootGetter?.();
  if (!primary) return;
  refreshing = true;
  try {
    let worktrees: WorktreeRoot[] = [];
    try {
      worktrees = await listWorktreeRoots(primary);
    } catch {
      worktrees = [];
    }

    const roots = [primary, ...worktrees.map((w) => w.path)];
    const polls = new Map<string, RootPoll>();

    // Cheap poll: agent active + pending count per root; never let one root fail the pass.
    await Promise.all(
      roots.map(async (root) => {
        try {
          const st = await agentTrackingPoll(root);
          polls.set(root, {
            agentKind: st.agentActive ? "agent" : null,
            pending: st.changes.length,
            turns: [],
          });
        } catch {
          /* row falls back to empty via buildRows */
        }
      }),
    );

    // Expensive poll: turns (and hook offer) only for active/pending roots.
    await Promise.all(
      roots.map(async (root) => {
        const cheap = polls.get(root);
        if (!cheap || !shouldFullPoll({ agentKind: cheap.agentKind, pendingFiles: cheap.pending }))
          return;
        try {
          const turns = await turnList(root);
          polls.set(root, refinePoll(cheap, turns));
        } catch {
          /* keep cheap-poll data */
        }
        try {
          const hs = await hookStatus(root);
          hookOffers.set(root, !hs.claude);
        } catch {
          hookOffers.set(root, false);
        }
      }),
    );

    // Vanished roots: drop stale expand/offer state.
    const live = new Set(roots);
    for (const r of [...expanded]) if (!live.has(r)) expanded.delete(r);
    for (const r of [...hookOffers.keys()]) if (!live.has(r)) hookOffers.delete(r);

    latestRows = buildRows(primary, worktrees, polls);
    renderPanel();
  } finally {
    refreshing = false;
  }
}

let sessionsPanel: HTMLElement | null = null;
/** Singleton sessions-panel root (id="sessions-panel"). */
export function sessionsPanelEl(): HTMLElement {
  if (!sessionsPanel) {
    sessionsPanel = document.createElement("div");
    sessionsPanel.id = "sessions-panel";
  }
  return sessionsPanel;
}

let aggregateStrip: HTMLElement | null = null;
/** Singleton aggregate strip (id="harness-aggregate"). */
export function aggregateStripEl(): HTMLElement {
  if (!aggregateStrip) {
    aggregateStrip = document.createElement("div");
    aggregateStrip.id = "harness-aggregate";
  }
  return aggregateStrip;
}
