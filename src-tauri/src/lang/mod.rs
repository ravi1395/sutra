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

#[derive(Default)]
pub struct LangState(pub Mutex<engine::LangEngine>);

#[tauri::command]
pub fn lang_did_open(
    state: State<'_, LangState>,
    path: String,
    text: String,
    version: u64,
) -> Result<(), String> {
    state.0.lock().unwrap().did_open(path, text, version)
}

#[tauri::command]
pub fn lang_did_change(
    state: State<'_, LangState>,
    path: String,
    text: String,
    version: u64,
) -> Result<(), String> {
    state.0.lock().unwrap().did_change(path, text, version)
}

#[tauri::command]
pub fn lang_did_close(state: State<'_, LangState>, path: String) -> Result<(), String> {
    state.0.lock().unwrap().did_close(&path);
    Ok(())
}

#[tauri::command]
pub fn lang_index_build(state: State<'_, LangState>, root: String) -> Result<IndexStats, String> {
    state.0.lock().unwrap().index_build(&root)
}

#[tauri::command]
pub fn lang_index_invalidate(
    state: State<'_, LangState>,
    paths: Vec<String>,
) -> Result<(), String> {
    state.0.lock().unwrap().index_invalidate(paths)
}

#[tauri::command]
pub fn lang_completion(
    state: State<'_, LangState>,
    path: String,
    pos: Pos,
    prefix: String,
) -> Result<Vec<CompletionItem>, String> {
    state.0.lock().unwrap().completion(&path, pos, &prefix)
}

#[tauri::command]
pub fn lang_document_symbols(
    state: State<'_, LangState>,
    path: String,
) -> Result<Vec<DocumentSymbol>, String> {
    state.0.lock().unwrap().document_symbols(&path)
}

#[tauri::command]
pub fn lang_workspace_symbols(
    state: State<'_, LangState>,
    query: String,
    limit: u32,
) -> Result<Vec<Symbol>, String> {
    Ok(state.0.lock().unwrap().workspace_symbols(&query, limit))
}

#[tauri::command]
pub fn lang_goto_definition(
    state: State<'_, LangState>,
    path: String,
    pos: Pos,
) -> Result<Vec<Location>, String> {
    state.0.lock().unwrap().goto_definition(&path, pos)
}

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
}
