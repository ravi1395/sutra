---
name: Sutra
description: Minimal Rust + Tauri code editor — ink (dark) and washi (light) token system
colors:
  ink-bg-0: "#101311"
  ink-bg-1: "#131614"
  ink-bg-2: "#0e110f"
  ink-bg-3: "#161a17"
  ink-bg-4: "#1f2420"
  ink-fg: "#e8eae4"
  ink-fg-dim: "#8b9189"
  ink-fg-faint: "#565c54"
  ink-fg-ghost: "#3e443e"
  jade-signal: "#4ade93"
  jade-signal-dim: "#1f8a63"
  washi-bg-0: "#f5f2eb"
  washi-bg-2: "#f1ede3"
  washi-bg-3: "#fbf9f4"
  washi-fg: "#1f231f"
  washi-fg-dim: "#6e7268"
  washi-jade: "#0f8a5f"
  diff-added: "#e3b341"
  diff-modified: "#4493f8"
  diff-deleted: "#f0716a"
typography:
  ui:
    fontFamily: "Instrument Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  mono:
    fontFamily: "Spline Sans Mono, ui-monospace, Menlo, monospace"
    fontWeight: 400
  voice:
    fontFamily: "Fraunces, Georgia, serif"
    fontStyle: "italic"
    fontWeight: 400
rounded:
  sm: "5px"
  md: "8px"
  lg: "12px"
components:
  glyph-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-fg-dim}"
    rounded: "{rounded.sm}"
    padding: "5px 7px"
  glyph-button-active:
    backgroundColor: "{colors.jade-signal}"
    textColor: "{colors.ink-bg-1}"
    rounded: "{rounded.sm}"
  pill-chip:
    backgroundColor: "{colors.ink-bg-3}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.md}"
    padding: "4px 9px"
  dropdown-menu:
    backgroundColor: "{colors.ink-bg-3}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.lg}"
---

# Design System: Sutra — Ink & Washi

## 1. Overview

**Creative North Star: "Ink & Washi"**

Sutra is an instrument, not a platform: a dense cockpit of small, precise controls wrapped around a terminal and a diff gutter that carry the real content. The system ships two literal inks — a near-black **ink** theme and a paper-toned **washi** theme — sharing one token vocabulary so nothing is redefined per-theme, only re-valued. The system explicitly rejects the Electron/VS Code IDE-clone language: no heavy multi-panel chrome, no extension-marketplace visual sprawl, no command bloat. Density comes from restraint, not decoration — sharp, minimal, fast.

**Key Characteristics:**
- Two themes, one token set: `:root` (ink) and `.theme-washi` override the same variable names, never introduce parallel ones.
- Small type scale (9.5–15px) built for chrome density, not marketing hierarchy.
- Classic Ink/Washi uses one accent color, used as a signal, not a decoration.
- Flat at rest in Classic and Graphite; North Light is the sole in-flow sheet exception, using only its day/night elevation tokens.
- Icon-glyph and pill controls throughout — there is no marketing-style "primary CTA button".

## 2. Colors

The Classic Ink/Washi palette is a near-monochrome ink/paper ramp with a single accent breaking through, plus a fixed three-color diff vocabulary that never changes between those variants.

### Primary
- **Jade Signal** (`#4ade93` ink / `#0f8a5f` washi): Classic's one accent. Active glyph state, focused pill/tab, git-add hue, pulse dots, accent glow. Used sparingly — its rarity is what makes it legible as "this is active" rather than ambient color.

### Neutral — Ink theme (dark, default)
- **Void** (`#101311`): base app background.
- **Panel** (`#131614`): primary panel/editor surface.
- **Recess** (`#0e110f`): sunken surfaces (menu-head, recessed rows).
- **Raised** (`#161a17`): dropdowns, chips, floating panels (`--panel-bg`).
- **Lifted** (`#1f2420`): hover/emphasis surface, one step brighter than Raised.
- **Ink Text** (`#e8eae4`): primary foreground text.
- **Ink Dim** (`#8b9189`): secondary text, inactive labels.
- **Ink Faint** (`#565c54`): tertiary text, comments, placeholders.
- **Ink Ghost** (`#3e443e`): disabled/decorative-only marks.

