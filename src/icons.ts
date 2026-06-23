// Inline SVG icon set — single source so the toolbar, menu bar and dropdowns
// stay visually consistent. All icons inherit color via `currentColor` and use a
// 24x24 viewBox with round caps; size/stroke are caller-tunable.
export type IconName =
  | "trackAI"
  | "terminal"
  | "git-compare"
  | "diff"
  | "world"
  | "browser"
  | "command"
  | "menu"
  | "back"
  | "reload"
  | "folder"
  | "folderAdd"
  | "fileAdd"
  | "settings"
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
  | "compress"
  | "bolt"
  | "stop"
  | "brandMark"
  | "pencil"
  | "download"
  | "trash"
  | "list"
  | "openEditors";

const paths: Record<IconName, string> = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderAdd:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  fileAdd:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 12v6M9 15h6"/>',
  trackAI:
    '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z"/><circle cx="18.5" cy="17.5" r="2.4"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  "git-compare": '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h6M18 15V9a3 3 0 0 0-3-3H9"/>',
  diff: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/><path d="M6 9.5h3M7.5 8v3"/><path d="M15 14.5h3"/>',
  world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"/>',
  browser: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  command: '<rect x="2" y="7" width="20" height="10" rx="2"/><path d="M6.5 10.5l2.5 1.5-2.5 1.5"/><path d="M12 12h7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2 2 0 0 1-2.83 2.83l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.08 1.65V21a2 2 0 0 1-4 0v-.1a1.8 1.8 0 0 0-1.08-1.65 1.8 1.8 0 0 0-1.98.36l-.05.05a2 2 0 0 1-2.83-2.83l.05-.05A1.8 1.8 0 0 0 4.6 15a1.8 1.8 0 0 0-1.65-1.08H3a2 2 0 0 1 0-4h.1A1.8 1.8 0 0 0 4.75 8.84a1.8 1.8 0 0 0-.36-1.98l-.05-.05a2 2 0 0 1 2.83-2.83l.05.05a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 10.28 3V3a2 2 0 0 1 4 0v.1a1.8 1.8 0 0 0 1.08 1.65 1.8 1.8 0 0 0 1.98-.36l.05-.05a2 2 0 0 1 2.83 2.83l-.05.05a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.08H21a2 2 0 0 1 0 4h-.1A1.8 1.8 0 0 0 19.4 15z"/>',
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
  bolt: '<path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H13L13 2z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  // Sutra brand mark: an eternal knot — two loops woven over-and-under.
  brandMark: '<path d="M7.5 5 H12.5 A2.5 2.5 0 0 1 15 7.5 V12.5 A2.5 2.5 0 0 1 12.5 15 H11.6 M8.4 15 H7.5 A2.5 2.5 0 0 1 5 12.5 V7.5 A2.5 2.5 0 0 1 7.5 5 M11.5 9 H13.4 A2.5 2.5 0 0 1 19 11.5 V16.5 A2.5 2.5 0 0 1 16.5 19 H11.5 A2.5 2.5 0 0 1 9 16.5 V11.5 A2.5 2.5 0 0 1 11.5 9"/>',
  pencil: '<path d="M4 20h4l10-10a2 2 0 0 0-2.8-2.8L5.2 17.2 4 20z"/><path d="M14 6l4 4"/>',
  // Tray-with-down-arrow: surfaces an available app update.
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 19h14"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  // Indented-lines glyph representing a symbol outline / hierarchy tree.
  list: '<path d="M3 6h18M7 12h14M10 18h11"/>',
  // Two overlapping documents — the open-editors switcher (jump between open files).
  openEditors: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
};

export function icon(name: IconName, size = 16, stroke = 1.6): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
