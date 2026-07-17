import { isEmptyDraftContent } from "./composer-store";
import { surfacePills, type SurfaceId, type SurfaceState, type Surfaces } from "./surface-state";

export function terminalSurface(visible: boolean, count: number, liveCount: number): SurfaceState {
  return { visible, badge: liveCount > 0 ? "live" : count > 0 ? "dormant" : null };
}

export function browserSurface(visible: boolean, hasHistory: boolean): SurfaceState {
  return { visible, badge: hasHistory ? "dormant" : null };
}

export function composerSurface(visible: boolean, hasDraft: boolean): SurfaceState {
  return { visible, badge: hasDraft ? "dormant" : null };
}

export function diffSurface(visible: boolean): SurfaceState {
  return { visible, badge: null };
}

export type SurfaceRestorers = Readonly<Record<SurfaceId, () => void>>;

export function restorableSurfacePills(all: Surfaces, restorers: SurfaceRestorers): Array<{
  id: SurfaceId;
  live: boolean;
  restore: () => void;
}> {
  return surfacePills(all).map((pill) => ({ ...pill, restore: restorers[pill.id] }));
}

export class ChipHostCache<T> {
  private lastSignature = "";

  constructor(
    private readonly classicHost: T,
    private readonly northHost: T,
  ) {}

  host(north: boolean): T {
    return north ? this.northHost : this.classicHost;
  }

  shouldRender(signature: string): boolean {
    if (signature === this.lastSignature) return false;
    this.lastSignature = signature;
    return true;
  }

  reset(clear: (host: T) => void): void {
    this.lastSignature = "";
    clear(this.classicHost);
    clear(this.northHost);
  }
}

type DraftListener = (hasDraft: boolean) => void;

/** Observable draft-content bit shared by the composer and its owning surface. */
export class DraftStateSignal {
  private current = false;
  private readonly listeners = new Set<DraftListener>();
  private readonly notifications: Array<{ current: boolean; listeners: DraftListener[] }> = [];
  private draining = false;

  hasDraft(): boolean {
    return this.current;
  }

  update(text: Record<string, string>, chipCount: number): void {
    const next = !isEmptyDraftContent(text, chipCount);
    if (next === this.current) return;
    this.current = next;
    this.notifications.push({ current: next, listeners: [...this.listeners] });
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.notifications.length > 0) {
        const notification = this.notifications.shift()!;
        for (const listener of notification.listeners) listener(notification.current);
      }
    } finally {
      this.draining = false;
    }
  }

  onChanged(listener: DraftListener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}

export interface ComposerDraftSource {
  hasDraft(): boolean;
  onDraftChanged(listener: DraftListener): () => void;
}

/** Owns exactly one root-scoped composer subscription and generation-gates late callbacks. */
export class ComposerSurfaceBinding {
  private generation = 0;
  private unsubscribe: (() => void) | null = null;

  bind(
    root: string,
    source: ComposerDraftSource,
    visible: () => boolean,
    publish: (root: string, state: SurfaceState) => void,
  ): void {
    this.clear();
    const generation = this.generation;
    const unsubscribe = source.onDraftChanged((hasDraft) => {
      if (generation !== this.generation) return;
      publish(root, composerSurface(visible(), hasDraft));
    });
    if (generation === this.generation) this.unsubscribe = unsubscribe;
    else unsubscribe();
  }

  clear(): void {
    this.generation += 1;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    unsubscribe?.();
  }
}

export interface PersistedDraftContent {
  text: Record<string, string>;
  chips: readonly unknown[];
}

type PersistedDraftLoad = PersistedDraftContent | null | PromiseLike<PersistedDraftContent | null>;

/** Probes hidden-workspace draft state without mounting composer UI. */
export class HiddenComposerSurfaceHydrator {
  private generation = 0;
  private root: string | null = null;
  private currentHasDraft = false;

  constructor(
    private readonly load: (root: string) => PersistedDraftLoad,
    private readonly publish: (root: string, state: SurfaceState) => void,
  ) {}

  hydrate(root: string): void {
    const generation = ++this.generation;
    this.root = root;
    this.currentHasDraft = false;
    const complete = (draft: PersistedDraftContent | null): void => {
      if (generation !== this.generation || this.root !== root) return;
      this.currentHasDraft = draft !== null && !isEmptyDraftContent(draft.text, draft.chips.length);
      this.publish(root, composerSurface(false, this.currentHasDraft));
    };
    try {
      const draft = this.load(root);
      if (draft && typeof (draft as PromiseLike<PersistedDraftContent | null>).then === "function") {
        void Promise.resolve(draft).then(complete, () => complete(null));
      } else {
        complete(draft as PersistedDraftContent | null);
      }
    } catch {
      complete(null);
    }
  }

  hasDraft(root: string): boolean {
    return this.root === root && this.currentHasDraft;
  }

  clear(): void {
    this.generation += 1;
    this.root = null;
    this.currentHasDraft = false;
  }
}