### Neutral — Washi theme (light)
- **Washi Paper** (`#f5f2eb`): base app background — warm off-white, not clinical white.
- **Washi Recess** (`#f1ede3`): sunken surfaces.
- **Washi Raised** (`#fbf9f4`): dropdowns, chips, floating panels.
- **Washi Text** (`#1f231f`): primary foreground text.
- **Washi Dim** (`#6e7268`): secondary text.
- **Washi Jade** (`#0f8a5f`): accent, deepened for AA contrast against the paper background — never reuse the ink theme's brighter jade on washi.

### Named Rules
**The One Signal Rule (Classic Ink/Washi).** Jade is the only saturated color available for Classic UI state. If a Classic control needs to communicate "active" or "on", it reaches for jade or it reaches for nothing — never a second accent hue.

**Graphite Signal Rule.** Graphite maps the same `--em*` active/action vocabulary to one Primer blue signal (`#58a6ff`; pressed `#388bfd`). Its green/amber/red diff tokens and syntax colors remain semantic content paint, never alternate active signals.

**North Light Signal Rule.** North maps `--em*` to one ultramarine signal (day `#315bd6`; night `#8da9ff`); its green/amber/red diff tokens and syntax colors remain semantic content paint, never alternate active signals.

**Stanza Signal Rule.** Stanza maps `--em*` to one verdigris/teal signal (dusk `#63ccc0`; dawn, deepened for paper contrast, `#00706b`); its green/amber/red diff tokens and syntax colors remain semantic content paint, never alternate active signals.

**The Fixed Diff Rule.** Git-diff paint is fixed **within a view**, not across all views: `--diff-add`, `--diff-mod`, and `--diff-del` own gutter, diff-lens, hunk, and diff-file paint. Classic retains its shipped amber/blue/red literals; Graphite, North Light, and Stanza each map them to their own green/amber/red triad. App-wide `--added`, `--modified`, and `--deleted` remain status tokens — including diagnostics and invalid syntax — and are never view-revalued.

## 3. Typography

**UI Font:** Instrument Sans (with system-ui, sans-serif fallback) for Classic. North Light uses bundled Schibsted Grotesk, Graphite uses bundled Mona Sans, and Stanza uses bundled Hanken Grotesk — each for chrome only. Views re-value only `--ui`; `--mono`, persisted `editorFontFamily`, and persisted `terminalFontFamily` remain untouched and user-configurable.
**Mono Font:** The shipped editor default is Spline Sans Mono (with ui-monospace, Menlo fallback); terminal typography follows its separate persisted setting.
**Voice Font:** Fraunces italic (with Georgia, serif fallback)

**Character:** A geometric-humanist sans carries all chrome at a deliberately small base size (13px); editor and terminal content retain their selected monospace settings; an italic serif is held in reserve for rare voice moments (empty states, taglines) where the tool briefly speaks instead of just displaying.

### Hierarchy
- **Chrome label** (400–600 weight, 9.5–11px): section labels, badges, kbd hints, metadata (menu-head, auto-lab, gitbar-section).
- **Body/control** (400–500 weight, 12–13px, the base): button text, menu rows, pill labels — the majority of the UI lives here.
- **Emphasis** (500 weight, 12.5–14.5px): wordmark, active row names, current-branch label.
- **Mono/code** (400 weight, terminal default size): editor and terminal content use their persisted font settings; the shipped editor default is Spline Sans Mono.
- **Voice** (400 italic, Fraunces): reserved, sparing use only — not part of the control chrome scale.

### Named Rules
**The No-Hierarchy-Theater Rule.** This is not a marketing type scale. There is no h1/h2/h3 drama; every UI text role sits within a 9.5–15px band. If a new element needs a size outside that band to read as important, the layout is wrong, not the type.

## 4. Elevation

Flat by default. Classic, Graphite, and Stanza surfaces carry no ambient shadow at rest — depth is conveyed by the bg-0→bg-4 tonal step, not by blur. Shadow exists only as a structural signal that a surface is floating above the layout: dropdowns, popovers, and modals. North Light is the sole intentional exception: its in-flow sheets use only the day/night `--sheet-shadow` token, and its terminal may use `--term-shadow`. Shadow color stays literal black (`rgba(0,0,0,X)`) in Classic/Graphite/Stanza by convention rather than re-deriving per-theme.

### Shadow Vocabulary
- **Dropdown** (`box-shadow: 0 4px 12px rgba(0,0,0,0.3)`): gitbar and lightweight dropdown menus.
- **Floating panel** (`box-shadow: 0 10px 28px rgba(0,0,0,0.45)`): automation drawer, deeper popovers that sit further above the surface.

