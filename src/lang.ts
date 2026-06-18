// Language-intelligence bridge: maps CM6 editor positions <-> IPC Pos values and
// wires completion, hover, and goto-definition extensions for the Pane/EditorManager.
// All IPC calls degrade gracefully — a backend rejection returns null/empty rather
// than breaking the editor.
import { hoverTooltip, type EditorView } from "@codemirror/view";
import {
  autocompletion,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import DOMPurify from "dompurify";
import {
  langCompletion,
  langHover,
  langGotoDefinition,
  type Pos,
  type Location,
} from "./ipc";
import type { EditorManager } from "./editor";

// ---------------------------------------------------------------------------
// Position utilities
// ---------------------------------------------------------------------------

/** Convert a CM6 document offset to an LSP-style 0-based Pos (UTF-16 columns). */
export function offsetToPos(doc: Text, offset: number): Pos {
  // Clamp offset to valid document range before mapping.
  const clamped = Math.max(0, Math.min(offset, doc.length));
  const line = doc.lineAt(clamped);
  return { line: line.number - 1, character: clamped - line.from };
}

/** Convert an LSP-style 0-based Pos back to a CM6 document offset. */
export function posToOffset(doc: Text, pos: Pos): number {
  // Clamp line to the valid range of the document.
  const lineNum = Math.max(1, Math.min(pos.line + 1, doc.lines));
  const line = doc.line(lineNum);
  const offset = line.from + pos.character;
  // Clamp to line bounds and document bounds.
  return Math.max(line.from, Math.min(offset, doc.length));
}

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

/** Map engine completion kind strings to CM6 completion type strings. */
export function cmCompletionType(kind: string): string {
  switch (kind) {
    case "function":
    case "method":
      return "function";
    case "class":
    case "interface":
    case "struct":
    case "enum":
      return "class";
    case "variable":
    case "const":
    case "let":
    case "field":
      return "variable";
    case "keyword":
      return "keyword";
    case "member":
    case "property":
      return "property";
    case "module":
    case "namespace":
      return "namespace";
    case "type":
    case "typedef":
      return "type";
    case "constant":
      return "constant";
    default:
      return "text";
  }
}

// ---------------------------------------------------------------------------
// Completion source
// ---------------------------------------------------------------------------

/** Build a CM6 CompletionSource backed by the lang_completion IPC command. */
export function langCompletionSource(getPath: () => string | null): CompletionSource {
  // Returns an async CompletionSource that calls the engine and maps results.
  return async (context) => {
    const path = getPath();
    if (!path) return null;

    // Only trigger when there is a word-like token before the cursor.
    const word = context.matchBefore(/[\w$]+/);
    if (!word && !context.explicit) return null;
    const from = word?.from ?? context.pos;

    const pos = offsetToPos(context.state.doc, context.pos);
    const prefix = word?.text ?? "";

    let items;
    try {
      items = await langCompletion(path, pos, prefix);
    } catch {
      return null;
    }
    if (!items || items.length === 0) return null;

    const options: Completion[] = items.map((item) => ({
      label: item.label,
      type: cmCompletionType(item.kind),
      detail: item.detail ?? undefined,
      boost: item.score,
    }));

    return { from, options };
  };
}

// ---------------------------------------------------------------------------
// Hover tooltip
// ---------------------------------------------------------------------------

/** Build a CM6 hoverTooltip extension backed by the lang_hover IPC command. */
export function langHoverTooltipExt(getPath: () => string | null) {
  // Returns a hoverTooltip extension that renders signature + kind + doc.
  return hoverTooltip(async (view: EditorView, pos: number) => {
    const path = getPath();
    if (!path) return null;

    const ipcPos = offsetToPos(view.state.doc, pos);
    let hover;
    try {
      hover = await langHover(path, ipcPos);
    } catch {
      return null;
    }
    if (!hover) return null;

    return {
      pos,
      create() {
        const dom = document.createElement("div");
        dom.className = "lang-hover";

        const sig = document.createElement("pre");
        sig.className = "lang-hover-sig";
        sig.textContent = hover.signature;
        dom.append(sig);

        const badge = document.createElement("span");
        badge.className = "lang-hover-kind";
        badge.textContent = hover.kind;
        dom.append(badge);

        if (hover.doc) {
          const docEl = document.createElement("div");
          docEl.className = "lang-hover-doc";
          // Sanitize documentation HTML to prevent XSS (mirrors preview.ts approach).
          docEl.innerHTML = DOMPurify.sanitize(hover.doc);
          dom.append(docEl);
        }

        return { dom };
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Goto-definition helper
// ---------------------------------------------------------------------------

/**
 * Invoke lang_goto_definition for the caret position in the active editor and
 * return the list of candidate locations. Returns null on error/no result.
 * The caller decides what to do: 1 location → open directly; many → picker.
 */
export async function gotoDefinition(
  _mgr: EditorManager,
  path: string,
  view: EditorView,
): Promise<Location[] | null> {
  const caretOffset = view.state.selection.main.head;
  const pos = offsetToPos(view.state.doc, caretOffset);
  try {
    const locs = await langGotoDefinition(path, pos);
    if (!locs || locs.length === 0) return null;
    return locs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported CM6 extensions (for editor.ts to mount)
// ---------------------------------------------------------------------------

/** Build the autocompletion extension wired to the lang engine for the given pane path getter. */
export function langAutocompletionExt(getPath: () => string | null) {
  // Wraps the langCompletionSource in an autocompletion configuration.
  return autocompletion({
    override: [langCompletionSource(getPath)],
    activateOnTypingDelay: 150,
  });
}
