// Statusbar debug chip (mockup variant D, plans/debugger-v2-mockups.html): mirrors
// diagChipEl()'s singleton pattern (src/diagnostics.ts:306-311, id="diag-chip") — one
// DOM node, state via classList. Unlike the diagnostics chip (always present, styled
// clean when idle), this chip must be genuinely absent from the DOM with no session —
// main.ts only appends it into the whisper bar while a session is live; renderDebugChip
// itself just keeps the singleton's content/handlers in sync with the latest state so
// that append decision has something honest to read. Owns zero debug logic: click-to-
// frame delegates straight to DebugSession.gotoPausedLine().
import type { DebugUiState } from "./debug-session";

export interface ChipSession {
  onStateChange(cb: (state: DebugUiState) => void): () => void;
  gotoPausedLine(): Promise<void>;
}

let chip: HTMLElement | null = null;
/** Singleton statusbar debug chip (id="debug-chip"). Mirrors diagChipEl(). */
export function debugChipEl(): HTMLElement {
  if (!chip) {
    chip = document.createElement("div");
    chip.id = "debug-chip";
  }
  return chip;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/**
 * Render the chip's text/classList/click-handler for the given session UI state.
 * Idempotent — safe to call on every state notification. `onClickPaused` fires only
 * while paused; the chip has no click behavior running or absent.
 */
export function renderDebugChip(state: DebugUiState, onClickPaused: () => void): void {
  const el = debugChipEl();
  el.classList.remove("debug-chip--running", "debug-chip--paused");
  if (!state.active) {
    el.textContent = "";
    el.onclick = null;
    return;
  }
  if (state.paused) {
    el.classList.add("debug-chip--paused");
    el.textContent = `paused · ${basename(state.paused.path)}:${state.paused.line}`;
    el.onclick = onClickPaused;
  } else {
    el.classList.add("debug-chip--running");
    el.textContent = "debug: running";
    el.onclick = null;
  }
}

/**
 * Wire a ChipSession's state notifications straight to renderDebugChip, then trigger
 * `requestRerender` (main.ts's renderWhisperBar) so the whisper bar's append/absence
 * picks the change up immediately instead of waiting for its next poll tick. Returns
 * the unsubscribe function.
 */
export function mountDebugChip(session: ChipSession, requestRerender: () => void): () => void {
  return session.onStateChange((state) => {
    renderDebugChip(state, () => void session.gotoPausedLine());
    requestRerender();
  });
}
