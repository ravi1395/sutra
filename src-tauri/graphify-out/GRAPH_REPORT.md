# Graph Report - src-tauri  (2026-07-19)

## Corpus Check
- 37 files · ~70,382 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1296 nodes · 3582 edges · 33 communities
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 29 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `0514e334`
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
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]

## God Nodes (most connected - your core abstractions)
1. `SutraMcp` - 50 edges
2. `Result` - 44 edges
3. `Tracker` - 40 edges
4. `String` - 40 edges
5. `Path` - 38 edges
6. `Option` - 32 edges
7. `String` - 32 edges
8. `McpError` - 31 edges
9. `CallToolResult` - 30 edges
10. `String` - 28 edges

## Surprising Connections (you probably didn't know these)
- `with_root_guard()` --calls--> `F`  [INFERRED]
  src/window_registry.rs → src/dock_menu.rs
- `mcp_write_agent_config()` --calls--> `capture_paths()`  [INFERRED]
  src/mcp.rs → src/agent_tracker.rs
- `agent_command_kind()` --calls--> `name_of()`  [INFERRED]
  src/agent_tracker.rs → src/fs_cmds.rs
- `completion()` --calls--> `contains_pos()`  [INFERRED]
  src/lang/features/completion.rs → src/lang/features/symbols.rs
- `completion()` --calls--> `symbols_for_source()`  [INFERRED]
  src/lang/features/completion.rs → src/lang/features/symbols.rs

## Import Cycles
- 1-file cycle: `src/agent_tracker.rs -> src/agent_tracker.rs`
- 1-file cycle: `src/app_state.rs -> src/app_state.rs`
- 1-file cycle: `src/assets.rs -> src/assets.rs`
- 1-file cycle: `src/cli_install.rs -> src/cli_install.rs`
- 1-file cycle: `src/debug.rs -> src/debug.rs`
- 1-file cycle: `src/dock_menu.rs -> src/dock_menu.rs`
- 1-file cycle: `src/fs_cmds.rs -> src/fs_cmds.rs`
- 1-file cycle: `src/git.rs -> src/git.rs`
- 1-file cycle: `src/lang/engine.rs -> src/lang/engine.rs`
- 1-file cycle: `src/lang/features/completion.rs -> src/lang/features/completion.rs`
- 1-file cycle: `src/lang/features/hover.rs -> src/lang/features/hover.rs`
- 1-file cycle: `src/lang/features/navigation.rs -> src/lang/features/navigation.rs`
- 1-file cycle: `src/lang/features/symbols.rs -> src/lang/features/symbols.rs`
- 1-file cycle: `src/lang/mod.rs -> src/lang/mod.rs`
- 1-file cycle: `src/lang/parser_cache.rs -> src/lang/parser_cache.rs`
- 1-file cycle: `src/lang/symbol_index.rs -> src/lang/symbol_index.rs`
- 1-file cycle: `src/launcher.rs -> src/launcher.rs`
- 1-file cycle: `src/mcp.rs -> src/mcp.rs`
- 1-file cycle: `src/preview_server.rs -> src/preview_server.rs`
- 1-file cycle: `src/pty.rs -> src/pty.rs`

## Communities (33 total, 0 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (97): AtomicU64, AxumState, CallToolResult, Json, McpError, Next, Parameters, Request (+89 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (109): AgentKind, Metadata, ProcessInfo, Snapshot, accept_path_drops_pending_and_advances_baseline(), active_session_with_reported_change(), agent_accept_path(), agent_base_content() (+101 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (48): agent_parent_origin_matches_dev_webview_origin(), agent_script(), auth_set_cookie_header(), copy_until_eof(), handle_conn(), Head, head_insert_index(), host_is_loopback() (+40 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (53): DocCommentStyle, block_doc_before(), byte_for_line(), doc_for(), hover(), leading_line_doc(), python_docstring(), goto_definition() (+45 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (42): MasterPty, AgentState, AgentTerminal, classify_state(), default_shell(), has_permission_prompt(), has_working_prompt(), is_agent() (+34 more)

### Community 5 - "Community 5"
Cohesion: 0.12
Nodes (31): build_fixture_index(), completion_blends_scope_symbols_workspace_symbols_and_keywords(), CompletionItem, DocumentSymbol, goto_prefers_nearest_local_declaration_then_workspace_fallback(), Hover, hover_returns_signature_and_python_docstring(), IndexStats (+23 more)

### Community 6 - "Community 6"
Cohesion: 0.09
Nodes (43): connect_with_retry(), DapEvent, debug_send(), debug_start(), debug_stop(), DebugSession, DebugState, drain_frames() (+35 more)

### Community 7 - "Community 7"
Cohesion: 0.13
Nodes (29): canonicalize_in_root(), ErrorBody, file_url_path(), handle_client(), hex_val(), mime_for(), percent_decode(), percent_encode() (+21 more)

### Community 8 - "Community 8"
Cohesion: 0.12
Nodes (24): completion(), insert_best(), matches_prefix(), score(), IndexStats, build(), fuzzy_score(), index_file() (+16 more)

### Community 9 - "Community 9"
Cohesion: 0.10
Nodes (69): AheadBehindResult, branches_bound_elsewhere(), branches_flag_head(), branches_flag_worktree_bound(), BranchInfo, canon(), canon_maybe_missing(), ChangedFile (+61 more)

