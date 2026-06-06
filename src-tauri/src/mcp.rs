//! In-process MCP server exposing Sutra editor control to the integrated-terminal
//! agent. Path/temp helpers plus the rmcp streamable-HTTP server, McpState, and
//! Tauri commands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::routing::post;
use axum::Json;
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    CallToolResult, Content, Implementation, ProtocolVersion, ServerCapabilities, ServerInfo,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::preview_server::PreviewServerState;

/// Resolve `path` (absolute or relative to `root`) and confirm it stays inside
/// `root`. Returns the canonical path or an error string.
pub fn resolve_in_root(root: &Path, path: &str) -> Result<PathBuf, String> {
    let candidate = {
        let p = Path::new(path);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    };
    let canon = std::fs::canonicalize(&candidate).map_err(|e| format!("{path}: {e}"))?;
    let root_canon = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    if !canon.starts_with(&root_canon) {
        return Err("path escapes workspace root".to_string());
    }
    Ok(canon)
}

/// Directory for ephemeral agent-rendered HTML, under the workspace root so the
/// preview server can serve it.
pub fn preview_dir(root: &Path) -> PathBuf {
    root.join(".sutra").join("preview")
}

/// Write `html` to a uniquely named file in the preview dir and prune to the
/// newest `keep` files. Returns the written path.
pub fn write_preview_html(root: &Path, html: &str, keep: usize) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = preview_dir(root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let file = dir.join(format!("{nanos:032}-{seq}.html"));
    std::fs::write(&file, html).map_err(|e| e.to_string())?;
    prune_dir(&dir, keep);
    Ok(file)
}

/// Keep only the newest `keep` files in `dir` (by name; names are nanos-prefixed
/// so lexical == chronological). Best-effort; errors are ignored.
fn prune_dir(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    if files.len() > keep {
        for old in &files[..files.len() - keep] {
            let _ = std::fs::remove_file(old);
        }
    }
}

// ---- MCP server state and tools ----

/// Shared, Tauri-managed MCP state: bound port, workspace root, and UI replies.
#[derive(Default)]
pub struct McpState {
    pub port: Mutex<Option<u16>>,
    pub root: Arc<Mutex<Option<PathBuf>>>,
    pub pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    pub next_id: Arc<AtomicU64>,
}

/// Shared context for the loopback edit-ingest route.
#[derive(Clone)]
struct IngestCtx {
    app: AppHandle,
    root: Arc<Mutex<Option<PathBuf>>>,
}

/// Body of `POST /ingest/edit`.
#[derive(serde::Deserialize)]
struct IngestBody {
    path: String,
}

/// Record an agent-reported edit. Validates the path stays inside the active
/// workspace root (`resolve_in_root`); otherwise rejects. Loopback-only,
/// best-effort.
async fn ingest_edit(
    AxumState(ctx): AxumState<IngestCtx>,
    Json(body): Json<IngestBody>,
) -> StatusCode {
    let Some(root) = ctx.root.lock().ok().and_then(|guard| guard.clone()) else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let Ok(path) = resolve_in_root(&root, &body.path) else {
        return StatusCode::BAD_REQUEST;
    };
    let app = ctx.app.clone();
    let _ = tokio::task::spawn_blocking(move || {
        app.state::<crate::agent_tracker::AgentTrackerState>()
            .record_agent_report(&root, path);
    })
    .await;
    StatusCode::NO_CONTENT
}

/// Write the live ingest base URL to `<root>/.sutra/endpoint` for hook scripts.
/// Note: callers pass the workspace root exactly as the frontend supplied it, so
/// the file matches the root the tracker keys its baseline on.
fn write_endpoint_file(root: &Path, port: u16) -> Result<(), String> {
    let dir = root.join(".sutra");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("endpoint"), format!("http://127.0.0.1:{port}"))
        .map_err(|e| e.to_string())
}

