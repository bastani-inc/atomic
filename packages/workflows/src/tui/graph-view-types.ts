import type { ReadonlyFooterDataProvider } from "@bastani/atomic";
import type { TUI } from "@earendil-works/pi-tui";
import type { Store } from "../shared/store.js";
import type { GraphTheme } from "./graph-theme.js";

export type GraphViewMode = "overlay" | "widget";
/**
 * Terminal geometry exposed to GraphView. The renderer reads only `rows`;
 * the attach shell may pass its full host TUI because it satisfies this slice.
 */
export type GraphViewHost = {
	readonly terminal: Pick<TUI["terminal"], "rows">;
};

export interface GraphViewOpts {
	mode: GraphViewMode;
	runId: string | null;
	store: Store;
	graphTheme: GraphTheme;
	onClose?: () => void;
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
	 * Invoked when the user presses `Ctrl+X` in graph mode. Returns to main
	 * chat by hiding the popup with `setHidden(true)`. Falls back to `onHide`
	 * when unset.
	 */
	onDetach?: () => void;
	/**
	 * When provided, GraphView restores focus to this stage on construction.
	 * `initialFocusedRunId` disambiguates identical local stage IDs in nested runs.
	 * The attach shell uses the pair when returning from stage chat.
	 */
	initialFocusedStageId?: string;
	initialFocusedRunId?: string;
	/**
	 * Host terminal geometry for the fullscreen frame. GraphView consumes only
	 * `terminal.rows`; the attach shell passes the same host object to GraphView
	 * and the attached stage chat. StageChatView retains the full TUI because its
	 * editor and chat session host use it as well.
	 */
	piTui?: GraphViewHost;
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
	/** Host footer/status provider used to surface non-workflow extension statuses inside the fullscreen graph overlay. */
	footerData?: ReadonlyFooterDataProvider;
	/**
	 * Live pending steering/follow-up count for one stage, read on every graph
	 * repaint so a message queued from the stage chat stays visible after the
	 * user detaches. Runtime-only: queue state never enters a store snapshot.
	 */
	getStageQueuedMessageCount?: (runId: string, stageId: string) => number;
}
