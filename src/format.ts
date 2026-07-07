// Beautify JSON/YAML/HTML/XML (prettier) and TOML (@taplo/lib) before save.
// Never throws: parse failures return null so the caller can fall back to
// the original, unformatted content.
import * as prettier from "prettier/standalone";
import prettierBabel from "prettier/plugins/babel";
import prettierEstree from "prettier/plugins/estree";
import prettierHtml from "prettier/plugins/html";
import prettierPostcss from "prettier/plugins/postcss";
import prettierYaml from "prettier/plugins/yaml";
import prettierXml from "@prettier/plugin-xml";
// @taplo/lib is published as CJS; named import of `Taplo` fails to resolve
// under this project's ESM/node16 module setup, so destructure the default.
import taploPkg from "@taplo/lib";
const { Taplo } = taploPkg;

const PRETTIER_PARSER: Record<string, string> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  html: "html",
  htm: "html",
  xml: "xml",
};

const PRETTIER_PLUGINS = [
  prettierBabel,
  prettierEstree,
  prettierHtml,
  prettierPostcss,
  prettierYaml,
  prettierXml,
];

export function isFormattableExt(ext: string): boolean {
  const normalizedExt = ext.toLowerCase();
  return normalizedExt === "toml" || normalizedExt in PRETTIER_PARSER;
}

let taploInstance: ReturnType<typeof Taplo.initialize> | null = null;
function getTaplo() {
  if (!taploInstance) taploInstance = Taplo.initialize();
  return taploInstance;
}

export async function formatContent(ext: string, content: string): Promise<string | null> {
  const normalizedExt = ext.toLowerCase();
  if (normalizedExt === "toml") {
    try {
      const taplo = await getTaplo();
      // taplo.format() does not validate — it happily reformats malformed
      // input — so parse-check with decode() first (throws on syntax errors)
      // and only format() once we know the document is valid.
      taplo.decode(content);
      return taplo.format(content);
    } catch {
      return null;
    }
  }
  const parser = PRETTIER_PARSER[normalizedExt];
  if (!parser) return null;
  try {
    return await prettier.format(content, { parser, plugins: PRETTIER_PLUGINS });
  } catch {
    return null;
  }
}
