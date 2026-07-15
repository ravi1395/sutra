# Annotation rail placement — design

**Date:** 2026-07-15
**Status:** approved, ready for planning
**Scope:** single implementation plan (UI placement of the annotation list)

## Problem

The annotation list (`#annotation-list`) is a 260px panel pinned
`position: absolute; right: 0; top: 0` inside `#browser-area`, floating **on top
of** the preview/browser iframe. Two concrete pains:

1. **Covers app content** — the top-right corner is exactly where most previewed
   apps put their own chrome (nav, account menu, close), so the panel occludes it.
2. **Fixed / immovable** — no way to move it out of the way, dock elsewhere, or
   collapse it.

## Decision

**Direction A — side-dock reflow rail.** The panel stops being an overlay and
becomes a real flex column beside the iframe. The iframe reflows to the remaining
width, so it is **never occluded**. The rail can flip dock side and collapse to a
thin spine.

Rejected alternatives (killed against the real pains):
- **B — bottom drawer:** frees the corners but steals scarce vertical preview
  height and reads awkwardly for a vertical list.
- **C — margin pins + popovers:** best UX but requires per-annotation Y tracking
  *across the sandboxed iframe boundary* via postMessage — far larger build, and
  neither stated pain requires per-selection anchoring.

## Locked decisions

1. Rail **reflows** the iframe (flex column), never overlays it.
2. Default dock side = **right** (preserves current muscle memory); a header
   control toggles **left ↔ right**.
3. Collapsed state = **26px spine** with an emerald count badge; click the spine
   to expand.
4. **Empty state = hidden entirely.** No change needed — `render()` already hides
   the panel when `!armed && anns.length === 0`
   ([annotations.ts:201-203](../../../src/annotations.ts)). The rail simply
   inherits this: absent until annotate mode is armed or ≥1 annotation exists.
5. Persist **dock side + collapsed** globally in `UserSettings`
   ([settings.ts:4](../../../src/settings.ts)) — one preference across all
   projects/windows, matching how Sutra stores other layout prefs. Session-only
   and per-project scopes rejected as under/over-engineered for a layout toggle.

## Architecture

### Layout (index.html + styles.css)

`#browser-area` today is `flex-direction: column` holding `#browser-header`,
`#browser-frame`, and the absolute `#annotation-list`.

Introduce a flex-row body wrapping the frame and the rail:

```
#browser-area  (column)
├── #browser-header            (unchanged, 40px)
└── #browser-body  (row, flex:1, min-height:0)   ← NEW wrapper
    ├── #browser-frame         flex: 1  (reflows)
    └── #annotation-list       flex: 0 0 var(--ann-rail-w)   (was position:absolute)
```

- Remove `position: absolute; right: 0; top: 0` from `.annotation-list`; it
  becomes an in-flow flex child with a fixed basis (expanded ≈ 240–260px,
  collapsed 26px).
- **Left dock** = `#browser-body { flex-direction: row-reverse }` (or an
  `order`/border-side swap); the rail's divider border moves to the opposite edge.
- `.annotation-list.hidden { display: none }` already exists → empty state and
  `browser-maximized` keep working.

### Rail chrome (annotations.ts)

`render()` gains a small header row (rendered as the first child of `listEl`):
- **Dock-toggle** button → flips `settings.annotationDockSide`, re-applies the
  body class, persists.
- **Collapse** button → sets `settings.annotationRailCollapsed`, persists,
  re-renders.

Collapsed render path: instead of the header + rows, emit a single spine element
(badge = `anns.length`) whose click expands. Guard: when collapsed, skip building
rows (cheap).

State plumbing: the panel needs read/write access to the two settings. Pass a
small `RailLayout` accessor into the constructor (getter + setter callbacks) so
`AnnotationsPanel` stays decoupled from the settings module — mirrors how it
already takes `persistence` and task callbacks. `main.ts` wires the accessor to
`settings.ts` load/save.

### Settings (settings.ts)

Add to `UserSettings`:
```ts
annotationDockSide: "left" | "right";   // default "right"
annotationRailCollapsed: boolean;        // default false
```
Extend `deserializeSettings` (with a `pickBool` + a small `pickDockSide` helper
and defaults) and `serializeSettings`. Back-compat: missing keys → defaults, so
existing stored settings load cleanly.

## Units & boundaries

- **`AnnotationsPanel`** (annotations.ts) — owns rail chrome + collapse/dock
  rendering. Depends on: a `RailLayout` accessor (inject), the existing `listEl`.
  Testable: given N annotations + layout state, assert DOM (spine vs rows, dock
  class, badge count) without touching settings storage.
- **`settings.ts`** — owns serialization + defaults for the two new fields.
  Testable in isolation (round-trip, missing-key defaults).
- **`main.ts`** — wiring only: constructs the accessor over load/save.

## Error handling / edge cases

- Corrupt/missing settings → defaults (right, expanded). Existing deserialize
  guard pattern covers this.
- `browser-maximized` class still hides via existing rule; rail rides along inside
  `#browser-body`.
- Very narrow `#browser-area`: expanded rail has a fixed basis; iframe `min-width:
  0` lets it shrink. If the area is narrower than the rail basis, the user can
  collapse to the 26px spine.
- Left-dock border side must swap so the divider sits between frame and rail, not
  on the outer edge.

## Testing

- **settings.test.ts** — round-trip the two new fields; missing-key → defaults;
  invalid dock-side string → `"right"`.
- **annotations.test.ts** — render with layout state: (a) collapsed → single
  spine + correct badge count, no rows; (b) expanded + `dockSide:"left"` → body
  gets left-dock class; (c) dock-toggle click invokes the setter; (d) empty +
  disarmed → `.hidden` (regression guard on existing behavior).
- **Live (VERIFY-LEDGER):** annotate a localhost app, confirm iframe reflows
  (top-right app chrome no longer covered), toggle dock L/R, collapse/expand,
  restart → state restored from settings.

## Out of scope

- Per-annotation margin pins / popovers (Direction C).
- Drag-to-resize the rail width (fixed basis for now; add later if asked).
- Any change to annotation creation, the postMessage protocol, or store.
