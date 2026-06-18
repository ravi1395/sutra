use super::features::{completion, hover, navigation, symbols};
use super::parser_cache::ParserCache;
use super::symbol_index::{self, SymbolIndex};
use super::{CompletionItem, DocumentSymbol, Hover, IndexStats, Location, Pos, Symbol};
use std::path::Path;

/// Owns the per-document parse cache and the workspace symbol index, and
/// implements the language features (completion, symbols, navigation, hover)
/// exposed through the Tauri commands in `mod.rs`.
#[derive(Default)]
pub struct LangEngine {
    cache: ParserCache,
    index: SymbolIndex,
}

impl LangEngine {
    /// Register or refresh an open document's parsed tree.
    pub fn did_open(&mut self, path: String, text: String, version: u64) -> Result<(), String> {
        self.cache.upsert(path, text, version)
    }

    /// Sync an edited document's text into the parse cache.
    pub fn did_change(&mut self, path: String, text: String, version: u64) -> Result<(), String> {
        self.cache.upsert(path, text, version)
    }

    /// Drop a closed document from the parse cache.
    pub fn did_close(&mut self, path: &str) {
        self.cache.remove(path);
    }

    /// Build the workspace symbol index from scratch under `root` (off-thread).
    pub fn index_build(&mut self, root: &str) -> Result<IndexStats, String> {
        let root = root.to_string();
        let handle = std::thread::spawn(move || {
            let mut cache = ParserCache::default();
            symbol_index::build(&root, &mut cache)
        });
        self.index = handle
            .join()
            .map_err(|_| "index thread panicked".to_string())??;
        Ok(self.index.stats())
    }

    /// Re-index the given paths after filesystem changes.
    pub fn index_invalidate(&mut self, paths: Vec<String>) -> Result<(), String> {
        for path in paths {
            symbol_index::index_file(Path::new(&path), &mut self.cache, &mut self.index)?;
        }
        Ok(())
    }

    /// Index a single already-open document; test helper for symbol lookups.
    #[cfg(test)]
    pub fn index_open_document(&mut self, path: &str) -> Result<(), String> {
        if let Some(doc) = self.cache.get(path) {
            self.index
                .insert(path.to_string(), symbols::symbols_for_source(path, doc));
        }
        Ok(())
    }

    /// Return the nested outline (document symbols) for a single file.
    pub fn document_symbols(&mut self, path: &str) -> Result<Vec<DocumentSymbol>, String> {
        Ok(self
            .cache
            .get(path)
            .map(symbols::symbols_for_document)
            .unwrap_or_default())
    }

    /// Fuzzy-match indexed workspace symbols by name, capped at `limit`.
    pub fn workspace_symbols(&self, query: &str, limit: u32) -> Vec<Symbol> {
        self.index.matching(query, limit)
    }

    /// Resolve definition candidates for the identifier at `pos` (local then workspace).
    pub fn goto_definition(&mut self, path: &str, pos: Pos) -> Result<Vec<Location>, String> {
        let Some(doc) = self.cache.get(path) else {
            return Ok(Vec::new());
        };
        let workspace = symbols::identifier_at(doc, pos)
            .map(|(name, _)| self.index.by_exact_name(&name))
            .unwrap_or_default();
        Ok(navigation::goto_definition(path, doc, pos, workspace))
    }

    /// Build hover/signature info for the identifier at `pos`, if any.
    pub fn hover(&mut self, path: &str, pos: Pos) -> Result<Option<Hover>, String> {
        let Some(doc) = self.cache.get(path) else {
            return Ok(None);
        };
        let workspace = symbols::identifier_at(doc, pos)
            .map(|(name, _)| self.index.by_exact_name(&name))
            .unwrap_or_default();
        Ok(hover::hover(path, doc, pos, workspace))
    }

    /// Produce completion items blending scope symbols, workspace symbols, and keywords.
    pub fn completion(
        &mut self,
        path: &str,
        pos: Pos,
        prefix: &str,
    ) -> Result<Vec<CompletionItem>, String> {
        let Some(doc) = self.cache.get(path) else {
            return Ok(Vec::new());
        };
        Ok(completion::completion(
            path,
            doc,
            pos,
            prefix,
            self.index.matching(prefix, 100),
        ))
    }
}
