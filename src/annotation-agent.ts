// annotation-agent.ts
// Runs INSIDE the proxied iframe document. Standalone IIFE — no app imports at
// runtime; core helpers are bundled in by esbuild from annotation-core.ts.
import { selectorFor, routeKey, isTrustedMessage, type NodeShape, type PickedPayload } from "./annotation-core";

// Window globals injected by proxy as a prelude script before this bundle.
declare global {
  interface Window {
    __SUTRA_PARENT_ORIGIN__: string;
    __SUTRA_TARGET_ORIGIN__: string;
    __SUTRA_PROXY_TOKEN__: string;
  }
}

const PARENT_ORIGIN = window.__SUTRA_PARENT_ORIGIN__ as string;
const TARGET_ORIGIN = window.__SUTRA_TARGET_ORIGIN__ as string;
const PROXY_TOKEN = window.__SUTRA_PROXY_TOKEN__ as string | undefined;

let armed = false;
const pins = new Map<number, { pin: HTMLElement; el: Element }>();

function post(msg: unknown) {
  window.parent.postMessage(msg, PARENT_ORIGIN);
}

function currentRoute(): string {
  const hashRouting = location.hash.startsWith("#/");
  return routeKey(TARGET_ORIGIN, location, { hashRouting });
}

// Build a NodeShape chain for selectorFor from a real Element.
function toNodeShape(el: Element): NodeShape {
  const build = (e: Element | null): NodeShape | null => {
    if (!e || e === document.documentElement.parentElement) return null;
    const tag = e.tagName.toLowerCase();
    let typeIndex = 1;
    let sib = e.previousElementSibling;
    while (sib) {
      if (sib.tagName === e.tagName) typeIndex++;
      sib = sib.previousElementSibling;
    }
    return { id: e.id || null, tag, typeIndex, parent: build(e.parentElement) };
  };
  return build(el)!;
}

function computedSubset(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const keys = ["display","position","width","height","margin","padding","color","backgroundColor","fontSize","fontWeight","lineHeight","border"];
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
  return out;
}

function capture(el: Element): PickedPayload {
  const selector = selectorFor(toNodeShape(el));
  const matchCount = document.querySelectorAll(selector).length;
  const html = el.outerHTML.slice(0, 2048);
  return {
    selector,
    tag: el.tagName.toLowerCase(),
    html,
    styles: computedSubset(el),
    hints: {
      testid: el.getAttribute("data-testid") || undefined,
      role: el.getAttribute("role") || undefined,
      aria: el.getAttribute("aria-label") || undefined,
      text: (el.textContent || "").trim().slice(0, 80) || undefined,
    },
    ambiguous: matchCount > 1 ? true : undefined,
  };
}

// --- pin + inline textarea rendering ---
function drawPin(n: number, el: Element) {
  const r = el.getBoundingClientRect();
  const pin = document.createElement("div");
  pin.textContent = String(n);
  Object.assign(pin.style, {
    position: "fixed", left: `${r.left}px`, top: `${r.top}px`, zIndex: "2147483647",
    background: "#e11", color: "#fff", borderRadius: "50%", width: "20px", height: "20px",
    display: "flex", alignItems: "center", justifyContent: "center", font: "12px sans-serif",
    cursor: "pointer", transition: "transform 120ms ease", transformOrigin: "center",
  } as CSSStyleDeclaration);
  document.body.appendChild(pin);
  pins.set(n, { pin, el });
}

// Re-glue pins to their elements after scroll/layout shifts. `position:fixed`
// is viewport-relative, so coords must be recomputed from the live rect.
function repositionPins() {
  for (const { pin, el } of pins.values()) {
    if (!el.isConnected) { pin.style.display = "none"; continue; }
    const r = el.getBoundingClientRect();
    pin.style.display = "flex";
    pin.style.left = `${r.left}px`;
    pin.style.top = `${r.top}px`;
  }
}
window.addEventListener("scroll", repositionPins, true);
window.addEventListener("resize", repositionPins);