/// POSIX-sh hook body: reads Claude PostToolUse JSON on stdin, extracts the
/// edited file path with node, and reports it to Sutra's ingest endpoint.
const REPORT_EDIT_SH: &str = r#"#!/bin/sh
# Sutra agent-edit reporter. Best-effort; never blocks the agent.
endpoint_file="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/../endpoint"
[ -f "$endpoint_file" ] || exit 0
path="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).tool_input||{}).file_path||"")}catch(e){}})')"
[ -n "$path" ] || exit 0
body="$(node -e 'process.stdout.write(JSON.stringify({path:process.argv[1]}))' "$path")"
curl -s -m 1 "$(cat "$endpoint_file")/ingest/edit" -H 'content-type: application/json' --data-raw "$body" >/dev/null 2>&1 || true
"#;

fn hook_script_path(root: &Path) -> PathBuf {
    root.join(".sutra").join("hooks").join("report-edit.sh")
}

fn shell_quote_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    format!("'{}'", text.replace('\'', r#"'\''"#))
}

/// Write the report hook script to `<root>/.sutra/hooks/report-edit.sh`,
/// executable. Returns its absolute path.
fn write_hook_script(root: &Path) -> Result<PathBuf, String> {
    let script = hook_script_path(root);
    let dir = script
        .parent()
        .ok_or_else(|| "invalid hook script path".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&script, REPORT_EDIT_SH).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(script)
}

/// Discriminated payload emitted to the frontend preview listener.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewOpen {
    kind: &'static str,     // "html" | "md" | "diagram"
    url: Option<String>,    // file-backed kinds
    source: Option<String>, // inline kinds (md, diagram)
}

/// Discriminated drive command emitted to the frontend.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DriveCmd {
    action: &'static str, // "openFile" | "revealTree" | "showDiff" | "openTerminal"
    path: Option<String>,
    line: Option<u32>,
    cwd: Option<String>,
}

// ---- tool argument structs ----

/// Args for render_html tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RenderHtmlArgs {
    /// Self-contained HTML to render. Scripts run in an isolated localhost iframe.
    html: String,
}

/// Args for render_markdown tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RenderMarkdownArgs {
    /// Markdown source; rendered sanitized.
    md: String,
}

/// Args for render_diagram tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct RenderDiagramArgs {
    /// Mermaid diagram source.
    mermaid: String,
}

/// Args for open_preview tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct OpenPreviewArgs {
    /// Path (absolute or relative to the workspace root) to an .html/.md file.
    path: String,
}

/// Args for open_file tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct OpenFileArgs {
    /// Workspace file path (absolute or relative to root).
    path: String,
    /// Optional 1-based line to scroll to.
    line: Option<u32>,
}

/// Args for tools that take one workspace path.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct PathArg {
    /// Workspace file path (absolute or relative to root).
    path: String,
}

/// Args for open_terminal tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct OpenTerminalArgs {
    /// Optional working directory for the new terminal.
    cwd: Option<String>,
}

/// Args for search tool.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SearchArgs {
    /// Text to search for.
    query: String,
    /// Case-insensitive search (default true).
    case_insensitive: Option<bool>,
}

/// The MCP tool server. Clonable so the streamable-http factory can mint one per
/// session; all clones share the same `AppHandle` and active-root `Arc`.
#[derive(Clone)]
pub struct SutraMcp {
    app: AppHandle,
    root: Arc<Mutex<Option<PathBuf>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: Arc<AtomicU64>,
    tool_router: ToolRouter<SutraMcp>,
}

#[tool_router]
impl SutraMcp {
    /// Construct a new SutraMcp instance with the given app handle and workspace root.
    pub fn new(
        app: AppHandle,
        root: Arc<Mutex<Option<PathBuf>>>,
        pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
        next_id: Arc<AtomicU64>,
    ) -> Self {
        Self {
            app,
            root,
            pending,
            next_id,
            tool_router: Self::tool_router(),
        }
    }

