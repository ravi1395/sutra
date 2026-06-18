use super::symbols::{identifier_at, symbols_for_source};
use crate::lang::parser_cache::ParsedDocument;
use crate::lang::{Location, Pos, Symbol};

pub fn goto_definition(
    path: &str,
    doc: &ParsedDocument,
    pos: Pos,
    workspace: Vec<Symbol>,
) -> Vec<Location> {
    let Some((name, _)) = identifier_at(doc, pos) else {
        return Vec::new();
    };
    let mut local: Vec<Symbol> = symbols_for_source(path, doc)
        .into_iter()
        .filter(|sym| sym.name == name && starts_before_or_at(sym, pos))
        .collect();
    local.sort_by(|a, b| {
        b.selection_range
            .start
            .line
            .cmp(&a.selection_range.start.line)
            .then_with(|| {
                b.selection_range
                    .start
                    .character
                    .cmp(&a.selection_range.start.character)
            })
    });
    if let Some(sym) = local.into_iter().next() {
        return vec![Location {
            path: sym.path,
            range: sym.selection_range,
        }];
    }
    workspace
        .into_iter()
        .map(|sym| Location {
            path: sym.path,
            range: sym.selection_range,
        })
        .collect()
}

fn starts_before_or_at(sym: &Symbol, pos: Pos) -> bool {
    sym.selection_range.start.line < pos.line
        || (sym.selection_range.start.line == pos.line
            && sym.selection_range.start.character <= pos.character)
}
