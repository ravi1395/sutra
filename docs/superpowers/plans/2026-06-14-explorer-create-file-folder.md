# File Explorer Create File/Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add VS Code-style file/folder creation to the Sutra file explorer — header icons + inline tree input with validation, replacing the current modal prompt.

**Architecture:** `FileTree` (`src/tree.ts`) owns the inline-create flow: target resolution, a focused input row, name validation, and post-create reveal/open. `main.ts` wires two new header buttons and reduces `onCreate` to a pure FS write. Two pure helpers (`validateNewName`, `resolveCreateTargetDir`) are unit-tested; the inline UI is verified manually via `npm run tauri dev`.

**Tech Stack:** TypeScript, Tauri IPC (`createDir`/`writeFile`/`fileMtime` in `src/ipc.ts`), `node:test` via esbuild bundle, vanilla DOM.

---

## File Structure

- `src/icons.ts` — add `fileAdd` icon (registry already has `folderAdd`, unused).
- `index.html` — two header buttons in `.sidebar-actions` before `btn-refresh`.
- `src/styles.css` — `.tree-create-error` message style.
- `src/tree.ts` — pure helpers + `selectedPath`/`selectedIsDir` tracking + `targetDirForCreate()` + `beginCreate()`; context-menu items and empty-space menu call `beginCreate`; `onCreate` signature gains `name`.
- `src/main.ts` — set button icons, wire `onclick`, refactor `tree.onCreate` to pure write.
- `tests/create-file-folder.test.ts` — unit tests for the two pure helpers.
- `README.md` — feature section.

Reference spec: `docs/superpowers/specs/2026-06-14-explorer-create-file-folder-design.md`.

---

## Task 1: Header icons (visual only)

**Files:**
- Modify: `src/icons.ts` (union ~line 4-32, `paths` ~line 34-59)
- Modify: `index.html:33-36`
- Modify: `src/main.ts:918-922`
- Modify: `src/styles.css` (after `.tree-edit-input`, ~line 1082)

- [ ] **Step 1: Add `fileAdd` to the icon name union**

In `src/icons.ts`, add `"fileAdd"` to the `IconName` union (alongside `"folderAdd"`):

```ts
  | "folderAdd"
  | "fileAdd"
```

- [ ] **Step 2: Add the `fileAdd` SVG path**

In the `paths` record in `src/icons.ts`, after the `folderAdd` entry:

```ts
  fileAdd:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v6M9 15h6"/>',
```

- [ ] **Step 3: Add the two header buttons**

In `index.html`, replace the `.sidebar-actions` block (lines 33-36) so the new buttons sit before search + refresh:

```html
            <div class="sidebar-actions">
              <button id="btn-new-file" class="sbtn" title="New File" aria-label="New File"></button>
              <button id="btn-new-folder" class="sbtn" title="New Folder" aria-label="New Folder"></button>
              <button id="btn-search-toggle" class="sbtn" title="Search folder (⇧⌘F)" aria-label="Search folder"></button>
              <button id="btn-refresh" class="sbtn reveal" title="Refresh folder" aria-label="Refresh folder"></button>
            </div>
```

- [ ] **Step 4: Render the icons into the buttons**

In `src/main.ts`, after the `$("btn-refresh").innerHTML = icon("refresh", 15);` line (~919), add:

```ts
$("btn-new-file").innerHTML = icon("fileAdd", 15);
$("btn-new-folder").innerHTML = icon("folderAdd", 15);
```

- [ ] **Step 5: Add the inline-error CSS**

In `src/styles.css`, after the `.tree-edit-input { ... }` rule (~line 1082):

```css
.tree-create-error {
  color: var(--danger, #e24b4a);
  font-size: 11px;
  padding: 1px 0 4px;
}
```

- [ ] **Step 6: Verify build + render**

Run: `npm run build`
Expected: TS check + Vite build pass, no errors.

Then `npm run tauri dev`: confirm two new icons appear left of search/refresh in the sidebar header, tooltips read "New File" / "New Folder", no console errors. Buttons do nothing yet (wired in Task 4).

