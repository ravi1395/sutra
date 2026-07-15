// Phase 3 (preview theme fidelity): the Markdown preview's <style> block used to hardcode a
// fixed Catppuccin-ish palette, ignoring ink/washi. buildMdStyle() now resolves colors via
// cssVar() at generation time, and PreviewController re-renders open Markdown previews when
// the theme toggles (mirrors editor.ts's Pane.themeObserver — per-instance MutationObserver).
//
// DOMPurify needs a real `window`/Document to sanitize (confirmed empirically: its default
// export has no usable `.sanitize` under plain node:test), so tests that exercise the real
// render() path monkeypatch the shared `dompurify` singleton's `sanitize` method to a
// call-counting passthrough — this still proves the DOMPurify call path is invoked without
// requiring a full DOM.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import DOMPurify from "dompurify";
import { PreviewController, buildMdStyle } from "../src/preview";

const CATPPUCCIN_HEX = /#(1e1e2e|cdd6f4|89b4fa)/;

const INK_TOKENS: Record<string, string> = {
  "--bg-1": "#131614",
  "--fg": "#e8eae4",
  "--em": "#4ade93",
  "--bg-3": "#161a17",
  "--line": "rgba(255,255,255,0.05)",
  "--fg-dim": "#8b9189",
};
const WASHI_TOKENS: Record<string, string> = {
  "--bg-1": "#f5f2eb",
  "--fg": "#1f231f",
  "--em": "#0f8a5f",
  "--bg-3": "#fbf9f4",
  "--line": "rgba(31,35,31,0.08)",
  "--fg-dim": "#6e7268",
};

/** Minimal element fake: enough surface for PreviewController.render (md + html/srcdoc). */
class FakeNode {
  private listeners = new Map<string, (e: unknown) => void>();
  addEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.set(type, cb);
  }
}

class FakeIframe extends FakeNode {
  style: { cssText: string } = { cssText: "" };
  attrs = new Map<string, string>();
  srcdocValue = "";
  src = "";
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  set srcdoc(v: string) {
    this.srcdocValue = v;
  }
  get srcdoc(): string {
    return this.srcdocValue;
  }
}

class FakeEl extends FakeNode {
  html = "";
  children: FakeIframe[] = [];
  set innerHTML(v: string) {
    this.html = v;
  }
  get innerHTML(): string {
    return this.html;
  }
  querySelector(_sel: string): FakeNode {
    return new FakeNode();
  }
  appendChild(child: FakeIframe): FakeIframe {
    this.children.push(child);
    return child;
  }
}

/** Fake MutationObserver: onThemeChange() constructs one per PreviewController instance
 *  (mirrors the real editor.ts pattern); fireAll() simulates a class-attribute toggle firing
 *  every still-connected observer, and disconnect() (driven by dispose()) removes it. */
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  private active = true;
  constructor(private cb: () => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {
    this.active = false;
  }
  static fireAll(): void {
    for (const inst of FakeMutationObserver.instances) if (inst.active) inst.cb();
  }
  static reset(): void {
    FakeMutationObserver.instances = [];
  }
}

