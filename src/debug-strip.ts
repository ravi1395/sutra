// Session-only floating control strip (mockup variant A, plans/debugger-v2-mockups.html):
// continue/step-over/step-into/step-out/pause/stop pill that mounts on session start and
// unmounts (removed from the DOM, not hidden) on stop or adapter death. Every button is
// pure delegation to the session's own methods — this module holds zero debug logic of
// its own, no parallel step/continue implementation.
//
// Per Q5 (Decisions log #10, palette-only single-home rule): the same session-only
// actions also register as palette `>` commands, gated to list only while a session is
// live. filterDebugPaletteCommands is the testable pure filter main.ts's wiring calls;
// `debug-start` opts out on purpose — it's the only way to begin a session from the
// palette, so it stays listed unconditionally.
import type { DebugUiState } from "./debug-session";

// Structural subset of DebugSession the strip needs — mirrors debug-session.ts's own
// EditorBridge pattern so this module never imports the concrete DebugSession class.
export interface StripSession {
  readonly active: boolean;
  onStateChange(cb: (state: DebugUiState) => void): () => void;
  continue(): Promise<void>;
  stepOver(): Promise<void>;
  stepIn(): Promise<void>;
  stepOut(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
}

export interface DebugStripHandle {
  el: HTMLElement;
  /** Lit while an MCP-initiated action is in flight. Ships dark — Phase 5 wires the
   * violet agent badge around agent-driven debug calls; nothing calls this yet. */
  setAgentActive(on: boolean): void;
  /** Detach the state subscription (tests / teardown). */
  dispose(): void;
}

/** Session-only palette verb ids — the strip's mirrored actions. `debug-start` is
 * deliberately excluded (see module doc). */
export const SESSION_ONLY_COMMAND_IDS = new Set([
  "debug-continue",
  "debug-pause",
  "debug-step-over",
  "debug-step-into",
  "debug-step-out",
  "debug-stop",
]);

/** Hide session-only debug verbs from the palette while no session is live. */
export function filterDebugPaletteCommands<T extends { id: string }>(
  commands: readonly T[],
  sessionActive: boolean,
): T[] {
  return sessionActive
    ? commands.slice()
    : commands.filter((c) => !SESSION_ONLY_COMMAND_IDS.has(c.id));
}

/**
 * Mount the control strip into `container`. Absent from the DOM (not hidden) until the
 * session goes active; torn down on stop/adapter-death via the same onStateChange
 * notification debug-chip.ts subscribes to.
 */
export function mountDebugStrip(container: HTMLElement, session: StripSession): DebugStripHandle {
  const el = document.createElement("div");
  el.className = "debug-strip";

  const label = document.createElement("span");
  label.className = "debug-strip-label";
  el.append(label);

  const addButton = (title: string, cls: string, glyph: string, onClick: () => void): void => {
    const btn = document.createElement("button");
    btn.className = cls;
    btn.title = title;
    btn.textContent = glyph;
    btn.onclick = onClick;
    el.append(btn);
  };
  addButton("Continue (F5)", "go", "▶", () => void session.continue());
  addButton("Step over (F10)", "", "⤸", () => void session.stepOver());
  addButton("Step into (F11)", "", "↓", () => void session.stepIn());
  addButton("Step out (⇧F11)", "", "↑", () => void session.stepOut());
  addButton("Pause (F6)", "", "⏸", () => void session.pause());
  addButton("Stop (⇧F5)", "stop", "■", () => void session.stop());

  const badge = document.createElement("span");
  badge.className = "agent-badge";
  badge.textContent = "agent";
  el.append(badge);

  let mounted = false;
  const unsubscribe = session.onStateChange((state) => {
    const children = state.childCount ?? 0;
    const childLabel = children === 0 ? "" : ` · ${children} ${children === 1 ? "child" : "children"}`;
    label.textContent = `${state.paused ? "paused" : "running"}${childLabel}`;
    if (state.active && !mounted) {
      container.append(el);
      mounted = true;
    } else if (!state.active && mounted) {
      el.remove();
      mounted = false;
    }
  });

  return {
    el,
    setAgentActive(on: boolean): void {
      if (on) badge.classList.add("lit");
      else badge.classList.remove("lit");
    },
    dispose(): void {
      unsubscribe();
    },
  };
}
