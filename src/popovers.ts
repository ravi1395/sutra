// Registry of currently-open dropdowns/popovers/modals, so window blur (app
// losing OS focus) can dismiss all of them in one shot. Each owner registers
// its close function while open and unregisters on close; document-level
// mousedown listeners alone never see focus lost to another app.
const openPopovers = new Set<() => void>();

export function registerOpenPopover(close: () => void): () => void {
  openPopovers.add(close);
  return () => openPopovers.delete(close);
}

export function closeAllPopovers(): void {
  for (const close of [...openPopovers]) close();
}
