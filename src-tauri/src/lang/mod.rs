// In-process tree-sitter language intelligence backend. Owns open-document
// parsing, lightweight workspace symbols, and Tauri commands used by src/ipc.ts.
pub mod engine;
pub mod features;
pub mod language;
pub mod parser_cache;
pub mod registry;
pub mod symbol_index;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pos {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub start: Pos,
    pub end: Pos,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionItem {
    pub label: String,
    pub kind: String,
    pub detail: Option<String>,
    pub source: String,
    pub score: i32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSymbol {
    pub name: String,
    pub kind: String,
    pub range: Range,
    pub selection_range: Range,
    pub children: Vec<DocumentSymbol>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub path: String,
    pub range: Range,
    pub selection_range: Range,
    pub container: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    pub range: Range,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hover {
    pub signature: String,
    pub doc: Option<String>,
    pub kind: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub indexed_files: usize,
    pub symbols: usize,
}

/// Tauri-managed handle wrapping the shared `LangEngine` behind a mutex.
#[derive(Default)]
pub struct LangState(pub Mutex<engine::LangEngine>);

/// Register or refresh an open document in the engine.
#[tauri::command]
pub fn lang_did_open(
    state: State<'_, LangState>,
    path: String,
    text: String,
    version: u64,
) -> Result<(), String> {
    state.0.lock().unwrap().did_open(path, text, version)
}

/// Sync an edited document's text into the engine.
#[tauri::command]
pub fn lang_did_change(
    state: State<'_, LangState>,
    path: String,
    text: String,
    version: u64,
) -> Result<(), String> {
    state.0.lock().unwrap().did_change(path, text, version)
}

/// Drop a closed document from the engine cache.
#[tauri::command]
pub fn lang_did_close(state: State<'_, LangState>, path: String) -> Result<(), String> {
    state.0.lock().unwrap().did_close(&path);
    Ok(())
}

/// Build the workspace symbol index under `root`.
#[tauri::command]
pub fn lang_index_build(state: State<'_, LangState>, root: String) -> Result<IndexStats, String> {
    state.0.lock().unwrap().index_build(&root)
}

/// Re-index the given paths after filesystem changes.
#[tauri::command]
pub fn lang_index_invalidate(
    state: State<'_, LangState>,
    paths: Vec<String>,
) -> Result<(), String> {
    state.0.lock().unwrap().index_invalidate(paths)
}

/// Return completion items for `prefix` at `pos`.
#[tauri::command]
pub fn lang_completion(
    state: State<'_, LangState>,
    path: String,
    pos: Pos,
    prefix: String,
) -> Result<Vec<CompletionItem>, String> {
    state.0.lock().unwrap().completion(&path, pos, &prefix)
}

/// Return the nested outline for a single file.
#[tauri::command]
pub fn lang_document_symbols(
    state: State<'_, LangState>,
    path: String,
) -> Result<Vec<DocumentSymbol>, String> {
    state.0.lock().unwrap().document_symbols(&path)
}

/// Fuzzy-match workspace symbols by `query`, capped at `limit`.
#[tauri::command]
pub fn lang_workspace_symbols(
    state: State<'_, LangState>,
    query: String,
    limit: u32,
) -> Result<Vec<Symbol>, String> {
    Ok(state.0.lock().unwrap().workspace_symbols(&query, limit))
}

/// Resolve definition candidates for the identifier at `pos`.
#[tauri::command]
pub fn lang_goto_definition(
    state: State<'_, LangState>,
    path: String,
    pos: Pos,
) -> Result<Vec<Location>, String> {
    state.0.lock().unwrap().goto_definition(&path, pos)
}

/// Return hover/signature info for the identifier at `pos`.
#[tauri::command]
pub fn lang_hover(
    state: State<'_, LangState>,
    path: String,
    pos: Pos,
) -> Result<Option<Hover>, String> {
    state.0.lock().unwrap().hover(&path, pos)
}

#[cfg(test)]
mod tests {
    use super::engine::LangEngine;
    use super::*;

    fn sample_py() -> String {
        r#"
class Greeter:
    def hello(self, name):
        """Say hello."""
        local_value = name
        return local_value

def outside():
    return Greeter()
"#
        .trim_start()
        .to_string()
    }

    #[test]
    fn python_document_symbols_include_nested_container_and_ranges() {
        let mut engine = LangEngine::default();
        engine
            .did_open("/tmp/sample.py".to_string(), sample_py(), 1)
            .unwrap();

        let symbols = engine.document_symbols("/tmp/sample.py").unwrap();

        assert_eq!(symbols[0].name, "Greeter");
        assert_eq!(symbols[0].kind, "class");
        assert_eq!(symbols[0].children[0].name, "hello");
        assert_eq!(symbols[0].children[0].kind, "function");
        assert_eq!(
            symbols[0].selection_range.start,
            Pos {
                line: 0,
                character: 6
            }
        );
        assert_eq!(symbols[1].name, "outside");
    }

    #[test]
    fn parser_cache_ignores_stale_versions_and_close_drops_doc() {
        let mut engine = LangEngine::default();
        engine
            .did_open(
                "/tmp/sample.py".to_string(),
                "def fresh():\n    pass\n".to_string(),
                2,
            )
            .unwrap();
        engine
            .did_change(
                "/tmp/sample.py".to_string(),
                "def stale():\n    pass\n".to_string(),
                1,
            )
            .unwrap();

        let symbols = engine.document_symbols("/tmp/sample.py").unwrap();
        assert_eq!(symbols[0].name, "fresh");

        engine.did_close("/tmp/sample.py");
        assert!(engine
            .document_symbols("/tmp/sample.py")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn goto_prefers_nearest_local_declaration_then_workspace_fallback() {
        let mut engine = LangEngine::default();
        engine
            .did_open("/tmp/sample.py".to_string(), sample_py(), 1)
            .unwrap();

        let local = engine
            .goto_definition(
                "/tmp/sample.py",
                Pos {
                    line: 4,
                    character: 15,
                },
            )
            .unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].range.start.line, 3);

        let fallback = engine
            .goto_definition(
                "/tmp/sample.py",
                Pos {
                    line: 7,
                    character: 11,
                },
            )
            .unwrap();
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].range.start.line, 0);
    }

    #[test]
    fn hover_returns_signature_and_python_docstring() {
        let mut engine = LangEngine::default();
        engine
            .did_open("/tmp/sample.py".to_string(), sample_py(), 1)
            .unwrap();

        let hover = engine
            .hover(
                "/tmp/sample.py",
                Pos {
                    line: 1,
                    character: 9,
                },
            )
            .unwrap()
            .unwrap();

        assert_eq!(hover.kind, "function");
        assert_eq!(hover.signature, "def hello(self, name)");
        assert_eq!(hover.doc.as_deref(), Some("Say hello."));
    }

    #[test]
    fn completion_blends_scope_symbols_workspace_symbols_and_keywords() {
        let mut engine = LangEngine::default();
        engine
            .did_open("/tmp/sample.py".to_string(), sample_py(), 1)
            .unwrap();
        engine.index_open_document("/tmp/sample.py").unwrap();

        let items = engine
            .completion(
                "/tmp/sample.py",
                Pos {
                    line: 4,
                    character: 16,
                },
                "la",
            )
            .unwrap();

        assert!(items
            .iter()
            .any(|i| i.label == "lambda" && i.source == "keyword"));

        let local_items = engine
            .completion(
                "/tmp/sample.py",
                Pos {
                    line: 4,
                    character: 16,
                },
                "lo",
            )
            .unwrap();
        assert!(local_items
            .iter()
            .any(|i| i.label == "local_value" && i.source == "scope"));
    }

    #[test]
    fn sql_and_unknown_paths_degrade_to_empty_results() {
        let mut engine = LangEngine::default();
        engine
            .did_open("/tmp/query.sql".to_string(), "select 1".to_string(), 1)
            .unwrap();

        assert!(engine
            .document_symbols("/tmp/query.sql")
            .unwrap()
            .is_empty());
        assert!(engine
            .completion(
                "/tmp/query.sql",
                Pos {
                    line: 0,
                    character: 1
                },
                ""
            )
            .unwrap()
            .is_empty());
        assert!(engine
            .hover(
                "/tmp/query.sql",
                Pos {
                    line: 0,
                    character: 1
                }
            )
            .unwrap()
            .is_none());
    }

    #[test]
    fn typescript_document_symbols_returns_functions() {
        let mut engine = LangEngine::default();
        let src = r#"export function foo(x: number): string { return ""; }
export class Bar { method(): void {} }"#;
        engine
            .did_open("/tmp/test.ts".to_string(), src.to_string(), 1)
            .unwrap();
        let syms = engine.document_symbols("/tmp/test.ts").unwrap();
        assert!(
            !syms.is_empty(),
            "expected symbols for TypeScript file, got none"
        );
    }

    #[test]
    fn typescript_document_symbols_use_query_variable_captures() {
        let mut engine = LangEngine::default();
        let src = r#"// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  clearScreen: false,
  server: {
    port: 1420,
  },
}));"#;
        engine
            .did_open("/tmp/vite.config.ts".to_string(), src.to_string(), 1)
            .unwrap();

        let syms = engine.document_symbols("/tmp/vite.config.ts").unwrap();

        assert!(
            syms.iter()
                .any(|sym| sym.name == "host" && sym.kind == "variable"),
            "expected TypeScript lexical declarations from symbols.scm, got {syms:?}"
        );
        let hover = engine
            .hover(
                "/tmp/vite.config.ts",
                Pos {
                    line: 1,
                    character: 6,
                },
            )
            .unwrap()
            .expect("expected hover for query-captured const");
        assert_eq!(hover.kind, "variable");
    }

    #[test]
    fn typescript_document_symbols_include_configured_query_declarations() {
        let mut engine = LangEngine::default();
        let src = r#"export interface Props {
  label: string;
}

