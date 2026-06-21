import type { Store } from "../shared/store.js";
import type { GraphTheme } from "./graph-theme.js";

export type GraphViewMode = "overlay" | "widget";

export interface GraphViewOpts {
  mode: GraphViewMode;
  runId: string | null;
  store: Store;
  graphTheme: GraphTheme;
  onClose?: () => void;
  /**
   * Invoked when the user presses `q` inside the pane on an in-flight
   * run. Fires immediately (no confirm) per the toggle-driven UX:
   * `h` hides without quitting; `q` is reserved for terminating the
   * current run.
   */
  onKill?: (runId: string) => void;
  /**
   * Invoked when the user presses `h` inside the pane. Hides without
   * unmounting (overlay-adapter calls `setHidden(true)`). Re-open via
   * `F2` or `/workflow connect <id>`.
   */
  onHide?: () => void;
  /**
   * Invoked when the user submits (or skips) a HIL prompt rendered inside
   * the pane. The callback typically calls `store.resolvePendingPrompt`;
   * GraphView itself stays UI-only.
   */
  onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  /**
   * Invoked when the user presses Enter on a focused graph node — the
   * parent attach shell swaps the popup interior to that stage's chat
   * pane. When unset, Enter is a no-op (preserves graph mode).
   */
  onStageAttach?: (runId: string, stageId: string) => void;
  /**
   * Invoked when the user presses `Ctrl+D` while in graph mode. Mirrors
   * the in-chat back affordance: detaches the whole popup (host calls
   * `setHidden(true)`). Falls back to `onHide` when unset.
   */
  onDetach?: () => void;
  /**
   * When provided, GraphView restores focus to this stage on construction
   * — used by the attach shell so returning from the chat lands the
   * cursor on the same node the user just attached to.
   */
  initialFocusedStageId?: string;
  /**
   * Optional accessor returning the current terminal row count. When
   * present in overlay mode the renderer expands the frame to roughly
   * `viewportRows` lines (clamped to at least the header + statusline
   * budget) so the popup fills the terminal under pi-tui's
   * `width: "100%" / maxHeight: "100%"` geometry. Returning `undefined`
   * falls back to the constant `OVERLAY_LINE_COUNT` rectangle.
   */
  getViewportRows?: () => number | undefined;
  /**
   * Invoked on each animation tick (~10 FPS) so the host can call
   * `tui.requestRender()`. Only wired in `overlay` mode; supplying it
   * starts the tick loop in the constructor so duration counters and
   * the running-stage border pulse refresh without requiring a key
   * press. The host is responsible for gating the underlying
   * `requestRender` on overlay visibility / focus (see
   * `overlay-adapter.ts`).
   */
  requestRender?: () => void;
  /** Host Pi keybindings manager used by run-level prompt cards. */
  piKeybindings?: unknown;
}
