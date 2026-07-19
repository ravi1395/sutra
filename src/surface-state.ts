export type SurfaceId = "terminal" | "browser" | "diff" | "composer";

export type SurfaceState = {
  visible: boolean;
  badge: "live" | "dormant" | null;
};

export type Surfaces = Readonly<Record<SurfaceId, Readonly<SurfaceState>>>;

export type SurfacePill = { id: SurfaceId; live: boolean };

type SurfacesListener = (surfaces: Surfaces) => void;

const SURFACE_IDS: readonly SurfaceId[] = ["terminal", "browser", "diff", "composer"];

function freezeSurfaces(surfaces: Record<SurfaceId, SurfaceState>): Surfaces {
  for (const id of SURFACE_IDS) Object.freeze(surfaces[id]);
  return Object.freeze(surfaces);
}

let surfaces: Surfaces = freezeSurfaces({
  terminal: { visible: false, badge: null },
  browser: { visible: false, badge: null },
  diff: { visible: false, badge: null },
  composer: { visible: false, badge: null },
});

const listeners = new Set<SurfacesListener>();
const notifications: { surfaces: Surfaces; listeners: SurfacesListener[] }[] = [];
let draining = false;

function notify(next: Surfaces): void {
  notifications.push({ surfaces: next, listeners: [...listeners] });
  if (draining) return;

  draining = true;
  try {
    while (notifications.length > 0) {
      const notification = notifications.shift()!;
      for (const listener of notification.listeners) listener(notification.surfaces);
    }
  } finally {
    draining = false;
  }
}

export function setSurface(id: SurfaceId, state: SurfaceState): void {
  const previous = surfaces[id];
  if (previous.visible === state.visible && previous.badge === state.badge) return;

  surfaces = freezeSurfaces({ ...surfaces, [id]: { visible: state.visible, badge: state.badge } });
  notify(surfaces);
}

export function onSurfaces(listener: SurfacesListener): () => void {
  listeners.add(listener);
  listener(surfaces);
  return () => listeners.delete(listener);
}

export function surfacePills(all: Surfaces): SurfacePill[] {
  return SURFACE_IDS.flatMap((id) => {
    const surface = all[id];
    return !surface.visible && surface.badge !== null
      ? [{ id, live: surface.badge === "live" }]
      : [];
  });
}
