use super::language::{DocCommentStyle, LanguageId, LanguageSpec};
use std::path::Path;
use tree_sitter::Language as TsLanguage;

const PY_KEYWORDS: &[&str] = &[
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
    "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import",
    "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
    "with", "yield",
];

const JS_KEYWORDS: &[&str] = &[
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
    "else", "export", "extends", "finally", "for", "function", "if", "import", "let", "new",
    "return", "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with", "yield",
];

const RUST_KEYWORDS: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "crate", "else", "enum", "extern",
    "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "static", "struct", "trait", "true", "type", "unsafe", "use", "where",
    "while",
];

const GO_KEYWORDS: &[&str] = &[
    "break",
    "case",
    "chan",
    "const",
    "continue",
    "default",
    "defer",
    "else",
    "fallthrough",
    "for",
    "func",
    "go",
    "goto",
    "if",
    "import",
    "interface",
    "map",
    "package",
    "range",
    "return",
    "select",
    "struct",
    "switch",
    "type",
    "var",
];

const RUBY_KEYWORDS: &[&str] = &[
    "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do",
    "else", "elsif", "end", "ensure", "false", "for", "if", "in", "module", "next", "nil", "not",
    "or", "redo", "rescue", "retry", "return", "self", "super", "then", "true", "undef", "unless",
    "until", "when", "while", "yield",
];

const JAVA_KEYWORDS: &[&str] = &[
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "final",
    "finally",
    "float",
    "for",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "native",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "try",
    "void",
    "volatile",
    "while",
];

const CSS_KEYWORDS: &[&str] = &["color", "display", "flex", "grid", "margin", "padding"];
const JSON_KEYWORDS: &[&str] = &["false", "null", "true"];
const HTML_KEYWORDS: &[&str] = &[
    "a", "body", "button", "div", "head", "html", "input", "span",
];
const MD_KEYWORDS: &[&str] = &[];

pub fn language_for_path(path: &str) -> Option<LanguageId> {
    let p = Path::new(path);
    let name = p.file_name()?.to_string_lossy().to_ascii_lowercase();
    if name == "dockerfile" {
        return None;
    }
    match p
        .extension()?
        .to_string_lossy()
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "jsx" | "mjs" | "cjs" => Some(LanguageId::JavaScript),
        "ts" => Some(LanguageId::TypeScript),
        "tsx" => Some(LanguageId::Tsx),
        "rs" => Some(LanguageId::Rust),
        "java" => Some(LanguageId::Java),
        "go" => Some(LanguageId::Go),
        "rb" => Some(LanguageId::Ruby),
        "py" => Some(LanguageId::Python),
        "json" | "jsonc" => Some(LanguageId::Json),
        "html" | "htm" => Some(LanguageId::Html),
        "css" => Some(LanguageId::Css),
        "md" | "markdown" => Some(LanguageId::Markdown),
        "sql" => Some(LanguageId::Sql),
        _ => None,
    }
}

fn lang(id: LanguageId) -> Option<TsLanguage> {
    Some(match id {
        LanguageId::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
        LanguageId::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        LanguageId::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        LanguageId::Rust => tree_sitter_rust::LANGUAGE.into(),
        LanguageId::Java => tree_sitter_java::LANGUAGE.into(),
        LanguageId::Go => tree_sitter_go::LANGUAGE.into(),
        LanguageId::Ruby => tree_sitter_ruby::LANGUAGE.into(),
        LanguageId::Python => tree_sitter_python::LANGUAGE.into(),
        LanguageId::Json => tree_sitter_json::LANGUAGE.into(),
        LanguageId::Html => tree_sitter_html::LANGUAGE.into(),
        LanguageId::Css => tree_sitter_css::LANGUAGE.into(),
        LanguageId::Markdown => tree_sitter_md::LANGUAGE.into(),
        LanguageId::Sql => return None,
    })
}

pub fn spec(id: LanguageId) -> LanguageSpec {
    match id {
        LanguageId::Python => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/python/symbols.scm"),
            scopes_query: include_str!("queries/python/scopes.scm"),
            members_query: Some(include_str!("queries/python/members.scm")),
            doc_comment: DocCommentStyle::LeadingDocstring,
            keywords: PY_KEYWORDS,
        },
        LanguageId::Rust => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/rust/symbols.scm"),
            scopes_query: include_str!("queries/rust/scopes.scm"),
            members_query: Some(include_str!("queries/rust/members.scm")),
            doc_comment: DocCommentStyle::LeadingLinePrefix("///"),
            keywords: RUST_KEYWORDS,
        },
        LanguageId::JavaScript | LanguageId::TypeScript | LanguageId::Tsx => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/javascript/symbols.scm"),
            scopes_query: include_str!("queries/javascript/scopes.scm"),
            members_query: Some(include_str!("queries/javascript/members.scm")),
            doc_comment: DocCommentStyle::BlockBefore("/**", "*/"),
            keywords: JS_KEYWORDS,
        },
        LanguageId::Go => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/go/symbols.scm"),
            scopes_query: include_str!("queries/go/scopes.scm"),
            members_query: Some(include_str!("queries/go/members.scm")),
            doc_comment: DocCommentStyle::LeadingLinePrefix("//"),
            keywords: GO_KEYWORDS,
        },
        LanguageId::Ruby => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/ruby/symbols.scm"),
            scopes_query: include_str!("queries/ruby/scopes.scm"),
            members_query: Some(include_str!("queries/ruby/members.scm")),
            doc_comment: DocCommentStyle::LeadingLinePrefix("#"),
            keywords: RUBY_KEYWORDS,
        },
        LanguageId::Java => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/java/symbols.scm"),
            scopes_query: include_str!("queries/java/scopes.scm"),
            members_query: Some(include_str!("queries/java/members.scm")),
            doc_comment: DocCommentStyle::BlockBefore("/**", "*/"),
            keywords: JAVA_KEYWORDS,
        },
        LanguageId::Json => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/json/symbols.scm"),
            scopes_query: include_str!("queries/json/scopes.scm"),
            members_query: None,
            doc_comment: DocCommentStyle::None,
            keywords: JSON_KEYWORDS,
        },
        LanguageId::Html => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/html/symbols.scm"),
            scopes_query: include_str!("queries/html/scopes.scm"),
            members_query: None,
            doc_comment: DocCommentStyle::None,
            keywords: HTML_KEYWORDS,
        },
        LanguageId::Css => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/css/symbols.scm"),
            scopes_query: include_str!("queries/css/scopes.scm"),
            members_query: Some(include_str!("queries/css/members.scm")),
            doc_comment: DocCommentStyle::BlockBefore("/*", "*/"),
            keywords: CSS_KEYWORDS,
        },
        LanguageId::Markdown => LanguageSpec {
            id,
            ts_language: lang(id),
            symbols_query: include_str!("queries/markdown/symbols.scm"),
            scopes_query: include_str!("queries/markdown/scopes.scm"),
            members_query: None,
            doc_comment: DocCommentStyle::None,
            keywords: MD_KEYWORDS,
        },
        LanguageId::Sql => LanguageSpec {
            id,
            ts_language: None,
            symbols_query: "",
            scopes_query: "",
            members_query: None,
            doc_comment: DocCommentStyle::None,
            keywords: &[],
        },
    }
}