    /// Current active workspace root or a tool error.
    fn active_root(&self) -> Result<PathBuf, McpError> {
        self.root
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| McpError::invalid_request("no workspace open in Sutra", None))
    }

    /// Emit a preview-open event to the Tauri frontend.
    fn emit_preview(&self, payload: PreviewOpen) {
        let _ = self.app.emit("sutra://preview/open", payload);
    }

    /// Emit a drive event to the Tauri frontend.
    fn emit_drive(&self, payload: DriveCmd) {
        let _ = self.app.emit("sutra://drive", payload);
    }

    /// Build a preview success CallToolResult with a JSON body.
    fn ok_preview(kind: &str, url: Option<String>) -> CallToolResult {
        let body = match &url {
            Some(u) => format!("{{\"opened\":true,\"kind\":\"{kind}\",\"url\":\"{u}\"}}"),
            None => format!("{{\"opened\":true,\"kind\":\"{kind}\"}}"),
        };
        CallToolResult::success(vec![Content::text(body)])
    }

    /// Build a drive success CallToolResult.
    fn ok_drive() -> CallToolResult {
        CallToolResult::success(vec![Content::text("{\"ok\":true}".to_string())])
    }

    /// Build a success CallToolResult from a JSON value.
    fn ok_json(value: serde_json::Value) -> CallToolResult {
        CallToolResult::success(vec![Content::text(value.to_string())])
    }

    /// Emit a UI-state request and await the frontend reply with a 2s timeout.
    async fn request_ui(&self, query: &str) -> Result<serde_json::Value, McpError> {
        let (tx, rx) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.pending
            .lock()
            .map_err(|e| McpError::internal_error(e.to_string(), None))?
            .insert(id, tx);
        let _ = self.app.emit(
            "sutra://ui/request",
            serde_json::json!({ "id": id, "query": query }),
        );
        match tokio::time::timeout(std::time::Duration::from_secs(2), rx).await {
            Ok(Ok(value)) => Ok(value),
            _ => {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                Err(McpError::internal_error("ui state request timed out", None))
            }
        }
    }

    #[tool(
        description = "Render a self-contained HTML string in Sutra's preview pane. Scripts execute in an isolated localhost iframe."
    )]
    fn render_html(
        &self,
        Parameters(args): Parameters<RenderHtmlArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let file = write_preview_html(&root, &args.html, 10)
            .map_err(|e| McpError::internal_error(e, None))?;
        let url = self
            .app
            .state::<PreviewServerState>()
            .url_for(&root, &file)
            .map_err(|e| McpError::internal_error(e, None))?;
        self.emit_preview(PreviewOpen {
            kind: "html",
            url: Some(url.clone()),
            source: None,
        });
        Ok(Self::ok_preview("html", Some(url)))
    }

    #[tool(description = "Render Markdown (sanitized) in Sutra's preview pane.")]
    fn render_markdown(
        &self,
        Parameters(args): Parameters<RenderMarkdownArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.active_root()?;
        self.emit_preview(PreviewOpen {
            kind: "md",
            url: None,
            source: Some(args.md),
        });
        Ok(Self::ok_preview("md", None))
    }

    #[tool(description = "Render a Mermaid diagram in Sutra's preview pane.")]
    fn render_diagram(
        &self,
        Parameters(args): Parameters<RenderDiagramArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.active_root()?;
        self.emit_preview(PreviewOpen {
            kind: "diagram",
            url: None,
            source: Some(args.mermaid),
        });
        Ok(Self::ok_preview("diagram", None))
    }

    #[tool(description = "Open an existing workspace .html or .md file in Sutra's preview pane.")]
    fn open_preview(
        &self,
        Parameters(args): Parameters<OpenPreviewArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let file =
            resolve_in_root(&root, &args.path).map_err(|e| McpError::invalid_request(e, None))?;
        let ext = file
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        match ext.as_str() {
            "html" | "htm" => {
                let url = self
                    .app
                    .state::<PreviewServerState>()
                    .url_for(&root, &file)
                    .map_err(|e| McpError::internal_error(e, None))?;
                self.emit_preview(PreviewOpen {
                    kind: "html",
                    url: Some(url.clone()),
                    source: None,
                });
                Ok(Self::ok_preview("html", Some(url)))
            }
            "md" | "markdown" => {
                let text = std::fs::read_to_string(&file)
                    .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                self.emit_preview(PreviewOpen {
                    kind: "md",
                    url: None,
                    source: Some(text),
                });
                Ok(Self::ok_preview("md", None))
            }
            _ => Err(McpError::invalid_request(
                "only .html/.htm/.md/.markdown can be previewed",
                None,
            )),
        }
    }

    #[tool(
        description = "Open a workspace file in Sutra's editor, optionally scrolling to a 1-based line."
    )]
    fn open_file(
        &self,
        Parameters(args): Parameters<OpenFileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let file =
            resolve_in_root(&root, &args.path).map_err(|e| McpError::invalid_request(e, None))?;
        self.emit_drive(DriveCmd {
            action: "openFile",
            path: Some(file.to_string_lossy().into_owned()),
            line: args.line,
            cwd: None,
        });
        Ok(Self::ok_drive())
    }

    #[tool(description = "Expand Sutra's file tree to a path and highlight it.")]
    fn reveal_in_tree(
        &self,
        Parameters(args): Parameters<PathArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let file =
            resolve_in_root(&root, &args.path).map_err(|e| McpError::invalid_request(e, None))?;
        self.emit_drive(DriveCmd {
            action: "revealTree",
            path: Some(file.to_string_lossy().into_owned()),
            line: None,
            cwd: None,
        });
        Ok(Self::ok_drive())
    }

    #[tool(description = "Open a file in the editor and jump to its first changed git hunk.")]
    fn show_diff(&self, Parameters(args): Parameters<PathArg>) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let file =
            resolve_in_root(&root, &args.path).map_err(|e| McpError::invalid_request(e, None))?;
        self.emit_drive(DriveCmd {
            action: "showDiff",
            path: Some(file.to_string_lossy().into_owned()),
            line: None,
            cwd: None,
        });
        Ok(Self::ok_drive())
    }

    #[tool(description = "Open a new integrated terminal, optionally at a working directory.")]
    fn open_terminal(
        &self,
        Parameters(args): Parameters<OpenTerminalArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.active_root()?;
        self.emit_drive(DriveCmd {
            action: "openTerminal",
            path: None,
            line: None,
            cwd: args.cwd,
        });
        Ok(Self::ok_drive())
    }

    #[tool(description = "Get the workspace git status: branch, ahead/behind, and changed files.")]
    fn get_git_status(&self) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let root_s = root.to_string_lossy().into_owned();
        let branch = crate::git::git_branch(root_s.clone()).unwrap_or(None);
        let ab = crate::git::git_ahead_behind(root_s.clone()).unwrap_or(None);
        let files = crate::git::git_changed_files(root_s).unwrap_or_default();
        Ok(Self::ok_json(serde_json::json!({
            "branch": branch,
            "ahead": ab.as_ref().map(|a| a.ahead),
            "behind": ab.as_ref().map(|a| a.behind),
            "files": files,
        })))
    }

    #[tool(description = "Get Sutra's AI-vs-human tracked changes for the workspace.")]
    fn get_tracked_changes(&self) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let status = crate::agent_tracker::agent_tracking_poll(
            self.app.state::<crate::agent_tracker::AgentTrackerState>(),
            root.to_string_lossy().into_owned(),
        )
        .map_err(|e| McpError::internal_error(e, None))?;
        let body = serde_json::to_value(&status)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(Self::ok_json(body))
    }

    #[tool(description = "Search the workspace for a text pattern.")]
    fn search(&self, Parameters(args): Parameters<SearchArgs>) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let result = crate::search::search_dir(
            root.to_string_lossy().into_owned(),
            args.query,
            args.case_insensitive.unwrap_or(true),
        )
        .map_err(|e| McpError::internal_error(e, None))?;
        let body = serde_json::to_value(&result)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(Self::ok_json(body))
    }

    #[tool(description = "Get the editor's currently open tabs: path, name, active, dirty.")]
    async fn get_open_tabs(&self) -> Result<CallToolResult, McpError> {
        self.active_root()?;
        let value = self.request_ui("openTabs").await?;
        Ok(Self::ok_json(value))
    }

    #[tool(
        description = "Get the current editor selection: file path, selected text, and 1-based line."
    )]
    async fn get_selection(&self) -> Result<CallToolResult, McpError> {
        self.active_root()?;
        let value = self.request_ui("selection").await?;
        Ok(Self::ok_json(value))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for SutraMcp {
    /// Return server capabilities and metadata for MCP initialization.
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::from_build_env())
            .with_protocol_version(ProtocolVersion::V_2024_11_05)
            .with_instructions(
                "Sutra editor control plane. Tools render preview content, drive the editor/tree/terminal, \
                 and read live workspace/editor state."
                    .to_string(),
            )
    }
}

