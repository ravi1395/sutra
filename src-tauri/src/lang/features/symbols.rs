use crate::lang::parser_cache::ParsedDocument;
use crate::lang::registry;
use crate::lang::{DocumentSymbol, Pos, Range, Symbol};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Query, QueryCursor};

pub fn symbols_for_document(doc: &ParsedDocument) -> Vec<DocumentSymbol> {
    let flat = collect_symbols("", doc);
    nest_document_symbols(flat)
}

pub fn symbols_for_source(path: &str, doc: &ParsedDocument) -> Vec<Symbol> {
    collect_symbols(path, doc)
}

fn collect_symbols(path: &str, doc: &ParsedDocument) -> Vec<Symbol> {
    let queried = collect_query_symbols(path, doc);
    if !queried.is_empty() {
        return queried;
    }
    let mut out = Vec::new();
    let root = doc.tree.root_node();
    collect_node(root, &doc.source, path, &mut Vec::new(), &mut out);
    out
}

fn collect_query_symbols(path: &str, doc: &ParsedDocument) -> Vec<Symbol> {
    let spec = registry::spec(doc.lang);
    let Some(ref language) = spec.ts_language else {
        return Vec::new();
    };
    if spec.symbols_query.trim().is_empty() {
        return Vec::new();
    }
    let Ok(query) = Query::new(language, spec.symbols_query) else {
        return Vec::new();
    };
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, doc.tree.root_node(), doc.source.as_bytes());
    let mut symbols = Vec::new();

    while let Some(query_match) = matches.next() {
        let mut decl_node = None;
        let mut name_node = None;
        let mut kind = None;
        for capture in query_match.captures {
            let capture_name = capture_names
                .get(capture.index as usize)
                .copied()
                .unwrap_or_default();
            if capture_name == "name" {
                name_node = Some(capture.node);
            } else if let Some(rest) = capture_name.strip_prefix("decl.") {
                decl_node = Some(capture.node);
                kind = Some(rest);
            }
        }
        let (Some(decl_node), Some(name_node), Some(kind)) = (decl_node, name_node, kind) else {
            continue;
        };
        let Some(name) = text_of(&doc.source, name_node) else {
            continue;
        };
        symbols.push(Symbol {
            name,
            kind: kind.to_string(),
            path: path.to_string(),
            range: node_range(&doc.source, decl_node),
            selection_range: node_range(&doc.source, name_node),
            container: None,
            detail: Some(signature_for_node(&doc.source, decl_node)),
        });
    }

    assign_containers(&mut symbols);
    symbols
}

fn assign_containers(symbols: &mut [Symbol]) {
    let parents = parent_indices(symbols);
    for idx in 0..symbols.len() {
        symbols[idx].container = parents[idx].map(|parent| symbols[parent].name.clone());
    }
}

fn collect_node(
    node: Node<'_>,
    source: &str,
    path: &str,
    containers: &mut Vec<String>,
    out: &mut Vec<Symbol>,
) {
    if let Some((name, kind, selection)) = declaration_name(node, source) {
        let sym = Symbol {
            name: name.clone(),
            kind: kind.to_string(),
            path: path.to_string(),
            range: node_range(source, node),
            selection_range: node_range(source, selection),
            container: containers.last().cloned(),
            detail: Some(signature_for_node(source, node)),
        };
        containers.push(name);
        out.push(sym);
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            collect_node(child, source, path, containers, out);
        }
        containers.pop();
        return;
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_node(child, source, path, containers, out);
    }
}

fn declaration_name<'a>(node: Node<'a>, source: &str) -> Option<(String, &'static str, Node<'a>)> {
    match node.kind() {
        "function_definition" => {
            named_field(node, "name", source).map(|(n, id)| (n, "function", id))
        }
        "class_definition" => named_field(node, "name", source).map(|(n, id)| (n, "class", id)),
        "assignment" => {
            let left = node.child_by_field_name("left")?;
            if left.kind() == "identifier" {
                text_of(source, left).map(|n| (n, "variable", left))
            } else {
                None
            }
        }
        "decorated_definition" => {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if matches!(child.kind(), "function_definition" | "class_definition") {
                    return declaration_name(child, source);
                }
            }
            None
        }
        "function_declaration"
        | "method_declaration"
        | "function_item"
        | "function_declaration_item" => {
            named_field(node, "name", source).map(|(n, id)| (n, "function", id))
        }
        "class_declaration" | "class" => {
            named_field(node, "name", source).map(|(n, id)| (n, "class", id))
        }
        "struct_item" | "struct_declaration" | "type_declaration" => {
            named_field(node, "name", source).map(|(n, id)| (n, "struct", id))
        }
        _ => None,
    }
}

fn named_field<'a>(node: Node<'a>, field: &str, source: &str) -> Option<(String, Node<'a>)> {
    let id = node.child_by_field_name(field)?;
    text_of(source, id).map(|name| (name, id))
}

pub fn text_of(source: &str, node: Node<'_>) -> Option<String> {
    source.get(node.byte_range()).map(ToString::to_string)
}

