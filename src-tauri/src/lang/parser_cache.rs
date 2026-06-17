use super::language::LanguageId;
use super::registry;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};
use tree_sitter::{Parser, Query, Tree};

pub const PARSED_DOC_TTL: Duration = Duration::from_secs(5 * 60);

pub struct ParsedDocument {
    pub lang: LanguageId,
    pub tree: Tree,
    pub source: String,
    pub version: u64,
    pub last_used: Instant,
}

#[derive(Default)]
pub struct ParserCache {
    docs: HashMap<String, ParsedDocument>,
    parsers: HashMap<LanguageId, Parser>,
}

impl ParserCache {
    pub fn upsert(&mut self, path: String, source: String, version: u64) -> Result<(), String> {
        let Some(lang) = registry::language_for_path(&path) else {
            return Ok(());
        };
        self.evict_idle(Instant::now());
        let spec = registry::spec(lang);
        let Some(ref ts_language) = spec.ts_language else {
            return Ok(());
        };
        if self
            .docs
            .get(&path)
            .map(|doc| version < doc.version)
            .unwrap_or(false)
        {
            return Ok(());
        }
        let parser = self.parsers.entry(lang).or_default();
        parser
            .set_language(ts_language)
            .map_err(|e| e.to_string())?;
        compile_queries(ts_language, &spec)?;
        let tree = catch_unwind(AssertUnwindSafe(|| parser.parse(&source, None)))
            .map_err(|_| "parser panicked".to_string())?
            .ok_or_else(|| "parse failed".to_string())?;
        self.docs.insert(
            path,
            ParsedDocument {
                lang,
                tree,
                source,
                version,
                last_used: Instant::now(),
            },
        );
        Ok(())
    }

    pub fn remove(&mut self, path: &str) {
        self.docs.remove(path);
    }

    pub fn get(&mut self, path: &str) -> Option<&ParsedDocument> {
        if let Some(doc) = self.docs.get_mut(path) {
            doc.last_used = Instant::now();
        }
        self.docs.get(path)
    }

    pub fn evict_idle(&mut self, now: Instant) {
        self.docs
            .retain(|_, doc| now.duration_since(doc.last_used) <= PARSED_DOC_TTL);
    }
}

fn compile_queries(
    language: &tree_sitter::Language,
    spec: &super::language::LanguageSpec,
) -> Result<(), String> {
    let _ = spec.id;
    for query in [
        Some(spec.symbols_query),
        Some(spec.scopes_query),
        spec.members_query,
    ]
    .into_iter()
    .flatten()
    .filter(|q| !q.trim().is_empty())
    {
        catch_unwind(AssertUnwindSafe(|| Query::new(language, query)))
            .map_err(|_| "query compiler panicked".to_string())?
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
