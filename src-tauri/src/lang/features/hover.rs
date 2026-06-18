use super::symbols::{identifier_at, signature_for_node, symbol_at_selection, symbols_for_source};
use crate::lang::language::DocCommentStyle;
use crate::lang::parser_cache::ParsedDocument;
use crate::lang::registry;
use crate::lang::{Hover, Pos, Symbol};

pub fn hover(path: &str, doc: &ParsedDocument, pos: Pos, workspace: Vec<Symbol>) -> Option<Hover> {
    let symbols = symbols_for_source(path, doc);
    let target = symbol_at_selection(&symbols, pos).or_else(|| {
        let (name, _) = identifier_at(doc, pos)?;
        symbols
            .iter()
            .chain(workspace.iter())
            .find(|sym| sym.name == name)
            .cloned()
    })?;
    let decl = symbols
        .iter()
        .find(|sym| sym.selection_range == target.selection_range)?;
    let node = doc.tree.root_node().named_descendant_for_byte_range(
        byte_for_line(&doc.source, decl.range.start.line),
        byte_for_line(&doc.source, decl.range.end.line.saturating_add(1)),
    )?;
    let spec = registry::spec(doc.lang);
    Some(Hover {
        signature: decl
            .detail
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| signature_for_node(&doc.source, node)),
        doc: doc_for(
            &doc.source,
            decl.range.start.line as usize,
            spec.doc_comment,
        ),
        kind: decl.kind.clone(),
    })
}

fn byte_for_line(source: &str, target: u32) -> usize {
    if target == 0 {
        return 0;
    }
    let mut line = 0u32;
    for (idx, ch) in source.char_indices() {
        if ch == '\n' {
            line += 1;
            if line == target {
                return idx + 1;
            }
        }
    }
    source.len()
}

fn doc_for(source: &str, decl_line: usize, style: DocCommentStyle) -> Option<String> {
    match style {
        DocCommentStyle::LeadingDocstring => python_docstring(source, decl_line),
        DocCommentStyle::LeadingLinePrefix(prefix) => leading_line_doc(source, decl_line, prefix),
        DocCommentStyle::BlockBefore(start, end) => block_doc_before(source, decl_line, start, end),
        DocCommentStyle::PrecedingCommentNode | DocCommentStyle::None => None,
    }
}

fn python_docstring(source: &str, decl_line: usize) -> Option<String> {
    for line in source.lines().skip(decl_line + 1).take(8) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        for quote in ["\"\"\"", "'''"] {
            if let Some(rest) = trimmed.strip_prefix(quote) {
                if let Some(end) = rest.find(quote) {
                    return Some(rest[..end].trim().to_string());
                }
            }
        }
        if !trimmed.starts_with('#') {
            return None;
        }
    }
    None
}

fn leading_line_doc(source: &str, decl_line: usize, prefix: &str) -> Option<String> {
    let lines: Vec<_> = source.lines().collect();
    let mut docs = Vec::new();
    for line in lines[..decl_line].iter().rev() {
        let trimmed = line.trim();
        if let Some(doc) = trimmed.strip_prefix(prefix) {
            docs.push(doc.trim().to_string());
        } else if trimmed.is_empty() {
            continue;
        } else {
            break;
        }
    }
    docs.reverse();
    (!docs.is_empty()).then(|| docs.join("\n"))
}

fn block_doc_before(source: &str, decl_line: usize, start: &str, end: &str) -> Option<String> {
    let before = source
        .lines()
        .take(decl_line)
        .collect::<Vec<_>>()
        .join("\n");
    let end_pos = before.rfind(end)?;
    let start_pos = before[..end_pos].rfind(start)?;
    Some(
        before[start_pos + start.len()..end_pos]
            .lines()
            .map(|line| line.trim().trim_start_matches('*').trim())
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}
