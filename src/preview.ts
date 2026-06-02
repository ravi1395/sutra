import { marked } from "marked";
import DOMPurify from "dompurify";

export type PreviewKind = "md" | "html";

export function previewKind(name: string): PreviewKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "html" || ext === "htm") return "html";
  return null;
}

const MD_STYLE = `
.sutra-md-preview {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.65;
  max-width: 720px;
  min-height: 100%;
  margin: 0 auto;
  padding: 24px 32px;
  box-sizing: border-box;
  background: #1e1e2e;
  color: #cdd6f4;
}
.sutra-md-preview h1,
.sutra-md-preview h2,
.sutra-md-preview h3,
.sutra-md-preview h4,
.sutra-md-preview h5,
.sutra-md-preview h6 { color: #89b4fa; margin-top: 1.4em; }
.sutra-md-preview a { color: #89dceb; }
.sutra-md-preview code {
  background: #313244;
  border-radius: 4px;
  padding: 2px 5px;
  font-size: 0.875em;
  font-family: monospace;
}
.sutra-md-preview pre { background: #181825; border-radius: 6px; padding: 16px; overflow-x: auto; }
.sutra-md-preview pre code { background: transparent; padding: 0; }
.sutra-md-preview blockquote { border-left: 3px solid #6c7086; margin: 0; padding-left: 16px; color: #a6adc8; }
.sutra-md-preview table { border-collapse: collapse; width: 100%; }
.sutra-md-preview th,
.sutra-md-preview td { border: 1px solid #45475a; padding: 8px 12px; }
.sutra-md-preview th { background: #313244; }
.sutra-md-preview img { max-width: 100%; }
.sutra-md-preview hr { border: none; border-top: 1px solid #45475a; }
`;

export class PreviewController {
  private frame: HTMLIFrameElement | null = null;

  constructor(
    private el: HTMLElement,
    private kind: PreviewKind,
  ) {}

  render(text: string): void {
    if (this.kind === "md") {
      const raw = marked.parse(text) as string;
      const safe = DOMPurify.sanitize(raw);
      this.el.innerHTML = `<style>${MD_STYLE}</style><div class="sutra-md-preview">${safe}</div>`;
    } else {
      if (!this.frame) {
        this.el.innerHTML = "";
        this.frame = document.createElement("iframe");
        this.frame.style.cssText = "width:100%;height:100%;border:none;";
        this.el.appendChild(this.frame);
      }
      this.frame.src = text;
    }
  }
}