function stubDom(tokens: Record<string, string>): { restore: () => void } {
  const prevDocument = globalThis.document;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  const prevMutationObserver = globalThis.MutationObserver;
  (globalThis as unknown as { document: unknown }).document = {
    documentElement: {},
    createElement: (_tag: string) => new FakeIframe(),
  };
  (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = (
    _el: unknown,
  ) => ({
    getPropertyValue: (name: string) => tokens[name] ?? "",
  });
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = FakeMutationObserver;
  FakeMutationObserver.reset();
  return {
    restore: () => {
      globalThis.document = prevDocument as Document;
      globalThis.getComputedStyle = prevGetComputedStyle as typeof getComputedStyle;
      globalThis.MutationObserver = prevMutationObserver as typeof MutationObserver;
    },
  };
}

test("buildMdStyle resolves ink and washi tokens to different colors, never the retired dark literals", () => {
  const ink = stubDom(INK_TOKENS);
  const inkStyle = buildMdStyle();
  ink.restore();

  const washi = stubDom(WASHI_TOKENS);
  const washiStyle = buildMdStyle();
  washi.restore();

  assert.notEqual(inkStyle, washiStyle);
  assert.match(inkStyle, /#131614/);
  assert.match(washiStyle, /#f5f2eb/);
  assert.doesNotMatch(inkStyle, /#f5f2eb/);
  assert.doesNotMatch(washiStyle, /#131614/);
  assert.doesNotMatch(inkStyle, CATPPUCCIN_HEX);
  assert.doesNotMatch(washiStyle, CATPPUCCIN_HEX);
});

test("buildMdStyle falls back to ink-theme defaults outside a DOM, never empty", () => {
  assert.equal(typeof document, "undefined");
  const style = buildMdStyle();
  assert.match(style, /#131614/);
  assert.doesNotMatch(style, CATPPUCCIN_HEX);
});

test("PreviewController(md).render bakes resolved tokens into the generated markup and invokes DOMPurify", () => {
  const dom = stubDom(INK_TOKENS);
  const originalSanitize = DOMPurify.sanitize;
  let sanitizeCalls = 0;
  (DOMPurify as unknown as { sanitize: (h: string) => string }).sanitize = (html: string) => {
    sanitizeCalls++;
    return html;
  };
  try {
    const el = new FakeEl();
    const ctl = new PreviewController(el as unknown as HTMLElement, "md");
    void ctl.render("# Title\n\nhello");
    assert.equal(sanitizeCalls, 1);
    assert.match(el.html, /#131614/);
    assert.doesNotMatch(el.html, CATPPUCCIN_HEX);
    assert.match(el.html, /sutra-md-preview/);
  } finally {
    (DOMPurify as unknown as { sanitize: typeof originalSanitize }).sanitize = originalSanitize;
    dom.restore();
  }
});

test("theme toggle regenerates srcdoc/markup for an open md preview, following the resolved colors", () => {
  const dom = stubDom(INK_TOKENS);
  const originalSanitize = DOMPurify.sanitize;
  let sanitizeCalls = 0;
  (DOMPurify as unknown as { sanitize: (h: string) => string }).sanitize = (html: string) => {
    sanitizeCalls++;
    return html;
  };
  try {
    const el = new FakeEl();
    const ctl = new PreviewController(el as unknown as HTMLElement, "md");
    void ctl.render("# Title");
    const inkHtml = el.html;
    assert.equal(sanitizeCalls, 1);
    assert.match(inkHtml, /#131614/);

    // Simulate the ink -> washi toggle: tokens change, then the class-attribute mutation fires.
    (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = (
      _el: unknown,
    ) => ({
      getPropertyValue: (name: string) => WASHI_TOKENS[name] ?? "",
    });
    FakeMutationObserver.fireAll();

    const washiHtml = el.html;
    assert.equal(sanitizeCalls, 2, "toggle must re-run render(), invoking DOMPurify again");
    assert.notEqual(inkHtml, washiHtml);
    assert.match(washiHtml, /#f5f2eb/);
    assert.doesNotMatch(washiHtml, /#131614/);
    assert.doesNotMatch(washiHtml, CATPPUCCIN_HEX);
  } finally {
    (DOMPurify as unknown as { sanitize: typeof originalSanitize }).sanitize = originalSanitize;
    dom.restore();
  }
});

test("dispose() stops a preview from regenerating on further theme toggles", () => {
  const dom = stubDom(INK_TOKENS);
  const originalSanitize = DOMPurify.sanitize;
  let sanitizeCalls = 0;
  (DOMPurify as unknown as { sanitize: (h: string) => string }).sanitize = (html: string) => {
    sanitizeCalls++;
    return html;
  };
  try {
    const el = new FakeEl();
    const ctl = new PreviewController(el as unknown as HTMLElement, "md");
    void ctl.render("# Title");
    assert.equal(sanitizeCalls, 1);
    ctl.dispose();
    FakeMutationObserver.fireAll();
    assert.equal(sanitizeCalls, 1, "disposed controller must not re-render on toggle");
  } finally {
    (DOMPurify as unknown as { sanitize: typeof originalSanitize }).sanitize = originalSanitize;
    dom.restore();
  }
});

test("html/srcdoc preview keeps sandbox=\"\" and its own DOMPurify call untouched by the md changes", () => {
  const dom = stubDom(INK_TOKENS);
  const originalSanitize = DOMPurify.sanitize;
  let lastArgs: [string, unknown] | null = null;
  (DOMPurify as unknown as { sanitize: (h: string, o?: unknown) => string }).sanitize = (
    html: string,
    opts?: unknown,
  ) => {
    lastArgs = [html, opts];
    return html;
  };
  try {
    const el = new FakeEl();
    const ctl = new PreviewController(el as unknown as HTMLElement, "html", { htmlMode: "srcdoc" });
    void ctl.render("<script>alert(1)</script><p>hi</p>");
    assert.equal(el.children.length, 1);
    const iframe = el.children[0];
    assert.equal(iframe.attrs.get("sandbox"), "");
    assert.ok(lastArgs, "DOMPurify.sanitize must still be invoked for html/srcdoc previews");
    assert.deepEqual(lastArgs![1], { WHOLE_DOCUMENT: true });
    assert.equal(iframe.srcdocValue, "<script>alert(1)</script><p>hi</p>");
  } finally {
    (DOMPurify as unknown as { sanitize: typeof originalSanitize }).sanitize = originalSanitize;
    dom.restore();
  }
});

test("no retired Catppuccin literals remain in preview.ts source", () => {
  const src = readFileSync("src/preview.ts", "utf8");
  assert.doesNotMatch(src, CATPPUCCIN_HEX);
});