function openEditor(n: number, el: Element | null) {
  const r = (el ?? document.body).getBoundingClientRect();
  const ta = document.createElement("textarea");
  // Themed inline: the agent runs in the proxied iframe with no access to the
  // host's CSS vars, so colors are literal copies of the app's dark palette.
  Object.assign(ta.style, {
    position: "fixed", left: `${r.left}px`, top: `${r.top + 24}px`, zIndex: "2147483647",
    width: "240px", height: "64px", padding: "8px 10px", boxSizing: "border-box",
    background: "#16181a", color: "#e8eae4", caretColor: "#4ade93",
    border: "1px solid #1f8a63", borderRadius: "6px", outline: "none", resize: "none",
    font: "12px/1.4 ui-sans-serif, system-ui, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
  } as CSSStyleDeclaration);
  ta.placeholder = "design feedback… (Enter to save · Esc to cancel)";
  ta.addEventListener("focus", () => { ta.style.borderColor = "#4ade93"; ta.style.boxShadow = "0 4px 16px rgba(0,0,0,0.4), 0 0 0 2px rgba(74,222,147,0.25)"; });
  ta.addEventListener("input", () => post({ type: "feedbackChanged", n, text: ta.value }));
  // Enter concludes annotation #n in place; Shift+Enter inserts a newline; Esc cancels.
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      post({ type: "feedbackChanged", n, text: ta.value });
      ta.blur();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation(); // don't also disarm picking
      ta.blur();
    }
  });
  ta.addEventListener("blur", () => ta.remove());
  document.body.appendChild(ta);
  ta.focus();
}

// --- arming + picking ---
let hovered: Element | null = null;
function onMove(e: MouseEvent) {
  if (!armed) return;
  const el = e.target as Element;
  if (hovered) (hovered as HTMLElement).style.outline = "";
  hovered = el;
  (el as HTMLElement).style.outline = "2px solid #e11";
}
function onClick(e: MouseEvent) {
  if (!armed) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target as Element;
  post({ type: "picked", payload: capture(el) });
}

window.addEventListener("mousemove", onMove, true);
window.addEventListener("click", onClick, true);
// Esc while picking asks the host to disarm (host owns armed state).
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && armed) { e.preventDefault(); post({ type: "disarmRequest" }); }
}, true);

// --- SPA route instrumentation ---
function emitRoute() { post({ type: "routeChanged", route: currentRoute() }); }
const origPush = history.pushState;
history.pushState = function (...args) { const r = origPush.apply(this, args as any); emitRoute(); return r; };
const origReplace = history.replaceState;
history.replaceState = function (...args) { const r = origReplace.apply(this, args as any); emitRoute(); return r; };
window.addEventListener("popstate", emitRoute);
window.addEventListener("hashchange", emitRoute);

// --- parent → agent messages ---
window.addEventListener("message", (e) => {
  if (!isTrustedMessage(e, PARENT_ORIGIN, window.parent)) return;
  const m = e.data as any;
  switch (m.type) {
    case "arm":
      armed = true;
      document.body.style.cursor = "crosshair";
      break;
    case "disarm":
      armed = false;
      document.body.style.cursor = "";
      if (hovered) (hovered as HTMLElement).style.outline = "";
      break;
    case "openEditor": {
      const el = document.querySelector(m.selector) as Element | null;
      drawPin(m.n, el ?? document.body);
      openEditor(m.n, el);
      break;
    }
    case "removePin": {
      pins.get(m.n)?.pin.remove();
      pins.delete(m.n);
      break;
    }
    case "flashPin": {
      const entry = pins.get(m.n);
      if (entry) {
        entry.pin.style.transform = m.on ? "scale(1.4)" : "";
        (entry.el as HTMLElement).style.outline = m.on ? "2px solid #4ade93" : "";
      }
      break;
    }
    case "scrollToPin": {
      pins.get(m.n)?.el.scrollIntoView({ behavior: "smooth", block: "center" });
      break;
    }
    case "reanchor": {
      const resolved: string[] = [];
      for (const sel of m.selectors as string[]) {
        if (document.querySelector(sel)) resolved.push(sel);
      }
      post({ type: "reanchorResult", route: currentRoute(), resolved });
      break;
    }
  }
});

// --- Proxy token re-injection ---
// SameSite=Strict on the auth cookie is dropped by WKWebView because the
// top-level document is tauri://localhost (a different site from 127.0.0.1:PORT).
// Patch fetch/XHR to re-attach the token as ?token=... on every same-origin
// request so subresources and API calls are authorized without the cookie.
if (PROXY_TOKEN) {
  function injectToken(url: string): string {
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) return url;
      if (u.searchParams.has("token")) return url;
      u.searchParams.set("token", PROXY_TOKEN!);
      return u.toString();
    } catch {
      return url;
    }
  }

  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === "string") {
      input = injectToken(input);
    } else if (input instanceof Request) {
      const patched = injectToken(input.url);
      if (patched !== input.url) input = new Request(patched, input);
    }
    return origFetch.call(this, input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(
    method: string, url: string | URL,
    async = true, username?: string | null, password?: string | null,
  ) {
    const patched = injectToken(typeof url === "string" ? url : url.toString());
    return origOpen.call(this, method, patched, async as boolean, username, password);
  };
}

// boot
post({ type: "ready", route: currentRoute() });
