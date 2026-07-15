# Turn UX Rehaul — Design

Date: 2026-07-16 · Branch: v2.3.3 · Status: approved (design), plan pending

## Problem

The turn strip (`renderTurnStrip()` `src/main.ts:1124`) prepends one `.turn-header`
row per closed turn *inside* `#diff-pane`, above the file diff list. Long agent
sessions accumulate 70+ turns, so the strip linearly consumes the entire git
diff panel. Rows carry a `rollback` button only — not clickable, no timestamps,
no grouping — and quiet-window turns render a literal `unknown` agent label.

Root cause is placement, not data volume: any N > ~5 steals the diff surface.

## Decisions log (user-confirmed)

1. Design center: **diff first, turns secondary** — turn UI shrinks to near-zero
   at rest, summoned on demand.
2. Resting affordance: **one collapsed summary row** atop the diff pane (not a
   statusbar chip, not a side rail).
3. Volume handling: **recent N (~6) + "older…"** paging, not grouped sessions,
   not a full flat scroll.
4. Row click: **scope the diff pane to that turn** (per-turn review before
   rollback), not inline expansion, not passive rows.
5. Scope: full P1–P3 approved as one design.

## Rejected / infeasible

- **Side rail dock** (annotations-rail pattern) — adds persistent chrome for a
  secondary feature; rejected by decision 1.
- **Statusbar chip** — removes the affordance from the context where it's used
  (diff review); rejected in favor of in-pane summary row.
- **Reusing an existing snapshot-read IPC for P2** — none exists. `turn_rollback`
  (`src-tauri/src/turns.rs:853`) restores files server-side; no command returns
  blob content to the frontend. P2 requires a new command.

## Design

### 1. Resting state — collapsed summary row (P1)

Replace the per-turn stack with a single `.turn-summary` row at the top of
`#diff-pane`:

```
⟲ 71 turns · claude · 2m ago  [✓]
```

- Segments: turn count · latest closed turn's agent · relative time since its
  `closedAt` · latest turn's `testStatus` chip (reuse `.turn-chip--*` styles,
  `src/styles.css:3718`).
- Hidden entirely (`display:none`) when 0 turns — unchanged from today.
- While a turn is **open** (`closedAt == null`): pulsing dot + `turn open · 3 files…`;
  rollback remains locked (existing behavior).

### 2. Expanded dropdown (P1)

Click summary row → dropdown anchored beneath it, overlaying the file list:

- `max-height: 40%` of `#diff-pane`, `overflow-y: auto`.
- Last **6** closed turns, newest first. Synthetic `boundarySource == "rollback"`
  turns stay filtered (existing filter, `src/main.ts:1180`).
- Row format: `Turn 71 · claude · 5 files · 2m ago  [test chip]  [↶]`.
  - `agentKind == "unknown"` renders as `agent` — quiet-window boundaries have
    no Stop-hook reporter, so attribution is genuinely absent; degrade the
    label, don't surface internals.
  - `rolledBack` turns: dimmed + strikethrough label; rollback button hidden.
- Footer `older turns…` loads +20 per click (P3; P1 may ship with footer stub
  showing remaining count).
- Dismiss: Esc, outside click, or re-click summary row.

### 3. Turn-scoped diff mode (P2)

Click a row body (not the rollback button):

- Diff pane file list scopes to `turn.files`.
- Diff shown is **that turn's change**: before-blob vs after-blob from the
  content-addressed store `.sutra/turns/objects` — NOT before vs current
  worktree, which would smear in every later turn's edits on the same file.
- Breadcrumb bar atop the pane: `Viewing Turn 71 · ✕ back to working tree`,
  plus the rollback button — inspect-then-revert flow.
- Exit: ✕, Esc, or route/root change → restore normal git-HEAD diff.

**New IPC** (follows repo IPC rule: turns.rs → lib.rs → ipc.ts):

```
turn_file_content(root: String, turn_id: u64, path: String)
  -> Result<TurnFileContent, String>
// TurnFileContent { before: Option<String>, after: Option<String>, snapshotted: bool }
```

Reads both blobs for `path` in that turn. Semantics: `before == None` +
snapshotted → file created in turn (whole-file-added diff); `after == None` +
snapshotted → deleted in turn (whole-file-deleted diff); `snapshotted == false`
(>10 MB cap / unreadable / `unsafe_before`) → frontend falls back to
git-HEAD-vs-worktree for that file and badges the row (`~HEAD`).

### 4. Attribution & polish (P1)

- `unknown` → `agent` label mapping in `turnHeaderEl()` (`src/agent-tracking.ts:156`).
- Relative timestamps from `closedAt` (fall back to `openedAt`).
- No backend change — attribution absence is structural (quiet-window close).

## Data flow

`turnList()` (`src/ipc.ts:476` → `turn_list`, `turns.rs:825`) already returns
everything P1 needs: `id, agentKind, boundarySource, openedAt, closedAt,
files[], testStatus, rolledBack`. P1 is pure frontend. P2 adds one read-only
IPC command; no manifest/store format changes.

## Error handling / edge cases

| Case | Behavior |
|---|---|
| 0 turns | summary row hidden (today's behavior) |
| Turn open | summary shows live state; rollback locked; scoped view disabled for open turn |
| Rolled-back turn | dimmed row, no rollback button; scoped view still allowed |
| Snapshot missing / >10 MB | per-file HEAD-vs-worktree fallback + `~HEAD` badge |
| File created in turn | before = None → whole-file-added diff in scoped mode |
| File deleted in turn | after = None → whole-file-deleted diff in scoped mode |
| Root/route change while scoped | exit scoped mode, restore HEAD baseline |
| `turn_file_content` error | toast + per-file HEAD fallback, never blank pane |

## Testing

- P1: extend `tests/agent-tracking.test.ts` — summary-row label rendering
  (counts, `unknown`→`agent`, relative time), dropdown recent-6 slicing,
  rolledBack row state. `tests/main` fake-DOM bubbling pattern (5e9ac61) for
  expand/collapse.
- P2: Rust unit tests in `turns.rs` for `turn_file_content` (before/after blob
  hit, created-file `before: None`, deleted-file `after: None`, unsnapshotted
  flag); TS test for before-vs-after diff classification via `diff.ts`.
- Live-app rows go to VERIFY-LEDGER.md (pure-UI: dropdown feel, breadcrumb,
  scoped-diff correctness) → `sutra-smoke`.

## Phasing

- **P1** — summary row + dropdown + label/time polish. Files: `src/main.ts`,
  `src/agent-tracking.ts`, `src/styles.css` (+ tests). Pure frontend.
- **P2** — turn-scoped diff. Files: `src-tauri/src/turns.rs`, `src-tauri/src/lib.rs`,
  `src/ipc.ts`, `src/main.ts`/`src/diff.ts` (+ tests). One new IPC.
- **P3** — `older…` paging + open-turn live row treatment. Frontend only.

Each phase independently mergeable; P1 alone resolves the reported problem.