- [ ] **Step 7: Commit**

```bash
git add src/icons.ts index.html src/main.ts src/styles.css
git commit -m "feat(explorer): add New File/Folder header icons (visual)"
```

---

## Task 2: Pure helpers (TDD)

**Files:**
- Modify: `src/tree.ts` (add two exported functions near top, after `fileTypeMeta`)
- Test: `tests/create-file-folder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/create-file-folder.test.ts`:

```ts
import { strict as assert } from "node:assert";
import test from "node:test";
import { validateNewName, resolveCreateTargetDir } from "../src/tree";

test("validateNewName rejects empty / whitespace", () => {
  assert.equal(validateNewName("", []), "Name cannot be empty.");
  assert.equal(validateNewName("   ", []), "Name cannot be empty.");
});

test("validateNewName rejects duplicate sibling", () => {
  assert.equal(
    validateNewName("main.ts", ["main.ts", "other.ts"]),
    'A file or folder "main.ts" already exists here.',
  );
});

test("validateNewName accepts a fresh simple name", () => {
  assert.equal(validateNewName("utils.ts", ["main.ts"]), null);
});

test("validateNewName rejects . and .. segments", () => {
  assert.equal(validateNewName("..", []), "Invalid name.");
  assert.equal(validateNewName("a/./b", []), "Invalid name.");
  assert.equal(validateNewName("a/../b", []), "Invalid name.");
});

test("validateNewName rejects leading/trailing slash", () => {
  assert.equal(validateNewName("/x", []), "Invalid name.");
  assert.equal(validateNewName("x/", []), "Invalid name.");
});

test("validateNewName allows nested path and skips sibling check", () => {
  // "foo" exists as a sibling but nested create merges into it
  assert.equal(validateNewName("foo/bar.ts", ["foo"]), null);
});

test("resolveCreateTargetDir returns root when nothing selected", () => {
  assert.equal(resolveCreateTargetDir(null, false, "/r"), "/r");
});

test("resolveCreateTargetDir returns the selected directory itself", () => {
  assert.equal(resolveCreateTargetDir("/r/dir", true, "/r"), "/r/dir");
});

test("resolveCreateTargetDir returns parent of a selected file", () => {
  assert.equal(resolveCreateTargetDir("/r/dir/a.ts", false, "/r"), "/r/dir");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `validateNewName` / `resolveCreateTargetDir` not exported from `../src/tree`.

- [ ] **Step 3: Implement the helpers**

In `src/tree.ts`, after the `fileTypeMeta` function (~line 42), add:

```ts
/** Validate a new file/folder name (may be a nested path). Returns an error
 *  string to show inline, or null when the name is acceptable. Sibling-conflict
 *  is only checked for simple (non-nested) names; nested paths merge into
 *  existing folders and are conflict-checked authoritatively at commit time. */
export function validateNewName(name: string, siblingNames: string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name cannot be empty.";
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return "Invalid name.";
  if (trimmed.includes("\0")) return "Invalid name.";
  const segs = trimmed.split("/");
  for (const seg of segs) {
    if (!seg || seg === "." || seg === "..") return "Invalid name.";
  }
  if (segs.length === 1 && siblingNames.includes(trimmed)) {
    return `A file or folder "${trimmed}" already exists here.`;
  }
  return null;
}

/** Resolve the directory a header-button create should target: the selected
 *  directory itself, the parent of a selected file, or the root when nothing
 *  is selected. */