### Community 10 - "Community 10"
Cohesion: 0.18
Nodes (30): capture_paths(), atomic_write(), atomic_write_creates_file_with_parents(), atomic_write_leaves_no_temp_files(), atomic_write_overwrites_existing_content(), compact(), compact_does_not_follow_symlinked_directories(), compact_stops_after_depth_limit() (+22 more)

### Community 11 - "Community 11"
Cohesion: 0.14
Nodes (13): Hover, LangEngine, CompletionItem, DocumentSymbol, Location, Option, ParserCache, Pos (+5 more)

### Community 12 - "Community 12"
Cohesion: 0.13
Nodes (20): compile_queries(), ParsedDocument, ParserCache, lang(), language_for_path(), spec(), Language, Parser (+12 more)

### Community 13 - "Community 13"
Cohesion: 0.08
Nodes (23): app, security, withGlobalTauri, build, beforeBuildCommand, beforeDevCommand, devUrl, frontendDist (+15 more)

### Community 14 - "Community 14"
Cohesion: 0.10
Nodes (23): BTreeSet, Event, RecommendedWatcher, debounce_events(), emit_pending(), FsChangedPayload, is_noise_path(), noise() (+15 more)

### Community 15 - "Community 15"
Cohesion: 0.15
Nodes (18): claude_settings_inserts_hook_into_empty(), claude_settings_is_idempotent_and_preserves_other_keys(), claude_settings_preserves_a_pre_existing_different_hook(), codex_toml_inserts_and_preserves(), ensure_gitignore(), gitignore_appends_only_missing(), mcp_json_inserts_sutra_into_empty(), mcp_json_preserves_other_servers() (+10 more)

### Community 16 - "Community 16"
Cohesion: 0.18
Nodes (10): capture(), computedSubset(), currentRoute(), emitRoute(), isStableId(), onClick(), post(), routeKey() (+2 more)

### Community 17 - "Community 17"
Cohesion: 0.21
Nodes (19): AgentAsset, dedup_assets(), dedup_keeps_same_name_different_kind(), dirs_home(), invocation_for(), latest_version_dir(), latest_version_dir_is_numeric_not_lexical(), Option (+11 more)

### Community 18 - "Community 18"
Cohesion: 0.25
Nodes (16): FileListing, list_files(), list_files_caps_at_limit_and_flags_truncation(), list_files_keeps_top_level_file_named_like_skip_dir(), list_files_returns_relative_paths_and_respects_gitignore(), list_files_skips_hidden_and_build_dirs_even_without_gitignore(), list_files_with_cap(), Option (+8 more)

### Community 19 - "Community 19"
Cohesion: 0.28
Nodes (8): DocCommentStyle, Language, LanguageId, LanguageSpec, Option, Send, Sync, TsLanguage

### Community 20 - "Community 20"
Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 22 - "Community 22"
Cohesion: 0.18
Nodes (14): ClaimedRoot, clipboard_write(), first_path_arg(), first_path_arg_canonicalizes_dot(), LaunchPath, AppHandle, Option, Result (+6 more)

### Community 25 - "Community 25"
Cohesion: 0.07
Nodes (93): FailedRestore, Into, append_manifest(), before_captured_once_per_turn(), blob_roundtrip_and_gc(), blob_store(), BlobStore, branch_of() (+85 more)

### Community 26 - "Community 26"
Cohesion: 0.07
Nodes (69): Drop, Error, R, cancel_pending_task_check(), cap_tail(), classify_outcome(), detect(), detect_finds_manifests() (+61 more)

### Community 27 - "Community 27"
Cohesion: 0.14
Nodes (41): canonical_root(), claim_wins_then_second_sees_owned(), ClaimResult, concurrent_claims_exactly_one_wins(), concurrent_reclaim_exactly_one_wins(), data_store_id(), data_store_id_is_deterministic_and_16_bytes(), dirs_app_support() (+33 more)

### Community 28 - "Community 28"
Cohesion: 0.18
Nodes (32): atomic_write_json(), atomic_write_then_read(), read_json(), Recent, recents_list(), recents_path(), recents_push(), Option (+24 more)

### Community 29 - "Community 29"
Cohesion: 0.16
Nodes (25): ExitStatus, admin_command(), admin_command_preserves_literal_forwarded_arguments(), classify(), cli_install(), cli_install_state(), current_bundle_bin(), do_install() (+17 more)

### Community 30 - "Community 30"
Cohesion: 0.15
Nodes (23): AnyClass, AnyObject, CString, F, MainThreadMarker, NSApplication, NSApplicationDelegate, NSMenu (+15 more)

### Community 31 - "Community 31"
Cohesion: 0.21
Nodes (16): child_args(), file_resolves_to_root_plus_file(), file_root(), first_path_arg(), folder_resolves_to_workspace(), LaunchTarget, no_path_is_untitled_unique(), resolve() (+8 more)

### Community 32 - "Community 32"
Cohesion: 0.23
Nodes (11): bind(), Frame, handle(), AppHandle, Option, Result, String, TcpListener (+3 more)

## Knowledge Gaps
- **118 isolated node(s):** `$schema`, `identifier`, `description`, `windows`, `permissions` (+113 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `mcp_write_agent_config()` connect `Community 0` to `Community 10`, `Community 15`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Why does `capture_paths()` connect `Community 10` to `Community 0`, `Community 1`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `with_auth_token()` connect `Community 0` to `Community 2`, `Community 7`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **What connects `$schema`, `identifier`, `description` to the rest of the system?**
  _118 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05125337806355419 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05281058101086443 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07459207459207459 - nodes in this community are weakly interconnected._