type Mode = "idle" | "busy";

export enum Status {
  Ready,
}

export class Widget {}

export function renderWidget(props: Props): Mode {
  return "idle";
}

const LocalWidget = () => renderWidget({ label: "ok" });"#;
        engine
            .did_open("/tmp/component.ts".to_string(), src.to_string(), 1)
            .unwrap();

        let symbols = engine.document_symbols("/tmp/component.ts").unwrap();
        let names: Vec<_> = symbols.iter().map(|sym| sym.name.as_str()).collect();

        for expected in [
            "Props",
            "Mode",
            "Status",
            "Widget",
            "renderWidget",
            "LocalWidget",
        ] {
            assert!(
                names.contains(&expected),
                "expected {expected} in TypeScript outline, got {symbols:?}"
            );
        }
    }

    #[test]
    fn typescript_document_symbols_include_class_methods() {
        let mut engine = LangEngine::default();
        let src = r#"export class BrowserPane {
  show(): void {
    this.area.classList.remove("hidden");
  }

  hide(): void {
    this.area.classList.add("hidden");
  }

  isHidden(): boolean {
    return this.area.classList.contains("hidden");
  }
}"#;
        engine
            .did_open("/tmp/browser.ts".to_string(), src.to_string(), 1)
            .unwrap();

        let symbols = engine.document_symbols("/tmp/browser.ts").unwrap();
        let class_symbol = symbols
            .iter()
            .find(|sym| sym.name == "BrowserPane")
            .expect("expected BrowserPane class symbol");
        let methods: Vec<_> = class_symbol
            .children
            .iter()
            .map(|sym| (sym.name.as_str(), sym.kind.as_str()))
            .collect();

        assert_eq!(
            methods,
            vec![("show", "function"), ("hide", "function"), ("isHidden", "function")]
        );
    }

    #[test]
    fn typescript_hover_resolves_configured_type_identifier_use_sites() {
        let mut engine = LangEngine::default();
        let src = r#"interface Props {
  label: string;
}