export function resolveCreateTargetDir(
  selectedPath: string | null,
  selectedIsDir: boolean,
  root: string,
): string {
  if (!selectedPath) return root;
  if (selectedIsDir) return selectedPath;
  return selectedPath.split("/").slice(0, -1).join("/");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all 9 assertions in `create-file-folder.test.ts` green (existing suites still pass).

- [ ] **Step 5: Commit**

```bash
git add src/tree.ts tests/create-file-folder.test.ts
git commit -m "feat(explorer): add validateNewName + resolveCreateTargetDir helpers"
```

---

## Task 3: Inline-create engine in FileTree

**Files:**
- Modify: `src/tree.ts` — fields (~line 66-77), `setRoot` (~line 83), `makeRow` click (~line 276), `onCreate` field type (~line 76), add `targetDirForCreate` + `beginCreate` methods.

This task is UI; verify manually (no unit test for DOM here — the testable logic lives in Task 2).

- [ ] **Step 1: Add selection fields and update the callback type**

In `src/tree.ts`, in the `FileTree` class field block (~line 66-77), add two fields and change the `onCreate` signature:

```ts
  private selectedPath: string | null = null;
  private selectedIsDir = false;
```

Change:

```ts
  onCreate?: (parentDir: string, isDir: boolean) => void;
```

to:

```ts
  onCreate?: (parentDir: string, name: string, isDir: boolean) => Promise<void>;
```

- [ ] **Step 2: Clear selection on root change**

In `setRoot` (~line 83-91), after `this.expanded.add(path);` add:

```ts
    this.selectedPath = null;
    this.selectedIsDir = false;
```

- [ ] **Step 3: Track selection on row click**

In `makeRow`, inside `row.onclick` (~line 276-284), set selection at the top of the handler (before the dir/file branch):

```ts
    row.onclick = () => {
      this.selectedPath = e.path;
      this.selectedIsDir = e.isDir;
      if (e.isDir) {
        if (this.expanded.has(e.path)) this.expanded.delete(e.path);
        else this.expanded.add(e.path);
        void this.render();
      } else {
        this.onOpenFile?.(e.path);
      }
    };
```

- [ ] **Step 4: Add `targetDirForCreate`**

Add a public method to `FileTree` (e.g. after `reveal`, ~line 152):

```ts
  /** Directory a header-button create targets (selected dir, file's parent, or root). */
  targetDirForCreate(): string {
    return resolveCreateTargetDir(this.selectedPath, this.selectedIsDir, this.root ?? "");
  }
```

- [ ] **Step 5: Add `beginCreate`**

Add this public method to `FileTree` (after `targetDirForCreate`). It expands the
target, renders, injects a focused input row at the top of the target's children,
validates on Enter, and on success refreshes + reveals + opens:

```ts
  /** Start inline creation of a file/folder inside `parentDir`. Shows a focused
   *  input row; Enter commits (with validation), Esc/blur cancels. */
  async beginCreate(parentDir: string, isDir: boolean): Promise<void> {
    if (!this.root) return;
    this.expanded.add(parentDir);
    await this.render();

    const siblingNames = Array.from(
      this.el.querySelectorAll<HTMLElement>(".tree-row"),
    )
      .map((r) => r.dataset.path ?? "")
      .filter((p) => p && p.startsWith(parentDir + "/") && !p.slice(parentDir.length + 1).includes("/"))
      .map((p) => p.slice(parentDir.length + 1));

    const parentRow = this.el.querySelector<HTMLElement>(
      `.tree-row[data-path="${cssEscape(parentDir)}"]`,
    );
    const depth =
      parentDir === this.root
        ? 0
        : Math.round(
            (parseFloat(parentRow?.style.paddingLeft || "14") - 14) / 12,
          ) + 1;

    const wrap = document.createElement("div");
    wrap.className = "tree-create-wrap";

    const inputRow = document.createElement("div");
    inputRow.className = "tree-row " + (isDir ? "dir" : "file");
    inputRow.style.paddingLeft = `${depth * 12 + 14}px`;
    const icon = document.createElement("span");
    const meta = fileTypeMeta(isDir ? "" : "x", isDir);
    icon.className = `tree-icon ${meta.className}`;
    icon.textContent = meta.icon;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tree-edit-input";
    input.style.width = "100%";
    inputRow.append(icon, input);

    const errEl = document.createElement("div");
    errEl.className = "tree-create-error";
    errEl.style.paddingLeft = `${depth * 12 + 14}px`;
    errEl.style.display = "none";

    wrap.append(inputRow, errEl);

    // Insert as the first child entry of the parent (or top of tree for root).
    if (parentRow && parentRow.nextSibling) {
      parentRow.parentElement!.insertBefore(wrap, parentRow.nextSibling);
    } else {
      this.el.insertBefore(wrap, this.el.firstChild);
    }
    input.focus();

    const cleanup = () => {
      input.removeEventListener("keydown", onKey);
      input.removeEventListener("blur", onBlur);
      wrap.remove();
    };
    const showError = (msg: string) => {
      errEl.textContent = msg;
      errEl.style.display = "";
    };

    const commit = async () => {
      const name = input.value.trim();
      const syncErr = validateNewName(name, siblingNames);
      if (syncErr) {
        showError(syncErr);
        return;
      }
      const fullPath = parentDir + "/" + name;
      const exists = await this.pathExists(fullPath);
      if (exists) {
        showError(`A file or folder "${name}" already exists here.`);
        return;
      }
      try {
        await this.onCreate?.(parentDir, name, isDir);
      } catch (err) {
        showError(String(err));
        return;
      }
      cleanup();
      await this.refresh();
      await this.reveal(fullPath);
      this.selectedPath = fullPath;
      this.selectedIsDir = isDir;
      if (!isDir) this.onOpenFile?.(fullPath);
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void commit();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cleanup();
      } else {
        errEl.style.display = "none"; // clear error on next keystroke
      }
    };
    const onBlur = () => cleanup();

    input.addEventListener("keydown", onKey);
    input.addEventListener("blur", onBlur);
  }

  /** Existence probe via file_mtime (resolves for existing paths). */
  private async pathExists(path: string): Promise<boolean> {
    return fileMtime(path).then(
      () => true,
      () => false,
    );
  }
```

- [ ] **Step 6: Import `fileMtime` in tree.ts**

In the `./ipc` import at the top of `src/tree.ts` (line 4), add `fileMtime`:

```ts
import { listDir, gitStatus, fileMtime, type Entry, type GitStatusEntry } from "./ipc";
```

- [ ] **Step 7: Add cancel-on-blur ordering note (Escape vs blur)**

No code change — confirm: pressing Escape calls `cleanup()` which removes the
blur listener before blur fires, so Escape cancels cleanly. Enter triggers
`commit()`; the subsequent `cleanup()` on success also removes the blur listener.
Blur alone (clicking away) cancels with no FS change. This matches the spec.

- [ ] **Step 8: Verify build**

Run: `npm run build`
Expected: pass, no TS errors. (Engine is exercised end-to-end in Task 4.)

- [ ] **Step 9: Commit**

```bash
git add src/tree.ts
git commit -m "feat(explorer): inline create engine + selection tracking in FileTree"
```

---

## Task 4: Wire header buttons, context menu, empty-space create

**Files:**
- Modify: `src/main.ts:271-287` (`tree.onCreate`), and button wiring (~line 920)
- Modify: `src/tree.ts` — context-menu items (~line 302-316), add empty-space menu in constructor

- [ ] **Step 1: Refactor `tree.onCreate` to a pure write**

In `src/main.ts`, replace the entire `tree.onCreate = async (parentDir, isDir) => { ... }` block (lines 271-287) with:

```ts
tree.onCreate = async (parentDir: string, name: string, isDir: boolean) => {
  const path = parentDir + "/" + name;
  if (isDir) await createDir(path);
  else await writeFile(path, "");
};
```

(The tree now owns the name input, refresh, reveal, auto-open, and inline error
display, so this callback only performs the filesystem write and lets errors
propagate.)

- [ ] **Step 2: Wire the header buttons**

In `src/main.ts`, after the two `innerHTML = icon(...)` lines added in Task 1
(~line 920), add:

```ts
$("btn-new-file").onclick = () => void tree.beginCreate(tree.targetDirForCreate(), false);
$("btn-new-folder").onclick = () => void tree.beginCreate(tree.targetDirForCreate(), true);
```

- [ ] **Step 3: Point context-menu items at `beginCreate`**

In `src/tree.ts`, in `makeRow`'s `oncontextmenu` handler (~line 302-315), replace
the New File / New Folder items' actions:

```ts
          {
            label: "New File",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, false);
            },
          },
          {
            label: "New Folder",
            action: () => {
              const dir = e.isDir ? e.path : e.path.split("/").slice(0, -1).join("/");
              void this.beginCreate(dir, true);
            },
          },
```

- [ ] **Step 4: Add empty-space context menu (create at root)**

In `src/tree.ts` constructor (~line 79-81), after `this.el = el;`, add a
container-level context menu that fires only when the click is not on a row:

```ts
    this.el.addEventListener("contextmenu", (ev) => {
      if ((ev.target as HTMLElement).closest(".tree-row")) return; // row menu handles it
      if (!this.root) return;
      ev.preventDefault();
      showContextMenu(
        ev.clientX,
        ev.clientY,
        [
          { label: "New File", action: () => void this.beginCreate(this.root!, false) },
          { label: "New Folder", action: () => void this.beginCreate(this.root!, true) },
        ],
        this.el,
      );
    });
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: pass, no TS errors.

- [ ] **Step 6: Manual end-to-end verification**

Run: `npm run tauri dev`. Confirm all of:
- Click **New File** header icon with nothing selected → input at root → type `a.txt`, Enter → file created, opens in editor, row selected.
- Select a folder → click **New Folder** → input appears inside it (folder auto-expands) → type `sub`, Enter → folder created + revealed.
- Select a file → **New File** → input appears in that file's parent dir.
- Type an existing name → red error under input, input stays open, file not overwritten.
- Type `nested/deep/x.ts` → creates intermediate folders, opens `x.ts`.
- Press Esc / click away → input disappears, nothing created.
- Right-click a directory → New File/New Folder → inline input inside it.
- Right-click empty tree area → New File/New Folder → input at root.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts src/tree.ts
git commit -m "feat(explorer): wire create buttons, context menu, empty-space create"
```

---

## Task 5: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

Add (or extend the file-explorer section of) `README.md` with a subsection:

```markdown
### Creating files and folders

- Use the **New File** / **New Folder** icons at the top-right of the file
  explorer (left of Refresh), or right-click a folder (or empty space) and choose
  **New File** / **New Folder**.
- Header-icon creation targets the selected folder, the parent of the selected
  file, or the workspace root when nothing is selected.
- Type the name inline in the tree: Enter commits, Esc (or clicking away) cancels.
- Nested paths like `foo/bar/baz.ts` create intermediate folders.
- Existing names are rejected inline — files are never overwritten.
- New files open automatically in the editor.
```

- [ ] **Step 2: Verify it reflects the implementation**

Re-read the subsection against Task 4 behavior — wording matches actual targeting,
cancel keys, nested-path, and no-overwrite behavior.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document file/folder creation in the explorer"
```

---

## Self-Review

- **Spec coverage:** header icons (T1), inline input + validation + reveal/open (T3), target resolution (T2+T3), context menu + empty-space root (T4), `onCreate` refactor + no-overwrite via `pathExists` (T3/T4), nested paths (backend, exercised T4), tests (T2), docs (T5). All spec sections mapped.
- **Placeholder scan:** none — every code step has full code; commands have expected output.
- **Type consistency:** `onCreate(parentDir, name, isDir): Promise<void>` defined T3, implemented T4. `beginCreate(parentDir, isDir)`, `targetDirForCreate()`, `validateNewName(name, siblings)`, `resolveCreateTargetDir(selectedPath, selectedIsDir, root)`, `pathExists(path)` consistent across tasks. `fileMtime` imported T3.
- **Note:** DOM inline-create (T3) is verified manually (T4 Step 6), not unit-tested — testable logic is isolated into the T2 pure helpers, per the project's `node:test`/esbuild setup which can't render DOM.
