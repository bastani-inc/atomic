/**
 * Toast stack — transient notifications anchored top-right of the overlay.
 *
 * Visual: solid status-coloured pill (`success`/`warning`/`info`/`error`)
 * with `backgroundElement` foreground and bold weight — same vocabulary as
 * the header pill (DESIGN.md §5 Mode Pills). Icon glyphs use the same
 * cross-platform text symbols as the rest of the workflow UI (`✓ ✗ ⚠ ℹ`).
 */
import type { GraphTheme } from "./graph-theme.js";
import { hexBg, hexToAnsi, RESET, BOLD } from "./color-utils.js";

export type ToastKind = "success" | "error" | "warn" | "info";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  createdAt: number;
  /** undefined = persistent */
  dismissAfterMs?: number;
}

export interface ToastManagerState {
  toasts: Toast[];
}

let _toastCounter = 0;

export function createToastManager(): {
  add(toast: Omit<Toast, "id" | "createdAt">): string;
  dismiss(id: string): void;
  tick(now: number): void;
  active(): Toast[];
} {
  const toasts: Toast[] = [];

  return {
    add(toast) {
      const id = `toast-${++_toastCounter}`;
      toasts.push({ ...toast, id, createdAt: Date.now() });
      return id;
    },
    dismiss(id) {
      const idx = toasts.findIndex((t) => t.id === id);
      if (idx !== -1) toasts.splice(idx, 1);
    },
    tick(now) {
      let i = toasts.length;
      while (i--) {
        const t = toasts[i]!;
        if (t.dismissAfterMs != null && now - t.createdAt >= t.dismissAfterMs) {
          toasts.splice(i, 1);
        }
      }
    },
    active() {
      return [...toasts];
    },
  };
}

export interface ToastOpts {
  theme: GraphTheme;
}

function kindIcon(kind: ToastKind): string {
  switch (kind) {
    case "success":
      return "✓";
    case "error":
      return "✗";
    case "warn":
      return "⚠";
    case "info":
      return "ℹ";
  }
}

function kindBg(kind: ToastKind, theme: GraphTheme): string {
  switch (kind) {
    case "success":
      return theme.success;
    case "error":
      return theme.error;
    case "warn":
      return theme.warning;
    case "info":
      return theme.info;
  }
}

/** Render the toast stack as styled lines (caller overlays them). */
export function renderToasts(toasts: Toast[], opts: ToastOpts): string[] {
  const { theme } = opts;
  const fg = hexToAnsi(theme.backgroundElement);
  const lines: string[] = [];

  for (const toast of toasts) {
    const bg = hexBg(kindBg(toast.kind, theme));
    const icon = kindIcon(toast.kind);
    const msg = toast.message.length > 40 ? toast.message.slice(0, 39) + "…" : toast.message;
    lines.push(`${bg}${fg}${BOLD} ${icon} ${msg} ${RESET}`);
  }

  return lines;
}