pub fn node_range(source: &str, node: Node<'_>) -> Range {
    Range {
        start: point_to_pos(source, node.start_byte()),
        end: point_to_pos(source, node.end_byte()),
    }
}

pub fn point_to_pos(source: &str, byte: usize) -> Pos {
    let clamped = byte.min(source.len());
    let before = &source[..clamped];
    let line = before.bytes().filter(|b| *b == b'\n').count();
    let line_start = before.rfind('\n').map(|idx| idx + 1).unwrap_or(0);
    let character = source[line_start..clamped].encode_utf16().count();
    Pos {
        line: line as u32,
        character: character as u32,
    }
}

pub fn pos_to_byte(source: &str, pos: Pos) -> usize {
    let mut line_start = 0usize;
    for (line_idx, line) in source.split_inclusive('\n').enumerate() {
        if line_idx == pos.line as usize {
            let line_no_newline = line.strip_suffix('\n').unwrap_or(line);
            let mut utf16 = 0usize;
            for (byte_idx, ch) in line_no_newline.char_indices() {
                if utf16 >= pos.character as usize {
                    return line_start + byte_idx;
                }
                utf16 += ch.len_utf16();
            }
            return line_start + line_no_newline.len();
        }
        line_start += line.len();
    }
    source.len()
}

pub fn identifier_at(doc: &ParsedDocument, pos: Pos) -> Option<(String, Node<'_>)> {
    let byte = pos_to_byte(&doc.source, pos);
    let mut node = doc
        .tree
        .root_node()
        .named_descendant_for_byte_range(byte, byte)?;
    while !is_identifier_like(node.kind()) {
        node = node.parent()?;
    }
    text_of(&doc.source, node).map(|name| (name, node))
}

fn is_identifier_like(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "type_identifier"
            | "property_identifier"
            | "field_identifier"
            | "constant"
            | "shorthand_property_identifier"
            | "shorthand_property_identifier_pattern"
    )
}

pub fn signature_for_node(source: &str, node: Node<'_>) -> String {
    let text = source.get(node.byte_range()).unwrap_or_default();
    let end = text
        .find(':')
        .or_else(|| text.find('{'))
        .or_else(|| text.find("=>"))
        .unwrap_or_else(|| text.find('\n').unwrap_or(text.len()));
    text[..end].trim().to_string()
}

pub fn symbol_at_selection(symbols: &[Symbol], pos: Pos) -> Option<Symbol> {
    symbols
        .iter()
        .find(|s| contains_pos(&s.selection_range, pos))
        .cloned()
}

pub fn contains_pos(range: &Range, pos: Pos) -> bool {
    (pos.line > range.start.line
        || pos.line == range.start.line && pos.character >= range.start.character)
        && (pos.line < range.end.line
            || pos.line == range.end.line && pos.character <= range.end.character)
}

fn nest_document_symbols(flat: Vec<Symbol>) -> Vec<DocumentSymbol> {
    fn convert(idx: usize, all: &[Symbol], parents: &[Option<usize>]) -> DocumentSymbol {
        let sym = &all[idx];
        let children = all
            .iter()
            .enumerate()
            .filter(|(child_idx, _)| parents[*child_idx] == Some(idx))
            .map(|(child_idx, _)| convert(child_idx, all, parents))
            .collect();
        DocumentSymbol {
            name: sym.name.clone(),
            kind: sym.kind.clone(),
            range: sym.range.clone(),
            selection_range: sym.selection_range.clone(),
            children,
        }
    }
    let parents = parent_indices(&flat);
    flat.iter()
        .enumerate()
        .filter(|(idx, _)| parents[*idx].is_none())
        .map(|(idx, _)| convert(idx, &flat, &parents))
        .collect()
}

fn parent_indices(symbols: &[Symbol]) -> Vec<Option<usize>> {
    let mut parents = Vec::with_capacity(symbols.len());
    for (idx, child) in symbols.iter().enumerate() {
        let parent = symbols
            .iter()
            .enumerate()
            .filter(|(candidate_idx, parent)| {
                *candidate_idx != idx && range_strictly_contains(&parent.range, &child.range)
            })
            .min_by_key(|(_, parent)| range_span_key(&parent.range))
            .map(|(candidate_idx, _)| candidate_idx);
        parents.push(parent);
    }
    parents
}

fn range_strictly_contains(parent: &Range, child: &Range) -> bool {
    range_contains(parent, child.start)
        && range_contains(parent, child.end)
        && (parent.start != child.start || parent.end != child.end)
}

fn range_contains(range: &Range, pos: Pos) -> bool {
    pos_after_or_eq(pos, range.start) && pos_before_or_eq(pos, range.end)
}

fn pos_after_or_eq(pos: Pos, start: Pos) -> bool {
    pos.line > start.line || pos.line == start.line && pos.character >= start.character
}

fn pos_before_or_eq(pos: Pos, end: Pos) -> bool {
    pos.line < end.line || pos.line == end.line && pos.character <= end.character
}

fn range_span_key(range: &Range) -> (u32, u32) {
    (
        range.end.line.saturating_sub(range.start.line),
        range.end.character.saturating_sub(range.start.character),
    )
}
