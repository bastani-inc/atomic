import type { ReadonlyFooterDataProvider } from "@bastani/atomic";
import type { TUI } from "@bastani/atomic-tui";
import type { Store } from "../shared/store.js";
import type { StoreSnapshot } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";

export type GraphViewMode = "overlay" | "widget";

export type GraphForkTargetResult =
	| {
			readonly ok: true;
			readonly stagePath: string;

			readonly rerunToolSteps: number;

			readonly live: boolean;
	  }
	| { readonly ok: false; readonly message: string };

export interface GraphViewCarry {
	readonly notice?: { readonly text: string; readonly tone: "info" | "error" };

	readonly focusStageId?: string;
}

export interface GraphStageActionResult {
	readonly ok: boolean;
	readonly message: string;

	readonly runId?: string;
}

export interface GraphStageActions {
	stop?(runId: string, stageId: string): Promise<GraphStageActionResult>;

	retry?(runId: string, stageId: string): Promise<GraphStageActionResult>;

	forkTarget?(rootRunId: string, stageId: string): Promise<GraphForkTargetResult>;
	fork?(rootRunId: string, stageId: string): Promise<GraphStageActionResult>;

	pauseRun?(runId: string): Promise<GraphStageActionResult>;
	/** Whether a stopped run can continue using the action owner's live and durable state. */
	canResumeRun?(runId: string): boolean;
	resumeRun?(runId: string): Promise<GraphStageActionResult>;
	quitRun?(runId: string): Promise<GraphStageActionResult>;
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

	onHide?: () => void;
	/**
	 * Invoked when the user presses Enter on a focused graph node — the
	 * parent attach shell swaps the popup interior to that stage's chat
	 * pane. When unset, Enter is a no-op (preserves graph mode).
	 */
	onStageAttach?: (runId: string, stageId: string) => void;

	onDetach?: () => void;

	stageActions?: GraphStageActions;

	onShowRun?: (runId: string, carry?: GraphViewCarry) => void;

	carry?: GraphViewCarry;
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
	getStageQueuedMessageCount?: (runId: string, stageId: string, snapshotCount: number) => number;
	/**
	 * A value that differs whenever any stage's live queue count differs, read on every repaint in time proportional
	 * to the stages the host holds live, never to the stages of the run (#4642). A change re-reads every count and
	 * sizes the cards again; counts are otherwise read when the layout is built.
	 */
	getQueuedStageSignature?: (snapshot: StoreSnapshot | null) => string;
}