function renderWidget(props: Props): Props {
  return props;
}"#;
        engine
            .did_open("/tmp/component.ts".to_string(), src.to_string(), 1)
            .unwrap();

        let hover = engine
            .hover(
                "/tmp/component.ts",
                Pos {
                    line: 4,
                    character: 30,
                },
            )
            .unwrap()
            .expect("expected hover for Props type use");

        assert_eq!(hover.kind, "interface");
        assert!(hover.signature.starts_with("interface Props"));
    }

    #[test]
    fn typescript_hover_uses_workspace_symbol_when_declaration_is_external() {
        let mut engine = LangEngine::default();
        engine
            .did_open(
                "/tmp/Button.ts".to_string(),
                "export function Button() { return null; }\n".to_string(),
                1,
            )
            .unwrap();
        engine.index_open_document("/tmp/Button.ts").unwrap();
        engine
            .did_open(
                "/tmp/App.ts".to_string(),
                "export function App() { return Button(); }\n".to_string(),
                1,
            )
            .unwrap();

        let hover = engine
            .hover(
                "/tmp/App.ts",
                Pos {
                    line: 0,
                    character: 31,
                },
            )
            .unwrap()
            .expect("expected hover for external Button symbol");

        assert_eq!(hover.kind, "function");
        assert_eq!(hover.signature, "function Button()");
    }
}
