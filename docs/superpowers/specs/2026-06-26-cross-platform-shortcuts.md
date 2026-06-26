# Cross-Platform Shortcut Parity

**Date:** 2026-06-26  
**Status:** Approved  
**Scope:** 5 TS files — `src/shortcuts.ts` + 4 update sites

---

## Problem

Platform detection and shortcut formatting are fragmented across 3 files with 3 different patterns:

| File | Pattern | Issue |
|---|---|---|
| `terminal.ts:286` | `navigator.platform.toUpperCase().indexOf("MAC")` | deprecated API, locally scoped |
| `composer.ts:78` | `/Mac|iPhone|iPad/.test(navigator.userAgent)` | different regex, locally scoped |
| `main.ts:1101` | `e.metaKey \|\| e.ctrlKey` | works cross-platform but semantically opaque |

Shortcut display strings in `APP_COMMANDS` always use Mac symbols (`⌘N`, `⇧⌘S`) even on Windows/Linux.

CM6 editor keybinds (`Mod-s`, `Mod-f`) are already cross-platform via CM6's built-in handling — no change needed.

---

## Goal

- Single source of truth for platform detection and modifier key logic
- Functional shortcut parity: same actions reachable on Mac, Windows, Linux
- Display parity: palette and settings modal show platform-appropriate symbols

---

## Design

### 1. `src/shortcuts.ts` — new exports

```ts
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

// True if the platform modifier key is held (Cmd on Mac, Ctrl elsewhere)
export function isMod(e: Pick<KeyboardEvent, "metaKey" | "ctrlKey">): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

// Format a shortcut string for display, platform-aware
// fmtShortcut("S", { shift: true }) → "⇧⌘S" on Mac, "Ctrl+Shift+S" on Windows
export function fmtShortcut(key: string, mods: { shift?: boolean; alt?: boolean } = {}): string {
  return IS_MAC
    ? `${mods.shift ? "⇧" : ""}${mods.alt ? "⌥" : ""}⌘${key}`
    : `${mods.shift ? "Shift+" : ""}${mods.alt ? "Alt+" : ""}Ctrl+${key}`;
}
```

`isPreviewShortcut` accepts `metaKey || ctrlKey` — correct as-is.

### 2. Update sites

**`src/terminal.ts:286-287`**  
Remove inline `isMac`/`isMod` locals. Import and use `IS_MAC`, `isMod` from `./shortcuts`.

**`src/composer.ts:78,126`**  
Remove inline `isMac` local. Import `IS_MAC`.  
`"Send ${isMac ? "⌘" : "Ctrl"}↵"` → `"Send ${IS_MAC ? "⌘" : "Ctrl+"}↵"`

**`src/main.ts:1101`**  
`const mod = e.metaKey || e.ctrlKey` → `const mod = isMod(e)`

**`src/main.ts:1460-1491`** — `APP_COMMANDS` display strings:

| Before | After |
|---|---|
| `"⌘N"` | `fmtShortcut("N")` |
| `"⌘S"` | `fmtShortcut("S")` |
| `"⇧⌘S"` | `fmtShortcut("S", { shift: true })` |
| `"⌥⌘S"` | `fmtShortcut("S", { alt: true })` |
| `"⌘O"` | `fmtShortcut("O")` |
| `"⌘W"` | `fmtShortcut("W")` |
| `"⌘J"` | `fmtShortcut("J")` |
| `"⌘B"` | `fmtShortcut("B")` |
| `"⌘\\"` | `fmtShortcut("\\")` |
| `"⇧⌘F"` | `fmtShortcut("F", { shift: true })` |
| `"⌘,"` | `fmtShortcut(",")` |

Debug shortcuts (`F5`, `F6`, `F10`, `F11`, `⇧F5`, `⇧F11`) are function keys — same on all platforms, unchanged.

---

## Out of Scope

- Rust/Tauri side: no native menu shortcuts to change
- CM6 editor keybinds: already cross-platform via `Mod-` prefix
- Adding new shortcuts not already present on Mac

---

## Verification

| Check | Method |
|---|---|
| `IS_MAC` resolves correctly | `console.log(IS_MAC)` in dev console per platform |
| Terminal Ctrl+C copies on Windows | manual: select text, Ctrl+C in terminal |
| Terminal Cmd+C copies on Mac | manual: select text, Cmd+C in terminal |
| Palette display on Windows | open palette → `Ctrl+N`, `Ctrl+S`, etc. |
| Settings shortcuts modal | open settings → correct platform labels |
| TS build | `npm run build` — no type errors |
