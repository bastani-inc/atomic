export interface WorkingVisibilitySurface {
  setWorkingVisible?: (visible: boolean) => void;
}

export interface WorkingVisibilityGuard {
  hide: () => void;
  restore: () => void;
}

/**
 * Suppress Atomic's host "Working…" row while a blocking workflow UI owns the
 * editor/overlay surface, then re-enable the host at settle time. There is no
 * visibility getter to snapshot; restore means "allow Working to render again".
 * The host still suppresses the loader when the session is not streaming.
 */
export function createWorkingVisibilityGuard(
  ui: WorkingVisibilitySurface,
): WorkingVisibilityGuard {
  let hidden = false;
  const setWorkingVisible = ui.setWorkingVisible;

  return {
    hide: () => {
      if (typeof setWorkingVisible !== "function") return;
      try {
        setWorkingVisible.call(ui, false);
        hidden = true;
      } catch {
        // Keep workflow overlays functional on stale or partially-compatible
        // hosts that reject visibility updates.
      }
    },
    restore: () => {
      if (!hidden || typeof setWorkingVisible !== "function") return;
      hidden = false;
      try {
        setWorkingVisible.call(ui, true);
      } catch {
        // A late settle after session replacement should not prevent the
        // command promise from resolving.
      }
    },
  };
}
