import type { ReadonlyFooterDataProvider } from "@bastani/atomic";
import type { TUI } from "@bastani/atomic-tui";
import type { Store } from "../shared/store.js";
import type { GraphTheme } from "./graph-theme.js";

export type GraphViewMode = "overlay" | "widget";

/** What a graph action on a stage reports back: shown on the hint line for a moment. */
export interface GraphStageActionResult {
	readonly ok: boolean;
	readonly message: string;
	/** The run a retry or fork started, which the graph then shows. */
	readonly runId?: string;
}

/**
 * Run controls the graph offers on a focused stage. Each is optional: a host that cannot perform one leaves it out,
 * and the graph neither offers nor advertises its key.
 */
export interface GraphStageActions {
	/** Stop the stage so it can be resumed later (`x x`). */
	stop?(runId: string, stageId: string): Promise<GraphStageActionResult>;
	/** Continue a failed run from this failed stage: completed stages are kept and the stage runs again (`r`). */
	retry?(runId: string, stageId: string): Promise<GraphStageActionResult>;
	/** Fork the run into a new run that keeps its completed stages; the source run is never changed (`f`). */
	fork?(runId: string, stageId: string): Promise<GraphStageActionResult>;
}
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
	 * `F2` or `/workflows`.
	 */
	onHide?: () => void;
	/**
	 * Invoked when the user presses Enter on a focused graph node — the
	 * parent attach shell swaps the popup interior to that stage's chat
	 * pane. When unset, Enter is a no-op (preserves graph mode).
	 */
	onStageAttach?: (runId: string, stageId: string) => void;
	/**
	 * Invoked when Esc (or ← with nothing to the left) pops the graph itself: back to where it was opened from, main
	 * chat unless the opener said otherwise. Falls back to `onHide` when unset.
	 */
	onDetach?: () => void;
	/** Stop, retry and fork controls for a focused stage. */
	stageActions?: GraphStageActions;
	/** Show another run in this graph, such as the run a retry or fork started. */
	onShowRun?: (runId: string) => void;
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
	/**
	 * A value that differs whenever any stage's live queue count differs, read on every repaint in time proportional
	 * to the stages the host holds live, never to the stages of the run (#4642). A change re-reads every count and
	 * sizes the cards again; counts are otherwise read when the layout is built.
	 */
	getQueuedStageSignature?: () => string;
}
