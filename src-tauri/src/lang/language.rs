use tree_sitter::Language as TsLanguage;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum LanguageId {
    JavaScript,
    TypeScript,
    Tsx,
    Rust,
    Java,
    Go,
    Ruby,
    Python,
    Json,
    Html,
    Css,
    Markdown,
    Sql,
}

#[derive(Clone, Copy)]
pub enum DocCommentStyle {
    LeadingLinePrefix(&'static str),
    BlockBefore(&'static str, &'static str),
    #[allow(dead_code)]
    PrecedingCommentNode,
    LeadingDocstring,
    None,
}

#[derive(Clone)]
pub struct LanguageSpec {
    pub id: LanguageId,
    pub ts_language: Option<TsLanguage>,
    pub symbols_query: &'static str,
    pub scopes_query: &'static str,
    pub members_query: Option<&'static str>,
    pub doc_comment: DocCommentStyle,
    pub keywords: &'static [&'static str],
}

#[allow(dead_code)]
pub trait Language: Send + Sync {
    fn spec(&self) -> &LanguageSpec;
}
