// Git status bar: branch, ahead/behind count, worktree switcher dropdown.
import { gitBranch, gitAheadBehind, gitWorktrees, type WorktreeInfo } from "./ipc";

export interface GitBarHandle {
  refresh(root: string): Promise<void>;
  onWorktreeSelect?: (path: string) => void;
}

export function createGitBar(container: HTMLElement): GitBarHandle {
  // Render the git bar UI (branch chip + dropdown).
  function render(branch: string | null, ahead: number | null, behind: number | null, worktrees: WorktreeInfo[]): void {
    container.innerHTML = "";
    if (!branch) return; // No git repo or detached head.

    const chip = document.createElement("div");
    chip.className = "gitbar-chip";
    // Git branch icon (inline SVG)
    const icon = document.createElement("span");
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 0-9 9"/></svg>';
    chip.appendChild(icon);
    chip.appendChild(document.createTextNode(` ${branch}`));

    if (ahead !== null || behind !== null) {
      const aheadCount = ahead ?? 0;
      const behindCount = behind ?? 0;
      if (aheadCount > 0 || behindCount > 0) {
        const counts = document.createElement("span");
        counts.className = "gitbar-counts";
        if (aheadCount > 0) counts.appendChild(document.createTextNode(`↑${aheadCount}`));
        if (behindCount > 0) {
          if (aheadCount > 0) counts.appendChild(document.createTextNode(" "));
          counts.appendChild(document.createTextNode(`↓${behindCount}`));
        }
        chip.appendChild(counts);
      }
    }

    let dropdown: HTMLElement | null = null;

    function closeDropdown(): void {
      if (dropdown) {
        dropdown.remove();
        dropdown = null;
      }
    }

    function openDropdown(): void {
      closeDropdown();
      dropdown = document.createElement("div");
      dropdown.className = "gitbar-dropdown";
      for (const wt of worktrees) {
        const row = document.createElement("div");
        row.className = "gitbar-worktree";
        if (wt.is_current) row.classList.add("current");
        row.textContent = wt.name;
        row.onclick = () => {
          handle.onWorktreeSelect?.(wt.path);
          closeDropdown();
        };
        dropdown.appendChild(row);
      }
      document.body.appendChild(dropdown);

      // Position dropdown below chip
      const rect = chip.getBoundingClientRect();
      dropdown.style.position = "fixed";
      dropdown.style.top = `${rect.bottom + 4}px`;
      dropdown.style.left = `${rect.left}px`;

      // Close on outside click
      const closer = (e: MouseEvent) => {
        if (e.target !== chip && !dropdown!.contains(e.target as Node)) {
          closeDropdown();
          document.removeEventListener("click", closer);
        }
      };
      setTimeout(() => document.addEventListener("click", closer), 0);
    }

    chip.onclick = (e) => {
      e.stopPropagation();
      if (dropdown) closeDropdown();
      else if (worktrees.length > 0) openDropdown();
    };

    container.appendChild(chip);
  }

  const handle: GitBarHandle = {
    async refresh(root: string): Promise<void> {
      try {
        const branch = await gitBranch(root);
        const aheadBehind = await gitAheadBehind(root);
        const worktrees = await gitWorktrees(root);
        render(
          branch,
          aheadBehind?.ahead ?? null,
          aheadBehind?.behind ?? null,
          worktrees,
        );
      } catch (e) {
        render(null, null, null, []);
      }
    },
  };

  return handle;
}
