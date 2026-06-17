# Sutra Language-Intelligence Engine Design Spec

**Date:** 2026-06-17
**Status:** Approved — v1 scope locked (syntactic, in-process, no type layer)

---

## Overview

Add code intelligence — **completion, symbols/outline/go-to-definition, and hover/signature
help** — to Sutra **without** embedding heavy external language servers (rust-analyzer,
tsserver, gopls). Instead we build **Sutra's own lightweight, in-process Rust engine on
tree-sitter**: memory-efficient, multi-language, and modular. Adding a language is
"add a grammar crate + a few `.scm` query files + one registry arm" — no engine changes.

This honors the README's promise ("no language servers… no Electron overhead") while still
giving Sutra real navigation and editing assistance. The engine lives entirely inside the
existing Tauri backend; no new processes are spawned.

**v1 is deliberately syntactic.** Tree-sitter produces a concrete syntax tree, not types, so
v1 contains **no type inference and no diagnostics**. The feature set and the engine's shape
are chosen so type-awareness can be added later (see [Out of Scope](#out-of-scope--type-awareness-future))
without rewriting any feature.

---

## Decisions Made

| Question | Decision |
|---|---|
| Engine type | In-house tree-sitter engine (NOT an LSP client to external servers) |
| Process model | In-process Rust module inside the Tauri backend |
| v1 features | Completion · Document/Workspace Symbols + Outline + Go-to-definition · Hover & signature help |
| Diagnostics | **Out of v1** (no error/warning squiggles) |
| Type inference | **Out of v1** — purely syntactic; `TypeProvider` seam reserved for later |
| Languages | All currently highlighted: js/jsx/mjs/cjs, ts/tsx, rs, java, go, rb, py, json, html, css, md (SQL degrades — no vetted grammar) |
| Prototype language | **Python** (proves the whole pipeline end-to-end first) |
| IPC style | Synchronous `invoke` returning results (tree-sitter is sub-ms; no event streaming) |
| Modularity | A `Language` trait returning a data `LanguageSpec`; grammars + queries compiled lazily |

---

## Honest Contract — tree-sitter is *syntactic*, not type-inferring

Every feature is built to degrade gracefully, and the degradation is surfaced rather than hidden:

- **Completion** = identifiers in lexical scope + same-file & workspace symbols + language
  keywords + query-driven member names, fuzzy-ranked. `foo.` lists *known member-like names*,
  not the resolved type's members.
- **Hover / signature help** = slice the symbol's **declaration** signature line + its leading
  doc-comment + its kind, straight from source. Shows what was *written*, not inferred types.
- **Go-to-definition** = resolve the identifier to the nearest enclosing-scope declaration with
  that name (scope-aware where the grammar exposes scopes), else a workspace name-match.
  Multiple candidates → a picker.

When no syntactic answer exists (e.g. an un-annotated dynamic expression), the feature returns
empty/null and the editor falls back silently.

---

## Architecture

The engine follows Sutra's existing IPC pattern: a Rust subsystem behind a Tauri `State`,
typed wrappers in `ipc.ts`, and a thin frontend glue module. No new IPC primitives.

```
CodeMirror 6 (editor.ts)
  · CompletionSource  · hoverTooltip  · F12 goto  · Cmd+T workspace symbols  · Outline (tree.ts)
        ↕ pos<->offset mapping + calls            (src/lang.ts — CM6 <-> language glue)
  ipc.ts   (typed lang_* invoke wrappers — the only place UI touches the boundary)
        ↕ Tauri invoke (synchronous, result-returning)
  Rust · src-tauri/src/lang/   (in-process engine, behind LangState: Mutex<LangEngine>)
        ├─ registry  (ext -> LanguageId; lazy grammar + Query compile via OnceLock)
        ├─ parser_cache  (one Tree per open doc; pooled Parser per language; idle eviction)
        ├─ symbol_index  (workspace symbols via ignore::WalkBuilder; capped + LRU)
        └─ features/  (completion · symbols · navigation · hover)
        ↕ reuses existing fs-changed pipeline for index invalidation
  watcher.rs  (notify -> fs-changed event -> frontend -> lang_index_invalidate)
```

All feature commands run inline on the invoke thread (cheap). The one heavy operation —
`lang_index_build`, which walks the whole project — runs on a dedicated `std::thread`, mirroring
`pty.rs` / `debug.rs` / `watcher.rs`.

---

## Rust Backend — `src-tauri/src/lang/`

```
mod.rs          // module responsibility comment; LangState; all #[tauri::command]s
engine.rs       // LangEngine: owns ParserCache + SymbolIndex (behind Mutex in LangState)
registry.rs     // LanguageId enum + ext->LanguageId + lazy grammar/Query compile (OnceLock)
language.rs     // `Language` trait + LanguageSpec (grammar fn, query strings, DocCommentStyle, keywords)
parser_cache.rs // ParsedDocument {lang, tree, source, version, last_used} + parser pool + idle eviction
symbol_index.rs // SymbolIndex {by_path, by_name} built via ignore::WalkBuilder; capped + LRU
features/{completion.rs, symbols.rs, navigation.rs, hover.rs}
queries/<lang>/{symbols.scm, scopes.scm, members.scm}
```

### The language abstraction

Per-language behavior is almost entirely **data**: a grammar function pointer, a set of `.scm`
query strings, a doc-comment rule, and a keyword list. So the abstraction is a small trait that
mostly returns a `LanguageSpec`. Adding a language touches no engine code.

```rust
// language.rs — Defines the per-language abstraction. A Language supplies a tree-sitter
// grammar, the queries that drive every feature, and the rule for extracting a declaration's
// signature + doc comment. Everything else is generic.

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum LanguageId {
    JavaScript, TypeScript, Tsx, Rust, Java, Go, Ruby, Python,
    Json, Html, Css, Markdown, Sql, // Sql is structure-only / degraded
}

#[derive(Clone, Copy)]
pub enum DocCommentStyle {
    LeadingLinePrefix(&'static str),         // "///" rust, "#" ruby
    BlockBefore(&'static str, &'static str), // "/**" ... "*/" jsdoc
    PrecedingCommentNode,                    // slice contiguous preceding (comment) siblings
    LeadingDocstring,                        // Python: first string-literal stmt INSIDE the body
}

pub struct LanguageSpec {
    pub id: LanguageId,
    pub ts_language: tree_sitter::Language,
    pub symbols_query: &'static str,         // captures @name + @decl.<kind>
    pub scopes_query: &'static str,          // captures @scope nodes
    pub members_query: Option<&'static str>, // member-access completion hints
    pub doc_comment: DocCommentStyle,
    pub keywords: &'static [&'static str],
}

pub trait Language: Send + Sync {
    // One-line: returns the immutable spec describing this language's grammar + queries.
    fn spec(&self) -> &LanguageSpec;
}
```

`registry.rs` maps file extension → `LanguageId` (reusing the same mapping concept as
`detectLanguage()` in `editor.ts:381`, so front and back agree), and lazily compiles each
language's grammar + `tree_sitter::Query` objects on first use (`OnceLock`), so opening only
Python files never compiles the Go/Java/Ruby queries.

### State & data structures

```rust
// parser_cache.rs — Caches one incremental tree per open document; pools one Parser per
// language; evicts trees idle past a TTL.
pub struct ParsedDocument {
    pub lang: LanguageId,
    pub tree: tree_sitter::Tree,
    pub source: String, // needed to slice signatures/docs
    pub version: u64,   // monotonic; stale edits ignored
    pub last_used: std::time::Instant,
}

// symbol_index.rs — Workspace symbol table built by walking the project (ignore::WalkBuilder,
// respecting .gitignore), running each file's symbols query. Stores lightweight Symbols only —
// no trees, no source.
#[derive(Clone, serde::Serialize)]
pub struct Symbol {
    pub name: String,
    pub kind: String,               // "function" | "class" | "struct" | ...
    pub path: String,
    pub range: Range,               // full declaration span
    pub selection_range: Range,     // the name span (highlighted on goto)
    pub container: Option<String>,  // enclosing symbol (e.g. "Foo.bar")
    pub detail: Option<String>,     // signature slice, filled lazily for hover
}

// mod.rs
#[derive(Default)]
pub struct LangState(pub std::sync::Mutex<engine::LangEngine>);
```

**Memory strategy:** trees live only for open docs plus a small LRU, swept by an idle thread
(TTL ~5 min, modeled on `watcher.rs`'s `recv_timeout` loop). The index keeps only `Symbol`
structs, caps the indexed-file count, and skips files larger than `MAX_FILE_BYTES` (the same
convention `search.rs` uses). Grammars cost binary size (shared read-only parser tables), not
runtime heap.

**Incremental edits:** v1 reparses from full text on a debounced change (sub-ms for typical
files); the `tree.edit(InputEdit)` fast-path is a later optimization behind the same command
signature.

**Panic containment:** every parse/query call is wrapped in `std::panic::catch_unwind`, so a
malformed grammar or pathological input returns `Err`/empty instead of crashing Tauri.

---

## IPC Surface

All commands are **synchronous `invoke`** returning a result — tree-sitter is fast enough that
event streaming would add complexity for no benefit (events stay reserved for genuinely async
streams like PTY/DAP). Register each in the `generate_handler![]` block in `lib.rs` and
`.manage(lang::LangState::default())`.

Positions are `{ line, character }`, 0-based, UTF-16 column (CM6 string semantics). The frontend
converts CM6 offset ↔ position in `src/lang.ts`.

| Command | Signature → returns | Purpose |
|---|---|---|
| `lang_did_open` | `(path, text, version)` → `()` | register/refresh an open doc |
| `lang_did_change` | `(path, text, version)` → `()` | debounced edit sync |
| `lang_did_close` | `(path)` → `()` | drop cached tree |
| `lang_index_build` | `(root)` → `IndexStats` | build workspace symbol index (own thread) |
| `lang_index_invalidate` | `(paths)` → `()` | re-extract changed / drop deleted files |
| `lang_completion` | `(path, pos, prefix)` → `CompletionItem[]` | scope + index + keywords + members |
| `lang_document_symbols` | `(path)` → `DocumentSymbol[]` | nested tree for the outline |
| `lang_workspace_symbols` | `(query, limit)` → `Symbol[]` | Cmd+T fuzzy jump |
| `lang_goto_definition` | `(path, pos)` → `Location[]` | 0 / 1 / many candidates |
| `lang_hover` | `(path, pos)` → `Hover \| null` | signature + doc + kind |

Matching typed wrappers and the `Pos` / `Range` / `CompletionItem` / `DocumentSymbol` /
`Location` / `Hover` interfaces go in `src/ipc.ts` — the only place UI code touches the boundary.

---

## Tree-sitter Query Approach

- **`symbols.scm`** per language uses conventional captures: `@name` (selection range) plus a
  `@decl.<kind>` on the declaration node — the suffix after `decl.` *is* the kind string, so no
  separate mapping table is needed beyond a `&str -> kind` lookup. One generic walker serves
  document symbols, the workspace index, goto, and hover. `container` is computed by walking
  parents to the nearest enclosing declaration.
- **`scopes.scm`** captures `@scope` nodes (function bodies, blocks, modules). Completion and
  goto find the deepest `@scope` containing the cursor, then collect declarations inside that
  scope and its ancestors.
- **Signature + doc** — given a declaration node, the signature is the source slice from the
  node start to its body start (`{` / `:` / `=>`), trimmed to a line or two; the doc-comment is
  resolved per `DocCommentStyle`. All by byte-slicing `ParsedDocument.source` — no per-language
  Rust.

### Example — `queries/python/symbols.scm` (Phase 1 prototype)

```scheme
(function_definition name: (identifier) @name) @decl.function
(class_definition    name: (identifier) @name) @decl.class
; methods are function_definitions nested in a class body -> container via parent-walk
(assignment left: (identifier) @name) @decl.variable
(decorated_definition (function_definition name: (identifier) @name)) @decl.function
```

Python's docstring (used for hover/signature) is the first `(expression_statement (string))`
child of the definition's `block` — handled by the `LeadingDocstring` style, distinct from the
`///` / `#` / JSDoc styles. `container` is the nearest ancestor `class_definition` name.

---

## Frontend Wiring

Per CLAUDE.md's "reuse before adding", completion/hover/goto mount as CM6 extensions inside the
existing `Pane.extensions()` (`editor.ts:536`); the outline reuses `tree.ts`; workspace-symbol
jump reuses `palette.ts`. The only new module is `src/lang.ts`.

- **`src/lang.ts`** (new — distinct responsibility: CM6 ↔ language-IPC glue, position mapping,
  the CompletionSource / hoverTooltip / goto command). Independently unit-testable.
- **Completion:** `autocompletion({ override: [langCompletionSource(...)] })`, ~150 ms delay,
  `boost` from the backend score. Import `@codemirror/autocomplete` explicitly (it ships with
  the `codemirror` meta package).
- **Hover:** `hoverTooltip(...)` → `lang_hover`, rendering the signature in a `<pre>` + a kind
  badge + the doc-comment sanitized through DOMPurify (already a dependency).
- **Go-to-definition:** a keymap entry (F12 / Cmd-click) in the `Prec.high(keymap.of([...]))`
  block; one result → `mgr.openFile(path, line + 1)`, many → the palette picker.
- **Outline:** extend `src/tree.ts` (it already renders nested, collapsible, badged rows) with
  an Outline view over `DocumentSymbol[]`; rows call `editor.openFile` / `revealLine`.
- **Workspace symbols:** reuse `mountPalette` (Cmd+T) backed by `langWorkspaceSymbols(query)`.
- **Lifecycle:** `openFile` → `langDidOpen`; the existing `docChanged` updateListener
  (`editor.ts:593`) → debounced `langDidChange`; tab close → `langDidClose`; after `watchStart`
  (`main.ts:509`) → `langIndexBuild(dir)`; the `onFsChanged` handler (`main.ts:205`) →
  `langIndexInvalidate(paths)`.

---

## Crates (`src-tauri/Cargo.toml`)

`tree-sitter` (0.24+) plus grammar crates: `tree-sitter-javascript` (covers js/jsx/mjs/cjs),
`tree-sitter-typescript` (TS + TSX), `-rust`, `-java`, `-go`, `-ruby`, `-python`, `-json`,
`-html`, `-css`, `-md`.

**SQL** has no single vetted mainstream tree-sitter grammar, so `LanguageId::Sql` is registered
with **no grammar** — all features return empty/null gracefully. (Optionally, a regex-based
`CREATE` / CTE extractor reusing the existing `regex` crate.) The unified frontend API is
unaffected; if a grammar is later chosen it slots in as one registry arm + one `.scm` set.

---

## Performance & Memory

- One reusable `tree_sitter::Parser` per `LanguageId` (set language once, reuse across docs).
- One `Tree` per open doc; full-text reparse on debounced change in v1; `InputEdit` fast-path later.
- Idle eviction thread drops `ParsedDocument`s idle past the TTL and LRU-trims the index over cap.
- Index is incremental: `lang_index_invalidate` re-extracts only changed files via the existing
  `fs-changed` pipeline; the active file's symbols come from its live cached tree (no disk read).
- Frontend debounces: completion ~150 ms, `langDidChange` ~200 ms, hover uses CM6's built-in delay.
- `catch_unwind` around parse/query; heavy `lang_index_build` on a dedicated thread.

---

## Out of Scope — Type-Awareness (future)

v1 is purely syntactic. The engine is shaped so type-awareness slots in later **without
rewriting any feature**. The goal is type-aware *features* (correct member completion, accurate
hover), not inference for its own sake — so harvest types that are already written/computed and
only shallowly infer the rest.

- **Seam (reserve now):** a `TypeProvider` trait + a confidence-ordered provider chain.
  Completion/hover/goto ask "what's the type at this position?" and take the first hit, else fall
  back to syntactic. In v1 the chain is empty — purely an interface.
- **Tier A (future, in-process):** annotation reading + shallow local-flow (`x: T`, literals,
  `x = Foo()` → `Foo` resolved via the existing `SymbolIndex`). Python (PEP 484 hints +
  constructor calls) is the chosen first target.
- **Tier B (future, parse-only):** harvest ecosystem metadata into the index — Python `.pyi`
  stubs / typeshed, TS `.d.ts`, Rust rustdoc JSON. Real resolved types, no inference engine.
- **Tier C (future, optional, out-of-process):** spawn the real tool (pyright / tsserver /
  jdt.ls / …) and merge into the same IPC surface — the only path to full generic inference,
  purely additive. This is also what Java *debugging* needs (jdt.ls hosts `java-debug`); see the
  debugger spec's Java row.

---

## Testing

- **Rust** (`cargo test` in `src-tauri/`): per-language symbol extraction (name/kind/container/
  ranges), parser-cache version monotonicity + eviction, scope-aware vs fallback goto, and
  signature/doc slicing per `DocCommentStyle` (incl. Python `LeadingDocstring`). Use `tempfile`
  for index-build tests, as `search.rs` does.
- **TS** (`npm test`, `node:test`): `tests/lang.test.ts` — `offsetToPos` / `posToOffset`
  round-trip (multi-line, CRLF, empty lines, EOF), kind → CM type mapping, and completion-source
  `from` / option mapping against a mocked `langCompletion`.
- **Manual** (`npm run tauri dev`): open a `.py` file — outline populates and clicking jumps;
  typing shows completions; hover shows signature + docstring; F12 / Cmd+T navigate. Probe each
  new Tauri command with sample inputs per CLAUDE.md's backend-verification rule.

---

## Phased Rollout

1. **Python end-to-end (structure):** the `lang/` skeleton, trait + registry, parser cache,
   symbol index, `did_open/change/close`, `index_build/invalidate`, `document_symbols`,
   `workspace_symbols`, `goto_definition`; frontend `src/lang.ts` position helpers, outline in
   `tree.ts`, Cmd+T via palette, F12 goto. Proves the whole pipeline + eviction + panic containment.
2. **Completion** — `lang_completion` + the CM6 CompletionSource.
3. **Hover & signature** — `lang_hover` + `DocCommentStyle` (incl. `LeadingDocstring`) + hoverTooltip.
4. **Remaining languages** — additive only: grammar crate + `.scm` set + registry arm + keyword
   list per language; SQL stays graceful-degraded. Validates the abstraction (no engine changes).