/// Bind the MCP server on an ephemeral port and serve it on a dedicated thread.
/// Returns the bound port. Mirrors `preview_server`'s threaded model.
pub fn start(
    app: AppHandle,
    root: Arc<Mutex<Option<PathBuf>>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    next_id: Arc<AtomicU64>,
) -> Result<u16, String> {
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();
    std_listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;

    std::thread::Builder::new()
        .name("sutra-mcp-server".to_string())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(_) => return,
            };
            rt.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(std_listener) {
                    Ok(l) => l,
                    Err(_) => return,
                };
                let ingest_ctx = IngestCtx {
                    app: app.clone(),
                    root: root.clone(),
                };
                let template = SutraMcp::new(app, root, pending, next_id);
                let service: StreamableHttpService<SutraMcp, LocalSessionManager> =
                    StreamableHttpService::new(
                        move || Ok(template.clone()),
                        Default::default(),
                        StreamableHttpServerConfig::default(),
                    );
                let router = axum::Router::new()
                    .nest_service("/mcp", service)
                    .route("/ingest/edit", post(ingest_edit))
                    .with_state(ingest_ctx);
                let _ = axum::serve(listener, router).await;
            });
        })
        .map_err(|e| e.to_string())?;
    Ok(port)
}

// ---- Tauri commands ----

