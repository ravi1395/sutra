use super::symbols::{contains_pos, symbols_for_source};
use crate::lang::parser_cache::ParsedDocument;
use crate::lang::registry;
use crate::lang::symbol_index::fuzzy_score;
use crate::lang::{CompletionItem, Pos, Symbol};
use std::collections::HashMap;

pub fn completion(
    path: &str,
    doc: &ParsedDocument,
    pos: Pos,
    prefix: &str,
    workspace: Vec<Symbol>,
) -> Vec<CompletionItem> {
    let mut by_label: HashMap<String, CompletionItem> = HashMap::new();
    for sym in symbols_for_source(path, doc) {
        if sym.range.start.line <= pos.line && matches_prefix(&sym.name, prefix) {
            let score = score(&sym.name, prefix)
                + if contains_pos(&sym.range, pos) {
                    300
                } else {
                    0
                };
            insert_best(
                &mut by_label,
                CompletionItem {
                    label: sym.name,
                    kind: sym.kind,
                    detail: sym.detail,
                    source: "scope".to_string(),
                    score,
                },
            );
        }
    }
    for sym in workspace {
        if matches_prefix(&sym.name, prefix) {
            let item_score = score(&sym.name, prefix);
            insert_best(
                &mut by_label,
                CompletionItem {
                    label: sym.name,
                    kind: sym.kind,
                    detail: sym.detail,
                    source: "symbol".to_string(),
                    score: item_score,
                },
            );
        }
    }
    let spec = registry::spec(doc.lang);
    for kw in spec.keywords {
        if matches_prefix(kw, prefix) {
            insert_best(
                &mut by_label,
                CompletionItem {
                    label: (*kw).to_string(),
                    kind: "keyword".to_string(),
                    detail: None,
                    source: "keyword".to_string(),
                    score: score(kw, prefix) - 50,
                },
            );
        }
    }
    let mut out: Vec<_> = by_label.into_values().collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.label.cmp(&b.label)));
    out.truncate(100);
    out
}

fn matches_prefix(candidate: &str, prefix: &str) -> bool {
    prefix.is_empty() || fuzzy_score(candidate, &prefix.to_ascii_lowercase()).is_some()
}

fn score(candidate: &str, prefix: &str) -> i32 {
    if prefix.is_empty() {
        return 1;
    }
    fuzzy_score(candidate, &prefix.to_ascii_lowercase()).unwrap_or(0)
}

fn insert_best(map: &mut HashMap<String, CompletionItem>, item: CompletionItem) {
    match map.get(&item.label) {
        Some(existing) if existing.score >= item.score => {}
        _ => {
            map.insert(item.label.clone(), item);
        }
    }
}
