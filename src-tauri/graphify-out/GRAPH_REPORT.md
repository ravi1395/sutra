# Graph Report - src-tauri  (2026-06-28)

## Corpus Check
- 29 files · ~35,018 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 720 nodes · 1820 edges · 25 communities
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 42 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c52e8244`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]

## God Nodes (most connected - your core abstractions)
1. `SutraMcp` - 38 edges
2. `Result` - 31 edges
3. `String` - 31 edges
4. `handle_conn()` - 22 edges
5. `TempDir` - 20 edges
6. `McpError` - 19 edges
7. `CallToolResult` - 19 edges
8. `mcp_write_agent_config()` - 19 edges
9. `scan_workspace()` - 18 edges
10. `String` - 16 edges

## Surprising Connections (you probably didn't know these)
- `resolve_rejects_escape()` --calls--> `TempDir`  [INFERRED]
  src/mcp.rs → src/git.rs
- `create_dir()` --calls--> `capture_paths()`  [INFERRED]
  src/fs_cmds.rs → src/agent_tracker.rs
- `delete_path()` --calls--> `capture_paths()`  [INFERRED]
  src/fs_cmds.rs → src/agent_tracker.rs
- `move_path()` --calls--> `capture_paths()`  [INFERRED]
  src/fs_cmds.rs → src/agent_tracker.rs
- `rename_path()` --calls--> `capture_paths()`  [INFERRED]
  src/fs_cmds.rs → src/agent_tracker.rs

## Import Cycles
- 1-file cycle: `src/agent_tracker.rs -> src/agent_tracker.rs`
- 1-file cycle: `src/git.rs -> src/git.rs`
- 1-file cycle: `src/assets.rs -> src/assets.rs`
- 1-file cycle: `src/debug.rs -> src/debug.rs`
- 1-file cycle: `src/preview_server.rs -> src/preview_server.rs`
- 1-file cycle: `src/fs_cmds.rs -> src/fs_cmds.rs`
- 1-file cycle: `src/mcp.rs -> src/mcp.rs`
- 1-file cycle: `src/lang/engine.rs -> src/lang/engine.rs`
- 1-file cycle: `src/lang/features/completion.rs -> src/lang/features/completion.rs`
- 1-file cycle: `src/lang/features/hover.rs -> src/lang/features/hover.rs`
- 1-file cycle: `src/lang/features/navigation.rs -> src/lang/features/navigation.rs`
- 1-file cycle: `src/lang/features/symbols.rs -> src/lang/features/symbols.rs`
- 1-file cycle: `src/lang/mod.rs -> src/lang/mod.rs`
- 1-file cycle: `src/lang/parser_cache.rs -> src/lang/parser_cache.rs`
- 1-file cycle: `src/lang/symbol_index.rs -> src/lang/symbol_index.rs`
- 1-file cycle: `src/pty.rs -> src/pty.rs`
- 1-file cycle: `src/watcher.rs -> src/watcher.rs`

## Communities (25 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (74): AtomicU64, AxumState, CallToolResult, Json, McpError, Next, Parameters, Request (+66 more)

### Community 1 - "Community 1"
Cohesion: 0.09
Nodes (67): BTreeMap, HashSet, Metadata, Snapshot, agent_command_kind(), agent_descendant_kind(), agent_descendant_kind_prefers_claude(), agent_tracking_accept() (+59 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (46): agent_script(), auth_set_cookie_header(), copy_until_eof(), handle_conn(), Head, head_insert_index(), host_is_loopback(), inject_agent() (+38 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (53): DocCommentStyle, block_doc_before(), byte_for_line(), doc_for(), hover(), leading_line_doc(), python_docstring(), goto_definition() (+45 more)

### Community 4 - "Community 4"
Cohesion: 0.10
Nodes (41): MasterPty, AgentState, AgentTerminal, classify_state(), default_shell(), has_permission_prompt(), is_agent(), process_command_name() (+33 more)

### Community 5 - "Community 5"
Cohesion: 0.15
Nodes (29): completion_blends_scope_symbols_workspace_symbols_and_keywords(), CompletionItem, DocumentSymbol, goto_prefers_nearest_local_declaration_then_workspace_fallback(), Hover, hover_returns_signature_and_python_docstring(), IndexStats, lang_completion() (+21 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (33): Duration, connect_with_retry(), DapEvent, debug_send(), debug_start(), debug_stop(), DebugSession, DebugState (+25 more)

### Community 7 - "Community 7"
Cohesion: 0.16
Nodes (25): canonicalize_in_root(), ErrorBody, file_url_path(), handle_client(), hex_val(), mime_for(), percent_decode(), percent_encode() (+17 more)

### Community 8 - "Community 8"
Cohesion: 0.12
Nodes (24): completion(), insert_best(), matches_prefix(), score(), build(), fuzzy_score(), index_file(), SymbolIndex (+16 more)

### Community 9 - "Community 9"
Cohesion: 0.19
Nodes (27): AheadBehindResult, branches_flag_head(), BranchInfo, canon(), ChangedFile, checkout_switches_head(), git_ahead_behind(), git_branch() (+19 more)

### Community 10 - "Community 10"
Cohesion: 0.21
Nodes (25): atomic_write(), atomic_write_creates_file_with_parents(), atomic_write_leaves_no_temp_files(), atomic_write_overwrites_existing_content(), compact(), compact_does_not_follow_symlinked_directories(), compact_stops_after_depth_limit(), create_dir() (+17 more)

### Community 11 - "Community 11"
Cohesion: 0.15
Nodes (14): Hover, LangEngine, CompletionItem, DocumentSymbol, IndexStats, Location, Option, ParserCache (+6 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (20): compile_queries(), ParsedDocument, ParserCache, lang(), language_for_path(), spec(), Language, Parser (+12 more)

### Community 13 - "Community 13"
Cohesion: 0.08
Nodes (23): app, security, windows, withGlobalTauri, build, beforeBuildCommand, beforeDevCommand, devUrl (+15 more)

### Community 14 - "Community 14"
Cohesion: 0.17
Nodes (20): BTreeSet, Event, Receiver, RecommendedWatcher, debounce_events(), emit_pending(), FsChangedPayload, AppHandle (+12 more)

### Community 15 - "Community 15"
Cohesion: 0.19
Nodes (14): claude_settings_inserts_hook_into_empty(), claude_settings_is_idempotent_and_preserves_other_keys(), claude_settings_preserves_a_pre_existing_different_hook(), codex_toml_inserts_and_preserves(), ensure_gitignore(), gitignore_appends_only_missing(), mcp_json_inserts_sutra_into_empty(), mcp_json_preserves_other_servers() (+6 more)

### Community 16 - "Community 16"
Cohesion: 0.22
Nodes (10): capture(), computedSubset(), currentRoute(), emitRoute(), isStableId(), onClick(), post(), routeKey() (+2 more)

### Community 17 - "Community 17"
Cohesion: 0.24
Nodes (12): AgentAsset, dirs_home(), invocation_for(), Option, Path, PathBuf, Result, String (+4 more)

### Community 18 - "Community 18"
Cohesion: 0.31
Nodes (9): Option, Result, String, Vec, search_accepts_regex_when_requested(), search_dir(), search_treats_pattern_as_literal_by_default(), SearchMatch (+1 more)

### Community 19 - "Community 19"
Cohesion: 0.28
Nodes (8): DocCommentStyle, Language, LanguageId, LanguageSpec, Option, Send, Sync, TsLanguage

### Community 20 - "Community 20"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

## Knowledge Gaps
- **91 isolated node(s):** `$schema`, `identifier`, `description`, `windows`, `permissions` (+86 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `with_auth_token()` connect `Community 0` to `Community 2`, `Community 7`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._
- **Why does `proxy_url()` connect `Community 2` to `Community 0`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Why does `TempDir` connect `Community 1` to `Community 0`, `Community 9`?**
  _High betweenness centrality (0.086) - this node is a cross-community bridge._
- **Are the 17 inferred relationships involving `TempDir` (e.g. with `git_head_id_disables_non_git_directories_and_changes_after_commit()` and `inactive_changes_become_the_next_agent_sessions_baseline()`) actually correct?**
  _`TempDir` has 17 INFERRED edges - model-reasoned connections that need verification._
- **What connects `$schema`, `identifier`, `description` to the rest of the system?**
  _91 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07329145250333143 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08765822784810126 - nodes in this community are weakly interconnected._