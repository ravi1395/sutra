// Stanza room router: pure preset dispatcher mapping a RoomId to the fixed
// surface-visibility preset applied through injected setters. No DOM/app imports.
export type RoomId = "write" | "run" | "review" | "web";

export type RoomDeps = {
  setTerminal(v: boolean): void;
  setBrowser(v: boolean): void;
  setDiff(v: boolean): void;
  setComposer(v: boolean): void;
  setSidebar(v: boolean): void;
  focus(t: "editor" | "terminal" | "diff" | "browser"): void;
};

type RoomPreset = { terminal: boolean; browser: boolean; diff: boolean; composer: boolean; sidebar: boolean };

export const ROOM_PRESETS: Record<RoomId, RoomPreset> = {
  write: { terminal: false, browser: false, diff: false, composer: false, sidebar: true },
  run: { terminal: true, browser: false, diff: false, composer: false, sidebar: false },
  review: { terminal: false, browser: false, diff: true, composer: false, sidebar: false },
  web: { terminal: false, browser: true, diff: false, composer: false, sidebar: false },
};

// Each room's primary surface, focused last after its preset applies.
const ROOM_FOCUS: Record<RoomId, "editor" | "terminal" | "diff" | "browser"> = {
  write: "editor",
  run: "terminal",
  review: "diff",
  web: "browser",
};

type RoomChangeListener = (room: RoomId) => void;

// A synchronously-throwing setter must not stop the rest of the preset (or
// leave the router unable to handle the next enterRoom call).
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* one broken surface setter must not wedge the router */
  }
}

/** Builds a room router: enterRoom always applies the full preset (no
 *  same-room early-return) through deps in a fixed order, focuses the room's
 *  primary surface last, then notifies subscribers on every entry. */
export function createRoomRouter(deps: RoomDeps): {
  enterRoom(r: RoomId): void;
  resetRoom(): void;
  currentRoom(): RoomId;
  onRoomChange(cb: RoomChangeListener): () => void;
} {
  let current: RoomId = "write";
  const listeners = new Set<RoomChangeListener>();

  function enterRoom(room: RoomId): void {
    current = room;
    const preset = ROOM_PRESETS[room];
    safely(() => deps.setTerminal(preset.terminal));
    safely(() => deps.setBrowser(preset.browser));
    safely(() => deps.setDiff(preset.diff));
    safely(() => deps.setComposer(preset.composer));
    safely(() => deps.setSidebar(preset.sidebar));
    safely(() => deps.focus(ROOM_FOCUS[room]));
    for (const listener of listeners) listener(room);
  }

  // Resets the remembered room to "write" (D11) without touching any deps
  // setter or focus — used on stanza exit, where no layout mutation should
  // happen. The next enterRoom (re-entry/relaunch) applies the Write preset.
  function resetRoom(): void {
    current = "write";
    for (const listener of listeners) listener(current);
  }

  return {
    enterRoom,
    resetRoom,
    currentRoom: () => current,
    onRoomChange(cb: RoomChangeListener): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
