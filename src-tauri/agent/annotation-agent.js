"use strict";
(() => {
  // src/annotation-core.ts
  var UNSTABLE_ID = [
    /^:/,
    // React useId (":r3:")
    /^(css|sc|emotion)-/i,
    // CSS-in-JS
    /^[0-9a-f]{6,}$/i
    // long hex-ish hash (whole-id match)
  ];
  function isStableId(id) {
    if (!id || !/^[A-Za-z][\w-]*$/.test(id)) return false;
    return !UNSTABLE_ID.some((re) => re.test(id));
  }
  function selectorFor(node) {
    if (node.id && isStableId(node.id)) return `#${node.id}`;
    const parts = [];
    let cur = node;
    while (cur) {
      if (cur.id && isStableId(cur.id)) {
        parts.unshift(`#${cur.id}`);
        break;
      }
      parts.unshift(`${cur.tag}:nth-of-type(${cur.typeIndex})`);
      cur = cur.parent;
    }
    return parts.join(" > ");
  }
  function routeKey(targetOrigin, loc, opts = {}) {
    const base = `${targetOrigin}${loc.pathname}${loc.search}`;
    return opts.hashRouting ? `${base}${loc.hash}` : base;
  }
  function isTrustedMessage(e, expectedOrigin, expectedSource) {
    return e.origin === expectedOrigin && e.source === expectedSource;
  }

  // src/annotation-agent.ts
  var PARENT_ORIGIN = window.__SUTRA_PARENT_ORIGIN__;
  var TARGET_ORIGIN = window.__SUTRA_TARGET_ORIGIN__;
  var PROXY_TOKEN = window.__SUTRA_PROXY_TOKEN__;
  var armed = false;
  var pins = /* @__PURE__ */ new Map();
  function post(msg) {
    window.parent.postMessage(msg, PARENT_ORIGIN);
  }
  function currentRoute() {
    const hashRouting = location.hash.startsWith("#/");
    return routeKey(TARGET_ORIGIN, location, { hashRouting });
  }
  function toNodeShape(el) {
    const build = (e) => {
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
    return build(el);
  }
  function computedSubset(el) {
    const cs = getComputedStyle(el);
    const keys = ["display", "position", "width", "height", "margin", "padding", "color", "backgroundColor", "fontSize", "fontWeight", "lineHeight", "border"];
    const out = {};
    for (const k of keys) out[k] = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
    return out;
  }
  function capture(el) {
    const selector = selectorFor(toNodeShape(el));
    const matchCount = document.querySelectorAll(selector).length;
    const html = el.outerHTML.slice(0, 2048);
    return {
      selector,
      tag: el.tagName.toLowerCase(),
      html,
      styles: computedSubset(el),
      hints: {
        testid: el.getAttribute("data-testid") || void 0,
        role: el.getAttribute("role") || void 0,
        aria: el.getAttribute("aria-label") || void 0,
        text: (el.textContent || "").trim().slice(0, 80) || void 0
      },
      ambiguous: matchCount > 1 ? true : void 0
    };
  }
  function drawPin(n, el) {
    const r = el.getBoundingClientRect();
    const pin = document.createElement("div");
    pin.textContent = String(n);
    Object.assign(pin.style, {
      position: "fixed",
      left: `${r.left}px`,
      top: `${r.top}px`,
      zIndex: "2147483647",
      background: "#e11",
      color: "#fff",
      borderRadius: "50%",
      width: "20px",
      height: "20px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      font: "12px sans-serif",
      cursor: "pointer",
      transition: "transform 120ms ease",
      transformOrigin: "center"
    });
    document.body.appendChild(pin);
    pins.set(n, { pin, el });
  }
  function repositionPins() {
    for (const { pin, el } of pins.values()) {
      if (!el.isConnected) {
        pin.style.display = "none";
        continue;
      }
      const r = el.getBoundingClientRect();
      pin.style.display = "flex";
      pin.style.left = `${r.left}px`;
      pin.style.top = `${r.top}px`;
    }
  }
  window.addEventListener("scroll", repositionPins, true);
  window.addEventListener("resize", repositionPins);
  function openEditor(n, el) {
    const r = (el ?? document.body).getBoundingClientRect();
    const ta = document.createElement("textarea");
    Object.assign(ta.style, {
      position: "fixed",
      left: `${r.left}px`,
      top: `${r.top + 24}px`,
      zIndex: "2147483647",
      width: "240px",
      height: "64px",
      padding: "8px 10px",
      boxSizing: "border-box",
      background: "#16181a",
      color: "#e8eae4",
      caretColor: "#4ade93",
      border: "1px solid #1f8a63",
      borderRadius: "6px",
      outline: "none",
      resize: "none",
      font: "12px/1.4 ui-sans-serif, system-ui, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,0.4)"
    });
    ta.placeholder = "design feedback\u2026 (Enter to save \xB7 Esc to cancel)";
    ta.addEventListener("focus", () => {
      ta.style.borderColor = "#4ade93";
      ta.style.boxShadow = "0 4px 16px rgba(0,0,0,0.4), 0 0 0 2px rgba(74,222,147,0.25)";
    });
    ta.addEventListener("input", () => post({ type: "feedbackChanged", n, text: ta.value }));
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        post({ type: "feedbackChanged", n, text: ta.value });
        ta.blur();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        ta.blur();
      }
    });
    ta.addEventListener("blur", () => ta.remove());
    document.body.appendChild(ta);
    ta.focus();
  }
  var hovered = null;
  function onMove(e) {
    if (!armed) return;
    const el = e.target;
    if (hovered) hovered.style.outline = "";
    hovered = el;
    el.style.outline = "2px solid #e11";
  }
  function onClick(e) {
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    post({ type: "picked", payload: capture(el) });
  }
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && armed) {
      e.preventDefault();
      post({ type: "disarmRequest" });
    }
  }, true);
  function emitRoute() {
    post({ type: "routeChanged", route: currentRoute() });
  }
  var origPush = history.pushState;
  history.pushState = function(...args) {
    const r = origPush.apply(this, args);
    emitRoute();
    return r;
  };
  var origReplace = history.replaceState;
  history.replaceState = function(...args) {
    const r = origReplace.apply(this, args);
    emitRoute();
    return r;
  };
  window.addEventListener("popstate", emitRoute);
  window.addEventListener("hashchange", emitRoute);
  window.addEventListener("message", (e) => {
    if (!isTrustedMessage(e, PARENT_ORIGIN, window.parent)) return;
    const m = e.data;
    switch (m.type) {
      case "arm":
        armed = true;
        document.body.style.cursor = "crosshair";
        break;
      case "disarm":
        armed = false;
        document.body.style.cursor = "";
        if (hovered) hovered.style.outline = "";
        break;
      case "openEditor": {
        const el = document.querySelector(m.selector);
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
          entry.el.style.outline = m.on ? "2px solid #4ade93" : "";
        }
        break;
      }
      case "scrollToPin": {
        pins.get(m.n)?.el.scrollIntoView({ behavior: "smooth", block: "center" });
        break;
      }
      case "reanchor": {
        const resolved = [];
        for (const sel of m.selectors) {
          if (document.querySelector(sel)) resolved.push(sel);
        }
        post({ type: "reanchorResult", route: currentRoute(), resolved });
        break;
      }
    }
  });
  if (PROXY_TOKEN) {
    let injectToken = function(url) {
      try {
        const u = new URL(url, location.href);
        if (u.origin !== location.origin) return url;
        if (u.searchParams.has("token")) return url;
        u.searchParams.set("token", PROXY_TOKEN);
        return u.toString();
      } catch {
        return url;
      }
    };
    injectToken2 = injectToken;
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
    XMLHttpRequest.prototype.open = function(method, url, async = true, username, password) {
      const patched = injectToken(typeof url === "string" ? url : url.toString());
      return origOpen.call(this, method, patched, async, username, password);
    };
  }
  var injectToken2;
  post({ type: "ready", route: currentRoute() });
})();
