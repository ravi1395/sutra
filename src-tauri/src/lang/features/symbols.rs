use crate::lang::parser_cache::ParsedDocument;
use crate::lang::{DocumentSymbol, Pos, Range, Symbol};
use tree_sitter::Node;

pub fn symbols_for_document(doc: &ParsedDocument) -> Vec<DocumentSymbol> {
    let flat = collect_symbols("", doc);
    nest_document_symbols(flat)
}

pub fn symbols_for_source(path: &str, doc: &ParsedDocument) -> Vec<Symbol> {
    collect_symbols(path, doc)
}

fn collect_symbols(path: &str, doc: &ParsedDocument) -> Vec<Symbol> {
    let mut out = Vec::new();
    let root = doc.tree.root_node();
    collect_node(root, &doc.source, path, &mut Vec::new(), &mut out);
    out
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
    let node = doc
        .tree
        .root_node()
        .named_descendant_for_byte_range(byte, byte)?;
    let node = if node.kind() == "identifier" {
        node
    } else {
        node.parent().filter(|p| p.kind() == "identifier")?
    };
    text_of(&doc.source, node).map(|name| (name, node))
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
    fn convert(sym: &Symbol, all: &[Symbol]) -> DocumentSymbol {
        let children = all
            .iter()
            .filter(|child| child.container.as_deref() == Some(sym.name.as_str()))
            .map(|child| convert(child, all))
            .collect();
        DocumentSymbol {
            name: sym.name.clone(),
            kind: sym.kind.clone(),
            range: sym.range.clone(),
            selection_range: sym.selection_range.clone(),
            children,
        }
    }
    flat.iter()
        .filter(|sym| sym.container.is_none())
        .map(|sym| convert(sym, &flat))
        .collect()
}
