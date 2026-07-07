// Extension-eligibility check for beautify-on-save. Kept dependency-free
// (no prettier/taplo) so importing it never pulls those into the main
// bundle — src/format.ts is dynamically imported only when actually needed.
const FORMATTABLE_EXTS = new Set(["json", "yaml", "yml", "xml", "html", "htm", "toml"]);

export function isFormattableExt(ext: string): boolean {
  return FORMATTABLE_EXTS.has(ext.toLowerCase());
}