/// Return the live MCP server URL (`http://127.0.0.1:PORT/mcp`).
#[tauri::command]
pub fn mcp_server_url(state: tauri::State<McpState>) -> Result<String, String> {
    let port = state
        .port
        .lock()
        .map_err(|e| e.to_string())?
        .ok_or("mcp server not started")?;
    Ok(format!("http://127.0.0.1:{port}/mcp"))
}

/// Set the active workspace root the MCP tools target.
#[tauri::command]
pub fn mcp_set_root(state: tauri::State<McpState>, root: String) -> Result<(), String> {
    let root_path = PathBuf::from(&root);
    *state.root.lock().map_err(|e| e.to_string())? = Some(root_path.clone());
    if let Some(port) = *state.port.lock().map_err(|e| e.to_string())? {
        let _ = write_endpoint_file(&root_path, port);
    }
    Ok(())
}

/// Merge-write the `sutra` server into `<root>/.mcp.json` and
/// `<root>/.codex/config.toml`, and ensure gitignore entries. Best-effort:
/// a malformed existing file is skipped (never clobbered) and reported.
#[tauri::command]
pub fn mcp_write_agent_config(
    state: tauri::State<McpState>,
    tracker: tauri::State<crate::agent_tracker::AgentTrackerState>,
    root: String,
) -> Result<Vec<String>, String> {
    use crate::agent_tracker::capture_paths;
    use crate::mcp_config::{
        ensure_gitignore, merge_claude_settings, merge_codex_toml, merge_mcp_json,
    };
    let port = state
        .port
        .lock()
        .map_err(|e| e.to_string())?
        .ok_or("mcp server not started")?;
    let url = format!("http://127.0.0.1:{port}/mcp");
    let root = PathBuf::from(root);
    let mut warnings = Vec::new();

    let mcp_path = root.join(".mcp.json");
    let codex_path = root.join(".codex").join("config.toml");
    let gi_path = root.join(".gitignore");
    let claude_path = root.join(".claude").join("settings.json");
    let hook_path = hook_script_path(&root);

    let tracked = vec![
        hook_path.clone(),
        mcp_path.clone(),
        codex_path.clone(),
        gi_path.clone(),
        claude_path.clone(),
    ];
    let before = capture_paths(&tracked);

    let result = (|| {
        let hook_script = match write_hook_script(&root) {
            Ok(path) => Some(path),
            Err(e) => {
                warnings.push(format!("hook script skipped: {e}"));
                None
            }
        };

        // claude .mcp.json
        match merge_mcp_json(std::fs::read_to_string(&mcp_path).ok().as_deref(), &url) {
            Ok(out) => std::fs::write(&mcp_path, out).map_err(|e| e.to_string())?,
            Err(e) => warnings.push(format!(".mcp.json skipped: {e}")),
        }

        // codex .codex/config.toml
        match merge_codex_toml(std::fs::read_to_string(&codex_path).ok().as_deref(), &url) {
            Ok(out) => {
                if let Some(parent) = codex_path.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::write(&codex_path, out).map_err(|e| e.to_string())?;
            }
            Err(e) => warnings.push(format!("config.toml skipped: {e}")),
        }

        // claude .claude/settings.json PostToolUse hook
        if let Some(script) = &hook_script {
            let command = shell_quote_path(script);
            match merge_claude_settings(
                std::fs::read_to_string(&claude_path).ok().as_deref(),
                &command,
            ) {
                Ok(out) => {
                    if let Some(parent) = claude_path.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    std::fs::write(&claude_path, out).map_err(|e| e.to_string())?;
                }
                Err(e) => warnings.push(format!("settings.json skipped: {e}")),
            }
        }

        // .gitignore
        if let Some(out) = ensure_gitignore(
            std::fs::read_to_string(&gi_path).ok().as_deref(),
            &[".mcp.json", ".codex/", ".sutra/", ".claude/"],
        ) {
            std::fs::write(&gi_path, out).map_err(|e| e.to_string())?;
        }

        Ok(warnings)
    })();

    tracker.record_sutra_mutation(before, &tracked);
    result
}

