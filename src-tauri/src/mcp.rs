//! In-process MCP server exposing Sutra's preview pane to the integrated-terminal
//! agent. Path/temp helpers plus the rmcp streamable-HTTP server (4 tools),
//! McpState, and three Tauri commands.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
    let Ok(entries) = std::fs::read_dir(dir) else { return };
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

/// Shared, Tauri-managed MCP state: the bound port and the active workspace root.
#[derive(Default)]
pub struct McpState {
    pub port: Mutex<Option<u16>>,
    pub root: Arc<Mutex<Option<PathBuf>>>,
}

/// Discriminated payload emitted to the frontend preview listener.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewOpen {
    kind: &'static str,     // "html" | "md" | "diagram"
    url: Option<String>,    // file-backed kinds
    source: Option<String>, // inline kinds (md, diagram)
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

/// The MCP tool server. Clonable so the streamable-http factory can mint one per
/// session; all clones share the same `AppHandle` and active-root `Arc`.
#[derive(Clone)]
pub struct SutraMcp {
    app: AppHandle,
    root: Arc<Mutex<Option<PathBuf>>>,
    tool_router: ToolRouter<SutraMcp>,
}

#[tool_router]
impl SutraMcp {
    /// Construct a new SutraMcp instance with the given app handle and workspace root.
    pub fn new(app: AppHandle, root: Arc<Mutex<Option<PathBuf>>>) -> Self {
        Self { app, root, tool_router: Self::tool_router() }
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

    /// Build a success CallToolResult with a JSON body.
    fn ok(kind: &str, url: Option<String>) -> CallToolResult {
        let body = match &url {
            Some(u) => format!("{{\"opened\":true,\"kind\":\"{kind}\",\"url\":\"{u}\"}}"),
            None => format!("{{\"opened\":true,\"kind\":\"{kind}\"}}"),
        };
        CallToolResult::success(vec![Content::text(body)])
    }

    #[tool(description = "Render a self-contained HTML string in Sutra's preview pane. Scripts execute in an isolated localhost iframe.")]
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
        self.emit_preview(PreviewOpen { kind: "html", url: Some(url.clone()), source: None });
        Ok(Self::ok("html", Some(url)))
    }

    #[tool(description = "Render Markdown (sanitized) in Sutra's preview pane.")]
    fn render_markdown(
        &self,
        Parameters(args): Parameters<RenderMarkdownArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.active_root()?;
        self.emit_preview(PreviewOpen { kind: "md", url: None, source: Some(args.md) });
        Ok(Self::ok("md", None))
    }

    #[tool(description = "Render a Mermaid diagram in Sutra's preview pane.")]
    fn render_diagram(
        &self,
        Parameters(args): Parameters<RenderDiagramArgs>,
    ) -> Result<CallToolResult, McpError> {
        self.active_root()?;
        self.emit_preview(PreviewOpen { kind: "diagram", url: None, source: Some(args.mermaid) });
        Ok(Self::ok("diagram", None))
    }

    #[tool(description = "Open an existing workspace .html or .md file in Sutra's preview pane.")]
    fn open_preview(
        &self,
        Parameters(args): Parameters<OpenPreviewArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = self.active_root()?;
        let file = resolve_in_root(&root, &args.path)
            .map_err(|e| McpError::invalid_request(e, None))?;
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
                Ok(Self::ok("html", Some(url)))
            }
            "md" | "markdown" => {
                let text = std::fs::read_to_string(&file)
                    .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                self.emit_preview(PreviewOpen { kind: "md", url: None, source: Some(text) });
                Ok(Self::ok("md", None))
            }
            _ => Err(McpError::invalid_request(
                "only .html/.htm/.md/.markdown can be previewed",
                None,
            )),
        }
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
                "Sutra editor control plane. Tools render content into Sutra's preview pane: \
                 render_html, render_markdown, render_diagram, open_preview."
                    .to_string(),
            )
    }
}

/// Bind the MCP server on an ephemeral port and serve it on a dedicated thread.
/// Returns the bound port. Mirrors `preview_server`'s threaded model.
pub fn start(app: AppHandle, root: Arc<Mutex<Option<PathBuf>>>) -> Result<u16, String> {
    let std_listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();
    std_listener.set_nonblocking(true).map_err(|e| e.to_string())?;

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
                let template = SutraMcp::new(app, root);
                let service: StreamableHttpService<SutraMcp, LocalSessionManager> =
                    StreamableHttpService::new(
                        move || Ok(template.clone()),
                        Default::default(),
                        StreamableHttpServerConfig::default(),
                    );
                let router = axum::Router::new().nest_service("/mcp", service);
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
    *state.root.lock().map_err(|e| e.to_string())? = Some(PathBuf::from(root));
    Ok(())
}

/// Merge-write the `sutra` server into `<root>/.mcp.json` and
/// `<root>/.codex/config.toml`, and ensure gitignore entries. Best-effort:
/// a malformed existing file is skipped (never clobbered) and reported.
#[tauri::command]
pub fn mcp_write_agent_config(
    state: tauri::State<McpState>,
    root: String,
) -> Result<Vec<String>, String> {
    use crate::mcp_config::{ensure_gitignore, merge_codex_toml, merge_mcp_json};
    let port = state
        .port
        .lock()
        .map_err(|e| e.to_string())?
        .ok_or("mcp server not started")?;
    let url = format!("http://127.0.0.1:{port}/mcp");
    let root = PathBuf::from(root);
    let mut warnings = Vec::new();

    // claude .mcp.json
    let mcp_path = root.join(".mcp.json");
    let existing = std::fs::read_to_string(&mcp_path).ok();
    match merge_mcp_json(existing.as_deref(), &url) {
        Ok(out) => std::fs::write(&mcp_path, out).map_err(|e| e.to_string())?,
        Err(e) => warnings.push(format!(".mcp.json skipped: {e}")),
    }

    // codex .codex/config.toml
    let codex_dir = root.join(".codex");
    let codex_path = codex_dir.join("config.toml");
    let existing = std::fs::read_to_string(&codex_path).ok();
    match merge_codex_toml(existing.as_deref(), &url) {
        Ok(out) => {
            std::fs::create_dir_all(&codex_dir).map_err(|e| e.to_string())?;
            std::fs::write(&codex_path, out).map_err(|e| e.to_string())?;
        }
        Err(e) => warnings.push(format!("config.toml skipped: {e}")),
    }

    // .gitignore
    let gi_path = root.join(".gitignore");
    let existing = std::fs::read_to_string(&gi_path).ok();
    if let Some(out) =
        ensure_gitignore(existing.as_deref(), &[".mcp.json", ".codex/", ".sutra/"])
    {
        std::fs::write(&gi_path, out).map_err(|e| e.to_string())?;
    }
    Ok(warnings)
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
}
