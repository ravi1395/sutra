// updater.ts — self-update controller.
// Responsibility: poll the GitHub release endpoint every 6h via
// tauri-plugin-updater, surface an "Update" pill beside the command palette
// when a newer signed release exists, and on click download + install the
// bundle then relaunch. Owns only the update button in the titlebar; all
// plugin access goes through ipc.ts. No-ops cleanly in a plain browser
// (non-Tauri) context so `npm run dev` of the web bundle never throws.
import { checkForUpdate, installUpdate, relaunchApp, type Update } from "./ipc";
import { icon } from "./icons";

// Re-check cadence: every 6 hours, plus one check shortly after boot.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 8_000;

// Clamp a download fraction to a 0–100 integer percentage. Returns null when
// the total content length is unknown (indeterminate progress).
export function progressPercent(received: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((received / total) * 100)));
}

export interface UpdaterOptions {
  // Surface a fatal install/relaunch error to the user (e.g. a native alert).
  onError?: (message: string) => void;
}

// Wire the controller to its titlebar button and start the poll loop.
export function mountUpdater(button: HTMLButtonElement, opts: UpdaterOptions = {}): void {
  let pending: Update | null = null; // resolved-but-not-yet-installed update
  let busy = false; // guards against re-entrant clicks/checks during install

  // Paint the pill for a known release version and reveal it.
  function showAvailable(version: string): void {
    button.innerHTML = `${icon("download", 14)}<span class="upd-label">Update</span>`;
    button.title = `Update to v${version} — click to install and relaunch`;
    button.disabled = false;
    button.classList.remove("hidden");
  }

  // Reflect download progress (or an indeterminate "Updating…") on the pill.
  function showProgress(percent: number | null): void {
    const text = percent === null ? "Updating…" : `Updating… ${percent}%`;
    button.innerHTML = `${icon("download", 14)}<span class="upd-label">${text}</span>`;
    button.disabled = true;
  }

  // Ask the endpoint whether a newer signed release exists. Check failures
  // (offline, rate-limited) are swallowed — the next cycle retries.
  async function check(): Promise<void> {
    if (busy) return;
    try {
      const update = await checkForUpdate();
      if (update) {
        pending = update;
        showAvailable(update.version);
      }
    } catch (err) {
      console.warn("[updater] check failed:", err);
    }
  }

  // Download + install the pending update with live progress, then relaunch.
  async function runInstall(): Promise<void> {
    if (!pending || busy) return;
    busy = true;
    let total = 0;
    let received = 0;
    try {
      showProgress(null);
      await installUpdate(pending, (event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            received = 0;
            break;
          case "Progress":
            received += event.data.chunkLength;
            showProgress(progressPercent(received, total));
            break;
          case "Finished":
            showProgress(100);
            break;
        }
      });
      // Install succeeded — restart into the new version.
      await relaunchApp();
    } catch (err) {
      busy = false;
      const msg = err instanceof Error ? err.message : String(err);
      opts.onError?.(`Update failed: ${msg}`);
      // Leave the pill clickable so the user can retry.
      if (pending) showAvailable(pending.version);
    }
  }

  button.onclick = () => void runInstall();

  // Defer the first check so it doesn't compete with boot, then poll on cadence.
  window.setTimeout(() => void check(), INITIAL_DELAY_MS);
  window.setInterval(() => void check(), CHECK_INTERVAL_MS);
}
