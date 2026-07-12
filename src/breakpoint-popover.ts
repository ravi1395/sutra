// Right-click breakpoint editor: condition / hit count / log message fields,
// gated by the adapter's declared DAP capabilities. Built on the
// showContextMenu dismiss idiom (Escape / outside-click closes) and reuses
// its `.context-menu` box styling so it matches every other popover in the
// app (src/contextmenu.ts:17-66).

export interface BreakpointFields {
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

/**
 * Which fields the current adapter capabilities allow editing. `undefined`
 * (no session started yet this run) means "unknown" — default every field
 * enabled; the DAP request itself still withholds anything the adapter
 * turns out not to support (debug.ts's buildSetBreakpointsArgs), so typing
 * into an unsupported field before a session exists is harmless.
 */
export function popoverFieldsEnabled(
  capabilities?: Record<string, unknown>,
): { condition: boolean; hitCondition: boolean; logMessage: boolean } {
  if (!capabilities) return { condition: true, hitCondition: true, logMessage: true };
  return {
    condition: capabilities.supportsConditionalBreakpoints === true,
    hitCondition: capabilities.supportsHitConditionalBreakpoints === true,
    logMessage: capabilities.supportsLogPoints === true,
  };
}

export interface BreakpointPopoverOptions {
  x: number;
  y: number;
  containerEl: HTMLElement;
  path: string;
  line: number;
  initial: BreakpointFields;
  capabilities?: Record<string, unknown>;
  // Fires on every keystroke with the full current field set — the store is
  // the single source of truth, there is no separate save step.
  onChange: (fields: BreakpointFields) => void;
}

let current: HTMLElement | null = null;

function closePopover(): void {
  current?.remove();
  current = null;
}

function fieldRow(label: string, value: string, enabled: boolean, onInput: (v: string) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "bp-popover-row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.value = value;
  input.disabled = !enabled;
  input.oninput = () => onInput(input.value);
  row.append(lab, input);
  return row;
}

/** Open the breakpoint popover at (x, y), appended to `containerEl`. */
export function showBreakpointPopover(opts: BreakpointPopoverOptions): void {
  closePopover();

  const enabled = popoverFieldsEnabled(opts.capabilities);
  const disabledFields = (["condition", "hitCondition", "logMessage"] as const).filter((k) => !enabled[k]);
  if (disabledFields.length > 0) {
    console.warn(`sutra: adapter does not support ${disabledFields.join(", ")} — disabled in breakpoint popover`);
  }

  const el = document.createElement("div");
  el.className = "context-menu bp-popover";
  el.style.left = `${opts.x}px`;
  el.style.top = `${opts.y}px`;

  const title = document.createElement("h4");
  title.textContent = `Breakpoint · ${opts.path.split("/").pop()}:${opts.line}`;
  el.append(title);

  const fields: BreakpointFields = { ...opts.initial };
  const commit = () => opts.onChange({ ...fields });

  el.append(
    fieldRow("Condition", fields.condition ?? "", enabled.condition, (v) => {
      fields.condition = v || undefined;
      commit();
    }),
    fieldRow("Hit count", fields.hitCondition ?? "", enabled.hitCondition, (v) => {
      fields.hitCondition = v || undefined;
      commit();
    }),
    fieldRow("Log message — makes this a logpoint (no pause)", fields.logMessage ?? "", enabled.logMessage, (v) => {
      fields.logMessage = v || undefined;
      commit();
    }),
  );

  opts.containerEl.appendChild(el);
  current = el;

  const dismissOnEscape = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closePopover();
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("mousedown", dismissOnOutside);
    }
  };
  const dismissOnOutside = (ev: MouseEvent) => {
    if (!el.contains(ev.target as Node)) {
      closePopover();
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("mousedown", dismissOnOutside);
    }
  };
  document.addEventListener("keydown", dismissOnEscape);
  document.addEventListener("mousedown", dismissOnOutside);
}
