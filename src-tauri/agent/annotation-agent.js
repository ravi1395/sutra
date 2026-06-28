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
      cursor: "pointer"
    });
    document.body.appendChild(pin);
    pins.set(n, pin);
  }
  function openEditor(n, el) {
    const r = (el ?? document.body).getBoundingClientRect();
    const ta = document.createElement("textarea");
    Object.assign(ta.style, {
      position: "fixed",
      left: `${r.left}px`,
      top: `${r.top + 22}px`,
      zIndex: "2147483647",
      width: "220px",
      height: "60px"
    });
    ta.placeholder = "design feedback\u2026";
    ta.addEventListener("input", () => post({ type: "feedbackChanged", n, text: ta.value }));
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
        break;
      case "disarm":
        armed = false;
        if (hovered) hovered.style.outline = "";
        break;
      case "openEditor": {
        const el = document.querySelector(m.selector);
        drawPin(m.n, el ?? document.body);
        openEditor(m.n, el);
        break;
      }
      case "removePin": {
        pins.get(m.n)?.remove();
        pins.delete(m.n);
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
  post({ type: "ready", route: currentRoute() });
})();