/// Core UI-reply delivery used by the Tauri command and unit tests.
fn deliver_ui_reply(state: &McpState, id: u64, payload: serde_json::Value) -> Result<(), String> {
    if let Some(tx) = state.pending.lock().map_err(|e| e.to_string())?.remove(&id) {
        let _ = tx.send(payload);
    }
    Ok(())
}

/// Frontend delivers a requested UI-state snapshot, resolving the pending tool call.
#[tauri::command]
pub fn mcp_ui_reply(
    state: tauri::State<McpState>,
    id: u64,
    payload: serde_json::Value,
) -> Result<(), String> {
    deliver_ui_reply(&state, id, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn resolve_accepts_path_inside_root() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.html"), "x").unwrap();
        let got = resolve_in_root(dir.path(), "a.html").unwrap();
        assert!(got.ends_with("a.html"));
    }

    #[test]
    fn resolve_rejects_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "x").unwrap();
        let p = outside.path().join("secret");
        assert!(resolve_in_root(dir.path(), p.to_str().unwrap()).is_err());
    }

    #[test]
    fn write_preview_prunes_to_keep() {
        let dir = tempdir().unwrap();
        for _ in 0..15 {
            write_preview_html(dir.path(), "<p>x</p>", 10).unwrap();
        }
        let count = std::fs::read_dir(preview_dir(dir.path())).unwrap().count();
        assert_eq!(count, 10);
    }

    #[test]
    fn endpoint_file_written_with_url() {
        let dir = tempdir().unwrap();
        write_endpoint_file(dir.path(), 5123).unwrap();
        let got = std::fs::read_to_string(dir.path().join(".sutra").join("endpoint")).unwrap();
        assert_eq!(got, "http://127.0.0.1:5123");
    }

    #[test]
    fn hook_script_written_executable_and_nonempty() {
        let dir = tempdir().unwrap();
        let script = write_hook_script(dir.path()).unwrap();
        assert!(script.ends_with("report-edit.sh"));
        let body = std::fs::read_to_string(&script).unwrap();
        assert!(body.contains("/ingest/edit"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&script).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0);
        }
    }

    #[test]
    fn hook_command_path_is_shell_quoted() {
        let command = shell_quote_path(Path::new("/tmp/sutra test/it's/report-edit.sh"));
        assert_eq!(command, r#"'/tmp/sutra test/it'\''s/report-edit.sh'"#);
    }

    #[test]
    fn mcp_ui_reply_delivers_and_removes_pending_reply() {
        let state = McpState::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        state.pending.lock().unwrap().insert(7, tx);

        deliver_ui_reply(&state, 7, serde_json::json!({ "tabs": [] })).unwrap();

        assert!(state.pending.lock().unwrap().is_empty());
        let mut rx = rx;
        assert_eq!(rx.try_recv().unwrap()["tabs"].as_array().unwrap().len(), 0);
    }
}
