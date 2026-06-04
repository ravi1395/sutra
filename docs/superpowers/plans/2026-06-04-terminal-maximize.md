# Terminal Maximize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a maximize/minimize button to each terminal group's tab bar that expands the terminal panel to fill the full editor+terminal area, hiding the editor while maximized.

**Architecture:** A single CSS class `terminal-maximized` on `#main` hides `#editor-area` + `#hresizer` and gives `#terminal-area` `flex: 1`. `TerminalManager` holds shared `maximized` state; both groups' buttons toggle the same flag. The hresizer sets an inline `style.flex` on `#terminal-area` that would override the CSS class, so `toggleMaximize()` saves and clears that inline value on maximize, restoring it on minimize.

**Tech Stack:** TypeScript, xterm.js, CSS, Tauri (no new dependencies)

---

### Task 1: Add expand and compress icons

**Files:**
- Modify: `src/icons.ts`

No unit test possible for SVG strings — `npm run build` (TS type-check) is the verification.

- [ ] **Step 1: Add icon names and paths to `src/icons.ts`**

Replace the `IconName` type and `paths` object as shown:

```typescript
// src/icons.ts
export type IconName =
  | "trackAI"
  | "terminal"
  | "diff"
  | "browser"
  | "back"
  | "reload"
  | "folder"
  | "folderAdd"
  | "check"
  | "chevronDown"
  | "search"
  | "refresh"
  | "play"
  | "plus"
  | "expand"
  | "compress";
```

In the `paths` object, add these two entries (after `"plus"`):

```typescript
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M10 14 3 21M21 3l-7 7"/>',
```

- [ ] **Step 2: Verify TS compiles**

```bash
npm run build
```

Expected: build completes with no errors. The new icon names are now usable via `icon("expand")` and `icon("compress")`.

- [ ] **Step 3: Commit**

```bash
git add src/icons.ts
git commit -m "feat: add expand and compress icons"
```

---

### Task 2: Add CSS rules for maximized state

**Files:**
- Modify: `src/styles.css`

- [ ] **Step 1: Add three rules after the terminal section**

Find the comment `/* ---- terminal ---- */` around line 1177 in `src/styles.css`. After the `.term-tab[data-side="right"]` rule (last rule in that section, around line 1265), add:

```css
/* Maximized terminal: hide editor and resizer, let terminal fill #main */
#main.terminal-maximized #editor-area  { display: none; }
#main.terminal-maximized #hresizer     { display: none; }
#main.terminal-maximized #terminal-area { flex: 1; }
```

Also add a style for the maximize button itself (consistent with `.term-add`):

```css
.term-maximize {
  border: none;
  border-radius: 0;
  background: var(--bg-bar);
  padding: 0 8px;
  cursor: pointer;
  color: var(--fg-faint);
  display: flex;
  align-items: center;
}
.term-maximize:hover {
  color: var(--em);
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "feat: terminal-maximized CSS state"
```

---

### Task 3: Update TerminalManager with maximize logic

**Files:**
- Modify: `src/terminal.ts`

`TerminalManager` is DOM/xterm/Tauri-dependent — not unit-testable in Node. Verification is `npm run build` (TS) + manual Tauri dev check in Task 5.

- [ ] **Step 1: Add new fields to the class**

Add these four private fields at the top of the class body (after `private focusedGroup`):

```typescript
private mainEl: HTMLElement;
private maximized = false;
private savedFlex = '';
private maximizeBtns: Partial<Record<TerminalGroupSide, HTMLButtonElement>> = {};
```

- [ ] **Step 2: Update the constructor signature**

Change:

```typescript
constructor(host: HTMLElement, area: HTMLElement) {
```

to:

```typescript
constructor(host: HTMLElement, area: HTMLElement, mainEl: HTMLElement) {
  this.mainEl = mainEl;
```

Add `this.mainEl = mainEl;` as the first line of the constructor body.

- [ ] **Step 3: Add the maximize button inside `buildGroup()`**

In the `buildGroup` closure (still inside the constructor), after these lines:

```typescript
      addBtn.onclick = () => void this.create(side);

      tabsBar.append(tabList, addBtn);
```

Replace `tabsBar.append(tabList, addBtn)` with:

```typescript
      const maxBtn = document.createElement("button");
      maxBtn.className = "term-maximize";
      maxBtn.title = "Maximize terminal";
      maxBtn.innerHTML = icon("expand", 14, 1.6);
      maxBtn.onclick = () => this.toggleMaximize();
      this.maximizeBtns[side] = maxBtn;

      tabsBar.append(tabList, addBtn, maxBtn);
```

Add a new import at the top of `terminal.ts` (after the existing imports, before the `interface Term` declaration):

```typescript
import { icon } from "./icons";
```

- [ ] **Step 4: Add `toggleMaximize()` and `renderMaximizeButtons()` methods**

Add these two methods to the class, after the `refit()` method:

```typescript
  /** Toggle the terminal panel between maximized (fills #main) and normal. */
  toggleMaximize(): void {
    this.maximized = !this.maximized;
    if (this.maximized) {
      // Save any inline flex set by the hresizer drag — it would override the CSS class.
      this.savedFlex = this.area.style.flex;
      this.area.style.flex = '';
      this.mainEl.classList.add('terminal-maximized');
    } else {
      this.mainEl.classList.remove('terminal-maximized');
      this.area.style.flex = this.savedFlex;
    }
    this.renderMaximizeButtons();
    this.refit();
  }

  /** Update both groups' maximize button icons to reflect current maximized state. */
  private renderMaximizeButtons(): void {
    for (const side of ['left', 'right'] as const) {
      const btn = this.maximizeBtns[side];
      if (!btn) continue;
      btn.title = this.maximized ? 'Minimize terminal' : 'Maximize terminal';
      btn.innerHTML = icon(this.maximized ? 'compress' : 'expand', 14, 1.6);
    }
  }
```

- [ ] **Step 5: Verify TS compiles**

```bash
npm run build
```

Expected: no errors. If you see `Property 'mainEl' has no initializer`, ensure `this.mainEl = mainEl` is the first line in the constructor body.

- [ ] **Step 6: Commit**

```bash
git add src/terminal.ts
git commit -m "feat: terminal maximize/minimize toggle"
```

---

### Task 4: Wire TerminalManager to #main in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Pass `$("main")` to the constructor**

Find this line in `src/main.ts` (around line 58):

```typescript
const terminals = new TerminalManager($("term-host"), $("terminal-area"));
```

Change it to:

```typescript
const terminals = new TerminalManager($("term-host"), $("terminal-area"), $("main"));
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Run tests to confirm no regressions**

```bash
npm test
```

Expected: all existing tests pass (the change only adds a parameter — no logic shared with automation/workspace tests).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire terminal maximize to #main element"
```

---

### Task 5: Manual verification in Tauri dev

**Files:** none

- [ ] **Step 1: Start the dev app**

```bash
npm run tauri dev
```

Wait for the window to open (~30s on first run after a fresh Rust build, faster on rebuild).

- [ ] **Step 2: Verify maximize button appears**

Open a workspace. The terminal panel should be visible. Each terminal group's tab bar should show a small expand icon (⤢) to the right of the `+` button.

- [ ] **Step 3: Verify maximize behavior**

Click the expand icon. Expected:
- Editor area disappears
- Terminal panel fills the full height of `#main`
- The expand icon changes to a compress icon (⊡)
- xterm resizes — run `echo $COLUMNS $LINES` in the terminal to confirm the terminal got larger dimensions

- [ ] **Step 4: Verify minimize behavior**

Click the compress icon. Expected:
- Editor area reappears
- Terminal returns to its previous height
- The button shows the expand icon again

- [ ] **Step 5: Verify with split terminals**

Create a second terminal group (drag a tab to the right drop zone). Both groups should show their own maximize button. Click either one — both groups should expand together (the split is preserved, editor hides).

- [ ] **Step 6: Verify resizer interaction**

Drag the `#hresizer` to resize the terminal to a custom height. Then maximize and minimize. The terminal should return to exactly the custom height, not the default.