### Named Rules
**The Floating-Only Rule.** In Classic, Graphite, and Stanza, shadow appears exclusively on elements that are `position: absolute/fixed` above the base layout. North Light alone may elevate its static sheets through `--sheet-shadow` and its terminal through `--term-shadow`; any other in-flow shadow is a bug.

## 5. Components

Every control is small, dense, and icon- or label-led — there is no large marketing-style primary button anywhere in the system.

### Glyph Buttons
- **Shape:** 5px radius (`--r-sm`), ~5–7px padding, icon-only.
- **Default:** transparent background, `ink-fg-dim` icon color.
- **Hover:** `ink-bg-4`/washi-equivalent background step.
- **Active/on** (`.glyph.on`): jade-tinted background or icon, the primary way state reads as "engaged" (e.g. terminal toggle).

### Sidebar Buttons (`.sbtn`)
- **Style:** transparent, icon-only, same radius/hover language as glyph buttons; `.reveal` variant appears only on parent hover (progressive disclosure, not always-visible chrome).

### Pills & Chips (`.ws-pill`, `.gitbar-chip`, `.auto-chip`)
- **Shape:** 8px radius (`--r-md`), 4px/9px padding, 12–12.5px label.
- **Style:** `bg-3`/raised background, hover steps to `bg-4`; workspace pill and branch chip carry a chevron/name pair rather than a border to indicate "expandable".
- **Live state:** `.auto-chip` and `.auto-dot` use a jade pulse animation (with `prefers-reduced-motion` fallback to static) to show a running process — motion as status signal, not decoration.

### Dropdown Menus (`.menu-card`, `.auto-dd`, `.gitbar-dropdown`)
- **Corner style:** 12px radius (`--r-lg`) for menu cards, 8px for smaller action dropdowns.
- **Background:** raised surface (`--panel-bg` / `bg-3`).
- **Shadow strategy:** see Elevation — this is the primary consumer of the shadow vocabulary.
- **Rows:** 8–14px padding, hover to `bg-4`, `.current`/`.cur` marked with jade-tinted background wash (`--em-wash-row`), never a border-left stripe.

### Keyboard Badge (`.kbd`)
- **Style:** 5px radius, 1px/6px padding, 11px mono-adjacent label — a literal small pill representing a physical key.

### Diff Gutter (signature component)
- Line-level markers using the fixed diff palette: amber underline/bar for added, blue for modified, red for deleted. Never uses jade — jade is reserved for interactive/active state, diff colors are reserved for git semantics. This is the component the rest of the chrome exists to support; it must never be visually subordinate to surrounding UI.

## 6. Do's and Don'ts

### Do:
- **Do** keep ink and washi on one token set — a new color must be added as a variable pair in both `:root` and `.theme-washi`, never hardcoded per-theme.
- **Do** keep the type scale inside 9.5–15px for all UI chrome; let mono/terminal content set its own size independently.
- **Do** reserve Classic jade (`#4ade93` / `#0f8a5f`) for active/on/signal state only; Graphite, North Light, and Stanza each follow their own separate one-signal rule.
- **Do** keep shadows literal black and reserved for floating/overlay surfaces only.
- **Do** favor icon-glyph and pill controls consistent with the existing dense, instrumented chrome; a new control should look like it belongs next to `.glyph`/`.sbtn`, not like an imported design-system button.

### Don't:
- **Don't** build toward an Electron/VS Code-clone look — no heavy multi-panel chrome, no extension-marketplace visual language, no sprawling top-level menu bloat.
- **Don't** introduce a second saturated active accent within a view; Classic uses jade, Graphite uses Primer blue, North Light uses ultramarine, and Stanza uses verdigris/teal. Use diff colors only for git semantics, or a neutral tonal step for non-active distinctions.
- **Don't** use `border-left` as a colored accent stripe for "current"/"active" rows — use the view-scoped signal wash (`--em-wash-row`; jade in Classic, Primer blue in Graphite, ultramarine in North Light, verdigris/teal in Stanza).
- **Don't** add card-style elevation/shadow to static, in-flow panels; flat is the resting state everywhere except dropdowns and popovers.
- **Don't** reach for Fraunces/voice type for UI chrome — it is reserved for rare, deliberate voice moments, not headings or labels.
