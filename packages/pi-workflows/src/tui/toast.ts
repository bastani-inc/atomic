/**
 * Nvim-style notification card stack (overlay-only).
 * cross-ref: spec §5.4.7, v0.x packages/atomic-sdk/src/components/toast.tsx
 */
import type { GraphTheme } from "./graph-theme.js";

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
    add(toast: Omit<Toast, "id" | "createdAt">): string {
      const id = `toast-${++_toastCounter}`;
      toasts.push({ ...toast, id, createdAt: Date.now() });
      return id;
    },

    dismiss(id: string): void {
      const idx = toasts.findIndex((t) => t.id === id);
      if (idx !== -1) toasts.splice(idx, 1);
    },

    tick(now: number): void {
      // Remove expired toasts
      let i = toasts.length;
      while (i--) {
        const t = toasts[i]!;
        if (t.dismissAfterMs != null && now - t.createdAt >= t.dismissAfterMs) {
          toasts.splice(i, 1);
        }
      }
    },

    active(): Toast[] {
      return [...toasts];
    },
  };
}

export interface ToastOpts {
  theme: GraphTheme;
}

function hexBg(hex: string): string {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const WHITE_FG = "\x1b[37m";

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

/** Render the toast stack as lines (top-right anchored, caller overlays). */
export function renderToasts(toasts: Toast[], opts: ToastOpts): string[] {
  const { theme } = opts;
  const lines: string[] = [];

  for (const toast of toasts) {
    let bg: string;
    switch (toast.kind) {
      case "success":
        bg = hexBg(theme.toastSuccessBg);
        break;
      case "error":
        bg = hexBg(theme.toastErrorBg);
        break;
      case "warn":
        bg = hexBg(theme.toastWarnBg);
        break;
      default:
        bg = hexBg(theme.toastInfoBg);
    }
    const icon = kindIcon(toast.kind);
    const msg = toast.message.slice(0, 40); // truncate for display
    lines.push(`${bg}${WHITE_FG}${BOLD} ${icon} ${msg} ${RESET}`);
  }

  return lines;
}
