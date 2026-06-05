// Inline SVG icon set — single source so the toolbar, menu bar and dropdowns
// stay visually consistent. All icons inherit color via `currentColor` and use a
// 24x24 viewBox with round caps; size/stroke are caller-tunable.
export type IconName =
  | "trackAI"
  | "terminal"
  | "diff"
  | "browser"
  | "back"
  | "reload"
  | "folder"
  | "folderAdd"
  | "check"
  | "chevronDown"
  | "search"
  | "refresh"
  | "play"
  | "plus"
  | "arrowDown"
  | "arrowUp"
  | "x"
  | "expand"
  | "compress";

const paths: Record<IconName, string> = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderAdd:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  trackAI:
    '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><circle cx="18.5" cy="17.5" r="2.4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  diff: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/><path d="M6 9.5h3M7.5 8v3"/><path d="M15 14.5h3"/>',
  browser: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  back: '<path d="M5 12h14M9 8l-4 4 4 4"/>',
  reload: '<path d="M4 12a8 8 0 0 1 14.93-4H15m4 0V4"/><path d="M20 12a8 8 0 0 1-14.93 4H9m-4 0v4"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14.93-4H15m4 0V4"/><path d="M20 12a8 8 0 0 1-14.93 4H9m-4 0v4"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowDown: '<path d="M12 5v14M7 14l5 5 5-5"/>',
  arrowUp: '<path d="M12 19V5M7 10l5-5 5 5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4M10 14 3 21M21 3l-7 7"/>',
};

export function icon(name: IconName, size = 16, stroke = 1.6): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
