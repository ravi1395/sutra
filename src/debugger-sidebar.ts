// Right-sidebar DOM for an active debug session: variables, watch, call stack,
// exception breakpoints, and a read-only debug console. Pure rendering driven by
// DAP responses fetched after each `stopped` event; user intent (expand var,
// add/remove watch, toggle exception filter, jump to frame) flows out via callbacks.

export interface SidebarCallbacks {
  onExpandVariable: (variablesReference: number) => void;
  onAddWatch: (expr: string) => void;
  onRemoveWatch: (expr: string) => void;
  onToggleExceptionFilter: (filter: string, enabled: boolean) => void;
  onSelectFrame: (frameId: number, path: string, line: number) => void;
  // Console REPL evaluate — resolves once appended (input clears); rejects on adapter
  // error (input is left in place so the user can edit and retry).
  onEvaluate: (expr: string) => Promise<void>;
}

export interface SidebarModel {
  variables: { name: string; value: string; variablesReference: number }[];
  watch: { expr: string; value: string }[];
  callStack: { id: number; name: string; path: string; line: number }[];
  exceptionFilters: { filter: string; label: string; enabled: boolean }[];
  console: string[];
  // True while a DAP session is live — gates the console evaluate input row (hidden,
  // not disabled, when there's no session to send an evaluate request to).
  hasSession: boolean;
}

export function emptyModel(): SidebarModel {
  return { variables: [], watch: [], callStack: [], exceptionFilters: [], console: [], hasSession: false };
}

/** True when a console-evaluate submission should be ignored: empty after trim, or
 * containing a newline (pasted multi-line text has no single expression to send). */
export function shouldIgnoreEvaluateInput(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.length === 0 || /[\r\n]/.test(trimmed);
}

export class DebuggerSidebar {
  readonly el: HTMLElement;
  constructor(private cb: SidebarCallbacks) {
    this.el = document.createElement("div");
    this.el.className = "debugger-sidebar";
  }

  /** Replace the sidebar contents with the given model snapshot. */
  render(m: SidebarModel) {
    this.el.replaceChildren(
      this.panel("Variables", this.variablesView(m.variables)),
      this.panel("Watch", this.watchView(m.watch)),
      this.panel("Call Stack", this.callStackView(m.callStack)),
      this.panel("Exception Breakpoints", this.exceptionView(m.exceptionFilters)),
      this.panel("Debug Console", this.consoleView(m.console, m.hasSession)),
    );
  }

  private panel(title: string, body: HTMLElement): HTMLElement {
    const wrap = document.createElement("section");
    wrap.className = "dbg-panel";
    const h = document.createElement("h3");
    h.textContent = title;
    wrap.append(h, body);
    return wrap;
  }

  private variablesView(vars: SidebarModel["variables"]): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = "dbg-list";
    for (const v of vars) {
      const li = document.createElement("li");
      li.textContent = `${v.name} = ${v.value}`;
      if (v.variablesReference > 0) {
        li.classList.add("expandable");
        li.onclick = () => this.cb.onExpandVariable(v.variablesReference);
      }
      ul.append(li);
    }
    return ul;
  }

  private watchView(watch: SidebarModel["watch"]): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = "dbg-list";
    for (const w of watch) {
      const li = document.createElement("li");
      li.textContent = `${w.expr}: ${w.value}`;
      const rm = document.createElement("button");
      rm.textContent = "×";
      rm.className = "dbg-watch-rm";
      rm.onclick = () => this.cb.onRemoveWatch(w.expr);
      li.append(rm);
      ul.append(li);
    }
    const add = document.createElement("input");
    add.className = "dbg-watch-add";
    add.placeholder = "+ add expression…";
    add.onkeydown = (e) => {
      if (e.key === "Enter" && add.value.trim()) {
        this.cb.onAddWatch(add.value.trim());
        add.value = "";
      }
    };
    ul.append(add);
    return ul;
  }

  private callStackView(frames: SidebarModel["callStack"]): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = "dbg-list";
    for (const f of frames) {
      const li = document.createElement("li");
      li.className = "dbg-frame";
      li.textContent = `${f.name}  ${f.path.split("/").pop() ?? f.path}:${f.line}`;
      li.onclick = () => this.cb.onSelectFrame(f.id, f.path, f.line);
      ul.append(li);
    }
    return ul;
  }

  private exceptionView(filters: SidebarModel["exceptionFilters"]): HTMLElement {
    const ul = document.createElement("ul");
    ul.className = "dbg-list";
    for (const f of filters) {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = f.enabled;
      cb.onchange = () => this.cb.onToggleExceptionFilter(f.filter, cb.checked);
      li.append(cb, document.createTextNode(" " + f.label));
      ul.append(li);
    }
    return ul;
  }

  private consoleView(lines: string[], hasSession: boolean): HTMLElement {
    const pre = document.createElement("pre");
    pre.className = "dbg-console";
    // Render each entry as its own line (not one joined blob) so error lines can
    // carry a distinct class — evaluate() prefixes adapter failures with "Error: ".
    for (const line of lines) {
      const entry = document.createElement("div");
      entry.className = line.startsWith("Error: ") ? "dbg-console-line dbg-console-error" : "dbg-console-line";
      entry.textContent = line;
      pre.append(entry);
    }

    if (hasSession) {
      const input = document.createElement("input");
      input.className = "dbg-console-input";
      input.placeholder = "evaluate expression…";
      input.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const expr = input.value;
        if (shouldIgnoreEvaluateInput(expr)) return;
        void this.cb.onEvaluate(expr.trim()).then(
          () => {
            input.value = "";
          },
          () => {
            // Adapter error is already appended to the console by evaluate(); keep
            // the text in place so the user can edit and retry.
          },
        );
      };
      pre.append(input);
    }

    return pre;
  }
}
