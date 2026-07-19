import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cssVar, onThemeChange } from "./theme-tokens";

export type PreviewKind = "md" | "html" | "diagram";

export function previewKind(name: string): PreviewKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "mmd") return "diagram";
  return null;
}

/**
 * Build the Markdown preview <style> block from the current ink/washi CSS tokens. The render
 * target (srcdoc-equivalent innerHTML swap) can't cascade parent custom properties in, so
 * colors are resolved via cssVar() and baked into the string at generation time; callers must
 * regenerate (not cache) this on every render to stay in sync with the active theme.
 */
export function buildMdStyle(): string {
  // Fallbacks mirror styles.css's ink (`:root`) defaults — never the retired fixed
  // dark-theme palette this block used to hardcode.
  const bg = cssVar("--bg-1", "#131614");
  const fg = cssVar("--fg", "#e8eae4");
  const em = cssVar("--em", "#4ade93");
  const codeBg = cssVar("--bg-3", "#161a17");
  const line = cssVar("--line", "rgba(255,255,255,0.05)");
  const fgDim = cssVar("--fg-dim", "#8b9189");
  return `
.sutra-md-preview {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.65;
  max-width: 720px;
  min-height: 100%;
  margin: 0 auto;
  padding: 24px 32px;
  box-sizing: border-box;
  background: ${bg};
  color: ${fg};
}
.sutra-md-preview h1,
.sutra-md-preview h2,
.sutra-md-preview h3,
.sutra-md-preview h4,
.sutra-md-preview h5,
.sutra-md-preview h6 { color: ${em}; margin-top: 1.4em; }
.sutra-md-preview a { color: ${em}; }
.sutra-md-preview code {
  background: ${codeBg};
  border-radius: 4px;
  padding: 2px 5px;
  font-size: 0.875em;
  font-family: monospace;
}
.sutra-md-preview pre { background: ${codeBg}; border-radius: 6px; padding: 16px; overflow-x: auto; }
.sutra-md-preview pre code { background: transparent; padding: 0; }
.sutra-md-preview blockquote { border-left: 3px solid ${line}; margin: 0; padding-left: 16px; color: ${fgDim}; }
.sutra-md-preview table { border-collapse: collapse; width: 100%; }
.sutra-md-preview th,
.sutra-md-preview td { border: 1px solid ${line}; padding: 8px 12px; }
.sutra-md-preview th { background: ${codeBg}; }
.sutra-md-preview img { max-width: 100%; }
.sutra-md-preview hr { border: none; border-top: 1px solid ${line}; }
`;
}

export class PreviewController {
  private frame: HTMLIFrameElement | null = null;
  private lastMdText: string | null = null;
  private disposeTheme: (() => void) | null = null;

  constructor(
    private el: HTMLElement,
    private kind: PreviewKind,
    private opts?: { htmlMode?: "url" | "srcdoc" },
  ) {
    // Mirrors editor.ts's Pane.themeObserver (per-instance MutationObserver via
    // onThemeChange). editor.ts disposes the previous controller at every
    // previewCtl replace/exit/destroy site — see dispose() below.
    if (this.kind === "md") {
      this.disposeTheme = onThemeChange(() => {
        if (this.lastMdText !== null) void this.render(this.lastMdText);
      });
    }
  }

  /** Stop reacting to ink/washi toggles; idempotent. */
  dispose(): void {
    this.disposeTheme?.();
    this.disposeTheme = null;
  }

  async render(text: string): Promise<void> {
    if (this.kind === "md") {
      this.lastMdText = text;
      const raw = marked.parse(text) as string;
      const safe = DOMPurify.sanitize(raw);
      this.el.innerHTML = `<style>${buildMdStyle()}</style><div class="sutra-md-preview">${safe}</div>`;
      this.interceptMarkdownLinks();
      return;
    }
    if (this.kind === "diagram") {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
      const { svg } = await mermaid.render("sutra-diagram", text);
      this.el.innerHTML = `<div class="sutra-md-preview">${svg}</div>`;
      return;
    }
    // html: "url" mode (default) — text is a preview-server URL, reached only by
    // interactive prompt_user forms. "srcdoc" mode — text is raw HTML, rendered
    // sandboxed with no server (inline per-tab preview).
    if (!this.frame) {
      this.el.innerHTML = "";
      this.frame = document.createElement("iframe");
      this.frame.style.cssText = "width:100%;height:100%;border:none;";
      this.el.appendChild(this.frame);
    }
    if (this.opts?.htmlMode === "srcdoc") {
      this.frame.setAttribute("sandbox", "");
      this.frame.srcdoc = DOMPurify.sanitize(text, { WHOLE_DOCUMENT: true });
    } else {
      this.frame.src = text;
    }
  }

  /** Route external Markdown links through the system opener. */
  private interceptMarkdownLinks(): void {
    const preview = this.el.querySelector(".sutra-md-preview");
    preview?.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>("a[href]");
      const href = link?.getAttribute("href");
      if (!href) return;
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return;
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
      event.preventDefault();
      void openUrl(url.toString()).catch(() => {});
    });
  }
}
