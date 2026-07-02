// Git status bar: renders a branch whisper button + .menu-card dropdown.
// The trigger is injected into the container element (#branch-whisper).
import {
  gitBranch,
  gitAheadBehind,
  gitWorktrees,
  gitBranches,
  type WorktreeInfo,
  type BranchInfo,
} from "./ipc";
import { icon } from "./icons";

export interface GitBarHandle {
  refresh(root: string): Promise<void>;
  onWorktreeSelect?: (path: string) => void;
  onBranchSelect?: (branch: string) => void;
}

// Best-effort ~ collapse for display paths.
function homeCollapse(path: string): string {
  const m = path.match(/^\/Users\/[^/]+(\/.*)?$/);
  return m ? `~${m[1] ?? ""}` : path;
}

export function createGitBar(container: HTMLElement): GitBarHandle {
  let dropdown: HTMLElement | null = null;
  let dropdownOpen = false;

  function closeDropdown(): void {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
    dropdownOpen = false;
    container.classList.remove("open");
    document.removeEventListener("mousedown", onOutside);
    document.removeEventListener("keydown", onKey);
  }

  function onOutside(e: MouseEvent): void {
    const t = e.target as Node;
    if (dropdown && !dropdown.contains(t) && !container.contains(t)) closeDropdown();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") closeDropdown();
  }

  function render(
    branch: string | null,
    ahead: number | null,
    behind: number | null,
    worktrees: WorktreeInfo[],
    branches: BranchInfo[],
  ): void {
    container.innerHTML = "";
    if (!branch) return;

    // Build whisper button label: branch icon + name + optional ahead/behind.
    const branchSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 0-9 9"/></svg>';

    const labelEl = document.createElement("span");
    labelEl.innerHTML = branchSvg;
    const nameNode = document.createTextNode(` ${branch}`);
    labelEl.appendChild(nameNode);

    const aheadCount = ahead ?? 0;
    const behindCount = behind ?? 0;
    if (aheadCount > 0 || behindCount > 0) {
      const counts = document.createElement("span");
      counts.style.cssText = "font-size:10.5px;opacity:0.7;margin-left:4px;";
      if (aheadCount > 0) counts.appendChild(document.createTextNode(`↑${aheadCount}`));
      if (behindCount > 0) {
        if (aheadCount > 0) counts.appendChild(document.createTextNode(" "));
        counts.appendChild(document.createTextNode(`↓${behindCount}`));
      }
      labelEl.appendChild(counts);
    }

    labelEl.appendChild(document.createTextNode(" "));
    const chevEl = document.createElement("span");
    chevEl.innerHTML = icon("chevronDown", 10, 2.4);
    labelEl.appendChild(chevEl);

    container.appendChild(labelEl);

    // Toggle dropdown on click.
    container.onclick = (e) => {
      e.stopPropagation();
      if (dropdownOpen) {
        closeDropdown();
        return;
      }
      if (branches.length === 0 && worktrees.length === 0) return;
      openDropdown(branch, branches, worktrees);
    };
  }

  function openDropdown(_currentBranch: string, branches: BranchInfo[], worktrees: WorktreeInfo[]): void {
    closeDropdown();
    dropdownOpen = true;
    container.classList.add("open");

    const dd = document.createElement("div");
    dd.className = "menu-card";

    if (branches.length > 0) {
      const head = document.createElement("div");
      head.className = "menu-head";
      head.textContent = "branches";
      dd.appendChild(head);

      for (const br of branches) {
        const row = document.createElement("div");
        row.className = "menu-row" + (br.is_current ? " current" : "");
        if (br.is_current) {
          const chk = document.createElement("span");
          chk.innerHTML = icon("check", 13);
          row.appendChild(chk);
        }
        const name = document.createElement("span");
        name.textContent = br.name;
        row.appendChild(name);
        row.onclick = () => {
          if (!br.is_current) handle.onBranchSelect?.(br.name);
          closeDropdown();
        };
        dd.appendChild(row);
      }
    }

    if (worktrees.length > 0) {
      const head = document.createElement("div");
      head.className = "menu-head";
      head.textContent = "worktrees";
      dd.appendChild(head);

      for (const wt of worktrees) {
        const row = document.createElement("div");
        row.className = "menu-row" + (wt.is_current ? " current" : "");
        if (wt.is_current) {
          const chk = document.createElement("span");
          chk.innerHTML = icon("check", 13);
          row.appendChild(chk);
        }
        const name = document.createElement("span");
        name.textContent = wt.name;
        row.appendChild(name);
        const pathSpan = document.createElement("span");
        pathSpan.className = "menu-path";
        pathSpan.textContent = homeCollapse(wt.path);
        row.appendChild(pathSpan);
        row.onclick = () => {
          if (!wt.is_current) handle.onWorktreeSelect?.(wt.path);
          closeDropdown();
        };
        dd.appendChild(row);
      }
    }

    document.body.appendChild(dd);

    // Position below the whisper button.
    const rect = container.getBoundingClientRect();
    dd.style.position = "fixed";
    dd.style.top = `${rect.bottom + 4}px`;
    dd.style.left = `${rect.left}px`;

    dropdown = dd;
    setTimeout(() => {
      document.addEventListener("mousedown", onOutside);
      document.addEventListener("keydown", onKey);
    }, 0);
  }

  const handle: GitBarHandle = {
    async refresh(root: string): Promise<void> {
      try {
        const branch = await gitBranch(root);
        const aheadBehind = await gitAheadBehind(root);
        const worktrees = await gitWorktrees(root);
        const branches = await gitBranches(root);
        render(
          branch,
          aheadBehind?.ahead ?? null,
          aheadBehind?.behind ?? null,
          worktrees,
          branches,
        );
      } catch {
        render(null, null, null, [], []);
      }
    },
  };

  return handle;
}
