use super::features::symbols::symbols_for_source;
use super::parser_cache::ParserCache;
use super::registry;
use super::{IndexStats, Symbol};
use ignore::WalkBuilder;
use std::collections::HashMap;
use std::path::Path;

pub const MAX_FILE_BYTES: u64 = 1_048_576;

#[derive(Default)]
pub struct SymbolIndex {
    by_path: HashMap<String, Vec<Symbol>>,
    by_name: HashMap<String, Vec<Symbol>>,
}

impl SymbolIndex {
    pub fn stats(&self) -> IndexStats {
        IndexStats {
            indexed_files: self.by_path.len(),
            symbols: self.by_path.values().map(Vec::len).sum(),
        }
    }

    pub fn insert(&mut self, path: String, symbols: Vec<Symbol>) {
        self.remove(&path);
        for sym in &symbols {
            self.by_name
                .entry(sym.name.to_ascii_lowercase())
                .or_default()
                .push(sym.clone());
        }
        if !symbols.is_empty() {
            self.by_path.insert(path, symbols);
        }
    }

    pub fn remove(&mut self, path: &str) {
        if let Some(old) = self.by_path.remove(path) {
            for sym in old {
                if let Some(bucket) = self.by_name.get_mut(&sym.name.to_ascii_lowercase()) {
                    bucket.retain(|s| s.path != path || s.selection_range != sym.selection_range);
                }
            }
        }
        self.by_name.retain(|_, v| !v.is_empty());
    }

    pub fn matching(&self, query: &str, limit: u32) -> Vec<Symbol> {
        let q = query.trim().to_ascii_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        let mut out: Vec<(i32, Symbol)> = self
            .by_name
            .values()
            .flatten()
            .filter_map(|s| fuzzy_score(&s.name, &q).map(|score| (score, s.clone())))
            .collect();
        out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
        out.into_iter()
            .take(limit as usize)
            .map(|(_, s)| s)
            .collect()
    }

    pub fn by_exact_name(&self, name: &str) -> Vec<Symbol> {
        self.by_name
            .get(&name.to_ascii_lowercase())
            .cloned()
            .unwrap_or_default()
    }
}

pub fn build(root: &str, cache: &mut ParserCache) -> Result<SymbolIndex, String> {
    let mut index = SymbolIndex::default();
    for entry in WalkBuilder::new(root).build() {
        let Ok(entry) = entry else { continue };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        index_file(entry.path(), cache, &mut index)?;
    }
    Ok(index)
}

pub fn index_file(
    path: &Path,
    cache: &mut ParserCache,
    index: &mut SymbolIndex,
) -> Result<(), String> {
    let path_string = path.to_string_lossy().to_string();
    if !path.exists() {
        index.remove(&path_string);
        return Ok(());
    }
    if registry::language_for_path(&path_string).is_none() {
        return Ok(());
    }
    if std::fs::metadata(path)
        .map(|m| m.len() > MAX_FILE_BYTES)
        .unwrap_or(true)
    {
        return Ok(());
    }
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(()),
    };
    let Ok(source) = String::from_utf8(bytes) else {
        return Ok(());
    };
    cache.upsert(path_string.clone(), source, 0)?;
    if let Some(doc) = cache.get(&path_string) {
        let symbols = symbols_for_source(&path_string, doc);
        index.insert(path_string, symbols);
    }
    Ok(())
}

pub fn fuzzy_score(candidate: &str, query: &str) -> Option<i32> {
    let c = candidate.to_ascii_lowercase();
    if c.starts_with(query) {
        return Some(1000 - c.len() as i32);
    }
    if c.contains(query) {
        return Some(700 - c.len() as i32);
    }
    let mut pos = 0usize;
    for ch in query.chars() {
        let rest = &c[pos..];
        let found = rest.find(ch)?;
        pos += found + ch.len_utf8();
    }
    Some(400 - pos as i32)
}
