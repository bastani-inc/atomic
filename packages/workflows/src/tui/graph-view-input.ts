import { TwoPressConfirm } from "@bastani/atomic";
import type { KeyId } from "@bastani/atomic-tui";
import { unknownErrorMessage } from "../runs/foreground/executor-abort.js";
import { GRAPH_SCROLL_STEP_COLS } from "./graph-view-constants.js";
import { GraphViewRenderer } from "./graph-view-render.js";
import { blockerKey, GRAPH_STATUS_FILTERS } from "./graph-view-state.js";
import type { GraphStageActionResult } from "./graph-view-types.js";
import {
	APP_ACTION,
	isKeybindingsLike,
	type KeybindingsLike,
	matchesAction,
	matchesNavAction,
} from "./keybindings-adapter.js";
import { isTerminalLeftMousePress, parseTerminalMouseInput, terminalMouseWheelDirection } from "./mouse-input.js";
import { filterStages, type SwitcherState } from "./switcher.js";
import { Key, matchesKey } from "./text-helpers.js";

interface MouseWheelDelta {
	cols: number;
	rows: number;
}

const GRAPH_SCROLL_WHEEL_LINES = 4;

const GRAPH_NOTICE_MS = 4000;

/** Keyboard, mouse, switcher, prompt, and focus navigation handling. */
export abstract class GraphViewInputController extends GraphViewRenderer {
	/** Returns true if consumed. */
	handleInput(data: string): boolean {
		const prior = this.displayBlock;
		this.displayBlock = undefined;
		try {
			return this._handleInput(data);
		} finally {
			this.displayBlock = prior;
		}
	}

	private _handleInput(data: string): boolean {
		const paintedView = this.paintedView;
		const paintedBlockerKey = this.paintedBlockerKey;
		this._syncLayout();
		if (this.keysHelpOpen) return this._handleKeysHelpInput(data);
		if (this.switcherOpen) return this._handleSwitcherInput(data);
		if (this.forkConfirm === null && this._matchesNavAction(data, APP_ACTION.keysHelp)) {
			this._disarmStop();
			this.keysHelpOpen = true;
			return true;
		}
		if (
			matchesKey(data, Key.escape) &&
			paintedView !== this._currentViewKind() &&
			((paintedView === "stage" && this.stageDetail === null) ||
				(paintedView === "tool" && this.toolDetail === null) ||
				(paintedView === "run" && this._currentViewKind() === "graph"))
		) {
			return true;
		}
		if (this.toolDetail !== null) return this._handleToolDetailInput(data);
		if (this.stageDetail !== null) return this._handleStageDetailInput(data);
		if (this.runDetail !== null) return this._handleRunDetailInput(data, paintedView, paintedBlockerKey);
		if (matchesKey(data, Key.escape)) {
			this._leaveGraph();
			return true;
		}
		if (this.graphLayout.isScrollbarInput(data)) return this._handleGraphInput(data);
		const wheelDelta = this._mouseWheelDelta(data);
		if (wheelDelta) return this._handleWheelDelta(wheelDelta);
		return this._handleGraphInput(data);
	}

	private _handleToolDetailInput(data: string): boolean {
		if (this.graphLayout.handleScrollbarInput(data)) {
			this.pendingEnsureFocusedVisible = false;
			return true;
		}
		const wheelDelta = this._mouseWheelDelta(data);
		if (wheelDelta) {
			if (wheelDelta.rows !== 0) this._scrollGraphVertically(wheelDelta.rows);
			return true;
		}
		if (this._matchesToolExpandInput(data)) {
			this.toolDetailExpanded = !this.toolDetailExpanded;
			this.pendingEnsureFocusedVisible = true;
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			this._closeToolDetail();
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose?.();
			return true;
		}
		// A capped payload still renders far more rows than a terminal shows, so
		// the detail must be readable without a mouse: these keys drive the same
		// vertical scroll the wheel and scrollbar drive.
		if (matchesKey(data, Key.down)) {
			this._scrollGraphVertically(1);
			return true;
		}
		if (matchesKey(data, Key.up)) {
			this._scrollGraphVertically(-1);
			return true;
		}
		if (matchesKey(data, Key.pageDown)) {
			this._scrollGraphVertically(this._toolDetailPageRows());
			return true;
		}
		if (matchesKey(data, Key.pageUp)) {
			this._scrollGraphVertically(-this._toolDetailPageRows());
			return true;
		}
		if (matchesKey(data, Key.home)) {
			this.pendingEnsureFocusedVisible = false;
			this.graphLayout.scrollView.scrollToStart();
			return true;
		}
		if (matchesKey(data, Key.end)) {
			this.pendingEnsureFocusedVisible = false;
			this.graphLayout.scrollView.scrollToEnd();
			return true;
		}
		if (
			matchesKey(data, Key.enter) ||
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.right) ||
			matchesKey(data, "/") ||
			parseTerminalMouseInput(data) !== null
		)
			return true;
		return false;
	}

	private _handleKeysHelpInput(data: string): boolean {
		if (matchesKey(data, Key.escape) || this._matchesNavAction(data, APP_ACTION.keysHelp)) this.keysHelpOpen = false;
		else if (matchesKey(data, Key.ctrl("c"))) {
			this.keysHelpOpen = false;
			this.onClose?.();
		}
		return true;
	}

	private _handleStageDetailInput(data: string): boolean {
		const detail = this.stageDetail;
		if (detail === null) return false;
		const actions = this.stageActions;
		const confirm = this.forkConfirm;
		if (confirm !== null) {
			if (matchesKey(data, Key.enter) && actions?.fork) {
				this.forkConfirm = null;
				this._runStageAction(
					() => actions.fork!(confirm.rootRunId, confirm.stageId),
					`Forking from ${confirm.name}\u2026`,
					{
						focusStageId: detail.stageId,
					},
				);
			} else if (matchesKey(data, Key.escape)) {
				this.forkConfirm = null;
				this.graphNotice = null;
			} else if (matchesKey(data, Key.ctrl("c"))) this.onClose?.();
			return true;
		}
		if (this.graphLayout.handleScrollbarInput(data)) {
			this.pendingEnsureFocusedVisible = false;
			return true;
		}
		const wheelDelta = this._mouseWheelDelta(data);
		if (wheelDelta) {
			if (wheelDelta.rows !== 0) this._scrollGraphVertically(wheelDelta.rows);
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			this._closeStageDetail();
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose?.();
			return true;
		}
		const stage = this._stageDetailStage();
		const name = stage?.name ?? detail.stageId;

		if ((matchesKey(data, "r") || matchesKey(data, "f")) && this.stageActionInFlight) return true;
		if (matchesKey(data, "r") && detail.status === "failed" && actions?.retry) {
			const failedAt = stage?.endedAt;
			this._runStageAction(() => actions.retry!(detail.runId, detail.stageId), `Retrying ${name}\u2026`, {
				focusStageId: detail.stageId,
				onSameRun: () => {
					this.retryWatch = { nodeId: detail.nodeId, failedAt, sawRetry: false };
				},
			});
			return true;
		}
		if (matchesKey(data, "f") && this._forkAvailable()) {
			this._askForkConfirmation(detail.stageId, name);
			return true;
		}
		if (matchesKey(data, "t") && this.onStageAttach) {
			this._closeStageDetail();
			this.onStageAttach(detail.runId, detail.stageId);
			return true;
		}
		if (matchesKey(data, "l")) {
			detail.logs = !detail.logs;
			this.graphLayoutInvalidateForDetail();
			return true;
		}
		if (detail.logs) {
			if (matchesKey(data, Key.down)) this._scrollGraphVertically(1);
			else if (matchesKey(data, Key.up)) this._scrollGraphVertically(-1);
			else if (matchesKey(data, Key.pageDown)) this._scrollGraphVertically(this._toolDetailPageRows());
			else if (matchesKey(data, Key.pageUp)) this._scrollGraphVertically(-this._toolDetailPageRows());
		}
		return true;
	}

	private _handleRunDetailInput(
		data: string,
		paintedView: "tool" | "stage" | "run" | "graph",
		paintedBlockerKey: string | null,
	): boolean {
		const detail = this.runDetail;
		if (detail === null) return false;
		if (this.graphLayout.handleScrollbarInput(data)) {
			this.pendingEnsureFocusedVisible = false;
			return true;
		}
		const wheelDelta = this._mouseWheelDelta(data);
		if (wheelDelta) {
			if (wheelDelta.rows !== 0) this._scrollGraphVertically(wheelDelta.rows);
			return true;
		}
		if (matchesKey(data, Key.escape)) {
			this._closeRunDetail();
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose?.();
			return true;
		}
		if (matchesKey(data, "l")) {
			detail.logs = !detail.logs;
			this.graphLayoutInvalidateForDetail();
			return true;
		}
		const blockers = detail.logs ? [] : this._runDetailBlockers();
		if (blockers.length > 1) {
			if (matchesKey(data, Key.down)) {
				this._moveRunDetailSelection(blockers, 1);
				this.runDetailRevealSelected = true;
				return true;
			}
			if (matchesKey(data, Key.up)) {
				this._moveRunDetailSelection(blockers, -1);
				this.runDetailRevealSelected = true;
				return true;
			}
		}
		if (blockers.length > 0 && (matchesKey(data, Key.enter) || matchesKey(data, Key.right))) {
			const blocker = blockers[this._resolveRunDetailSelection(blockers)]!;
			if (
				paintedView === "run" &&
				paintedBlockerKey === blockerKey(blocker) &&
				this._focusBlockerNode(blocker.node, blocker.id)
			) {
				this._activateFocusedNode();
				if (!this._detailOpen()) this.runDetailReturn = null;
			}
			return true;
		}
		if (matchesKey(data, Key.down)) this._scrollGraphVertically(1);
		else if (matchesKey(data, Key.up)) this._scrollGraphVertically(-1);
		else if (matchesKey(data, Key.pageDown)) this._scrollGraphVertically(this._toolDetailPageRows());
		else if (matchesKey(data, Key.pageUp)) this._scrollGraphVertically(-this._toolDetailPageRows());
		return true;
	}

	private _invokeStageAction<T>(action: () => Promise<T>): Promise<T> {
		try {
			return Promise.resolve(action());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private _runStageAction(
		action: () => Promise<GraphStageActionResult>,
		progress: string,
		options: { readonly focusStageId?: string; readonly onSameRun?: () => void } = {},
	): void {
		this.graphNotice = { text: progress, tone: "info", until: Date.now() + 60_000 };
		this.stageActionInFlight = true;
		this.requestRender?.();
		void this._invokeStageAction(action).then(
			(outcome) => {
				if (this.disposed) return;
				this.stageActionInFlight = false;
				const notice = { text: outcome.message, tone: outcome.ok ? ("info" as const) : ("error" as const) };
				this.graphNotice = { ...notice, until: Date.now() + GRAPH_NOTICE_MS };
				if (outcome.ok && outcome.runId !== undefined && outcome.runId !== this.runId) {
					this._closeStageDetail();
					this.onShowRun?.(outcome.runId, { notice, focusStageId: options.focusStageId });
				} else if (outcome.ok) {
					options.onSameRun?.();
				}
				this.requestRender?.();
			},
			(error: unknown) => {
				if (this.disposed) return;
				this.stageActionInFlight = false;
				this.graphNotice = {
					text: unknownErrorMessage(error),
					tone: "error",
					until: Date.now() + GRAPH_NOTICE_MS,
				};
				this.requestRender?.();
			},
		);
	}

	private stageActionInFlight = false;

	private _forkAvailable(): boolean {
		return this.stageActions?.fork !== undefined && this.stageActions.forkTarget !== undefined && this.runId !== null;
	}

	private _askForkConfirmation(stageId: string, name: string): void {
		const rootRunId = this.runId;
		const detail = this.stageDetail;
		const actions = this.stageActions;
		if (rootRunId === null || actions?.forkTarget === undefined) return;
		this.stageActionInFlight = true;
		const notice = {
			text: `Checking where a fork from ${name} starts\u2026`,
			tone: "info" as const,
			until: Date.now() + 60_000,
		};
		this.graphNotice = notice;
		this.requestRender?.();
		void this._invokeStageAction(() => actions.forkTarget!(rootRunId, stageId)).then(
			(target) => {
				if (this.disposed) return;
				this.stageActionInFlight = false;
				if (this.stageDetail !== detail) {
					if (this.graphNotice === notice) this.graphNotice = null;
					this.requestRender?.();
					return;
				}
				if (!target.ok) {
					this.graphNotice = { text: target.message, tone: "error", until: Date.now() + GRAPH_NOTICE_MS };
				} else {
					const tools =
						target.rerunToolSteps === 0
							? ""
							: ` and ${target.rerunToolSteps} completed tool step${target.rerunToolSteps === 1 ? "" : "s"}`;
					const stop = target.live ? " Stops this run first, resumably." : "";
					this.forkConfirm = { rootRunId, stageId, name };
					this.graphNotice = {
						text: `New run from ${name}? Reruns it${tools} in a new run.${stop}`,
						tone: "info",
						until: Number.POSITIVE_INFINITY,
					};
				}
				this.requestRender?.();
			},
			(error: unknown) => {
				if (this.disposed) return;
				this.stageActionInFlight = false;
				if (this.stageDetail !== detail) {
					if (this.graphNotice === notice) this.graphNotice = null;
				} else {
					this.graphNotice = {
						text: unknownErrorMessage(error),
						tone: "error",
						until: Date.now() + GRAPH_NOTICE_MS,
					};
				}
				this.requestRender?.();
			},
		);
	}

	private _handleStopInput(data: string): boolean {
		if (this.stageActionInFlight) return true;
		this.quitConfirm.reset();
		this._clearQuitConfirmTarget();
		const stage = this.cachedLayout[this.focusedIndex]?.stage;
		const target = this._stageChatTarget(stage);
		if (!this._focusedStageStoppable() || stage === undefined || target === undefined) return true;
		const key = `${target.runId}\u0000${target.stageId}`;
		if (!this.stopConfirm.press(key)) {
			const bindings = this._promptKeybindings()?.getKeys?.(APP_ACTION.listStop) ?? ["x"];
			const pressed = bindings.find((binding) => matchesKey(data, binding as KeyId)) ?? "the stop key";
			this.graphNotice = {
				text: `Press ${pressed} again within 3s to stop ${stage.name}`,
				tone: "info",
				until: Date.now() + 3000,
				arm: true,
			};
			return true;
		}
		this.graphNotice = null;
		const actions = this.stageActions;
		if (actions?.stop)
			this._runStageAction(() => actions.stop!(target.runId, target.stageId), `Stopping ${stage.name}\u2026`);
		return true;
	}

	private _handlePauseRunInput(): boolean {
		if (this.stageActionInFlight) return true;
		const run = this._getCurrentRun();
		const actions = this.stageActions;
		if (!this._runPausable(run) || run === null || actions?.pauseRun === undefined) return true;
		this._disarmStop();
		this._runStageAction(() => actions.pauseRun!(run.id), `Pausing ${run.name}\u2026`);
		return true;
	}

	private _handleResumeRunInput(): boolean {
		if (this.stageActionInFlight) return true;
		const run = this._getCurrentRun();
		const actions = this.stageActions;
		if (!this._runResumable(run) || run === null || actions?.resumeRun === undefined) return true;
		this._disarmStop();
		this._runStageAction(() => actions.resumeRun!(run.id), `Resuming ${run.name}\u2026`);
		return true;
	}

	private _handleQuitRunInput(): boolean {
		if (this.stageActionInFlight) return true;
		this.stopConfirm.reset();
		const run = this._getCurrentRun();
		const actions = this.stageActions;
		if (!this._runQuittable(run) || run === null || actions?.quitRun === undefined) {
			this.quitConfirm.reset();
			this._clearQuitConfirmTarget();
			return true;
		}
		if (!this._isQuitArmed(run)) {
			this.quitConfirm.reset();
		}
		const stateKey = this._runControlState(run);
		const key = `${run.id}\u0000${stateKey}`;
		if (!this.quitConfirm.press(key)) {
			const until = Date.now() + 3000;
			this.quitConfirmTarget = { runId: run.id, status: stateKey, until };
			this.graphNotice = {
				text: `Press q again within 3s to quit ${run.name}`,
				tone: "info",
				until,
				arm: true,
			};
			return true;
		}
		this._disarmStop();
		this._runStageAction(() => actions.quitRun!(run.id), `Quitting ${run.name}\u2026`);
		return true;
	}

	private readonly stopConfirm = new TwoPressConfirm();
	private readonly quitConfirm = new TwoPressConfirm();

	private _disarmStop(): void {
		this.stopConfirm.reset();
		this.quitConfirm.reset();
		this._clearQuitConfirmTarget();
		if (this.graphNotice?.arm === true) this.graphNotice = null;
	}

	/** One page is the visible body, less a row of overlap for continuity. */
	private _toolDetailPageRows(): number {
		return Math.max(1, this.graphLayout.viewportRows - 1);
	}

	private _promptKeybindings(): KeybindingsLike | undefined {
		return isKeybindingsLike(this.piKeybindings) ? this.piKeybindings : undefined;
	}

	private _matchesToolExpandInput(data: string): boolean {
		const keybindings = this._promptKeybindings();
		// Do not run a raw fallback beside a host manager: a user remap must win,
		// and an explicitly unbound action must remain unbound.
		return matchesAction(keybindings, data, APP_ACTION.toolsExpand);
	}

	private _matchesNavAction(data: string, action: string): boolean {
		return matchesNavAction(this._promptKeybindings(), data, action);
	}

	private _leaveGraph(): void {
		this._disarmStop();
		if (this.onDetach) this.onDetach();
		else this.onHide?.();
	}

	private _handleGraphInput(data: string): boolean {
		if (this._getCurrentRun() === null) {
			if (matchesKey(data, "h") && this.onHide && !this._keyShadowed("h")) {
				this.onHide();
				return true;
			}
			if (matchesKey(data, Key.ctrl("c"))) {
				this.onClose?.();
				return true;
			}
			return false;
		}
		const stageCount = this.cachedLayout.length;
		if (this.graphLayout.handleScrollbarInput(data)) {
			this.pendingEnsureFocusedVisible = false;
			return true;
		}
		const wheelDelta = this._mouseWheelDelta(data);
		if (wheelDelta) return this._handleWheelDelta(wheelDelta);

		const clickedNodeIndex = this._graphNodeIndexForClick(data);
		if (clickedNodeIndex !== undefined) {
			if (clickedNodeIndex !== null) {
				this._setFocusedIndex(clickedNodeIndex);
				this._activateFocusedNode();
			}
			return true;
		}

		// Vertical-graph navigation: up/down step between depth levels
		// (col), left/right step between siblings at the same depth (row).
		// j/k preserved as a flat-order fallback for muscle memory.
		if (matchesKey(data, Key.down)) return this._moveByDepth(+1);
		if (matchesKey(data, Key.up)) return this._moveByDepth(-1);
		if (matchesKey(data, Key.right)) return this._moveBySibling(+1);
		if (matchesKey(data, Key.left)) return this._moveBySibling(-1);
		if (matchesKey(data, "j")) {
			this._setFocusedIndex(Math.min(this.focusedIndex + 1, stageCount - 1));
			return true;
		}
		if (matchesKey(data, "k")) {
			this._setFocusedIndex(Math.max(this.focusedIndex - 1, 0));
			return true;
		}
		if (matchesKey(data, "g")) {
			const now = Date.now();
			if (this._lastGTime != null && now - this._lastGTime < 500) {
				this._setFocusedIndex(0);
				this._lastGTime = null;
			} else {
				this._lastGTime = now;
			}
			return true;
		}
		if (matchesKey(data, "/") && !this._keyShadowed("/")) {
			this._disarmStop();
			this.switcherOpen = true;
			this.switcherState = { query: "", selectedIndex: 0 };
			return true;
		}
		if (matchesKey(data, Key.enter)) {
			this._disarmStop();
			this._activateFocusedNode();
			return true;
		}
		if (matchesKey(data, "o") && !this._navKeybindings()?.matches("o", APP_ACTION.keysHelp)) {
			this._disarmStop();
			return this._openRunDetail();
		}
		if (matchesKey(data, "f") && !this._keyShadowed("f")) {
			this._disarmStop();
			const next = (GRAPH_STATUS_FILTERS.indexOf(this.statusFilter) + 1) % GRAPH_STATUS_FILTERS.length;
			this.statusFilter = GRAPH_STATUS_FILTERS[next]!;
			return true;
		}
		if (this._matchesNavAction(data, APP_ACTION.listStop)) return this._handleStopInput(data);
		if (matchesKey(data, "d") && !this._keyShadowed("d") && this._focusedStageDetailsAvailable()) {
			this._disarmStop();
			this._openFocusedStageDetail(true);
			return true;
		}
		if (matchesKey(data, "p") && !this._keyShadowed("p") && this._runPausable()) {
			return this._handlePauseRunInput();
		}
		if (matchesKey(data, "r") && !this._keyShadowed("r") && this._runResumable()) {
			return this._handleResumeRunInput();
		}
		if (matchesKey(data, "q") && !this._keyShadowed("q") && this._runQuittable()) {
			return this._handleQuitRunInput();
		}
		if (matchesKey(data, "h") && this.onHide && !this._keyShadowed("h")) {
			this._disarmStop();
			this.onHide();
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this._disarmStop();
			this.onClose?.();
			return true;
		}
		return false;
	}

	private _handleSwitcherInput(data: string): boolean {
		const stages = this.cachedLayout.map((layoutNode) => layoutNode.stage);

		if (matchesKey(data, Key.escape)) {
			this.switcherOpen = false;
			return true;
		}
		if (matchesKey(data, Key.enter)) {
			const filtered = filterStages(stages, this.switcherState.query);
			const selected = filtered[this.switcherState.selectedIndex];
			if (selected) {
				const idx = this.cachedLayout.findIndex((n) => n.stage.id === selected.id);
				if (idx !== -1) {
					this._setFocusedIndex(idx);
					// Selecting from the switcher opens tool detail or preserves the
					// existing stage attach path; stages without an attach callback
					// retain their historical no-op behavior.
					this.switcherOpen = false;
					if (this.cachedLayout[idx]?.stage.nodeKind === "tool") this._openFocusedToolDetail();
					else this._attachFocusedStage();
					return true;
				}
			}
			this.switcherOpen = false;
			return true;
		}
		const wheelEvent = parseTerminalMouseInput(data);
		const wheelDirection = wheelEvent ? terminalMouseWheelDirection(wheelEvent) : null;
		if (wheelDirection === "down") return this._moveSwitcherSelection(1);
		if (wheelDirection === "up") return this._moveSwitcherSelection(-1);
		if (wheelDirection !== null) return true;
		if (matchesKey(data, Key.down)) return this._moveSwitcherSelection(1);
		if (matchesKey(data, Key.up)) return this._moveSwitcherSelection(-1);
		if (matchesKey(data, Key.backspace)) {
			this.switcherState = {
				query: this.switcherState.query.slice(0, -1),
				selectedIndex: 0,
			};
			return true;
		}
		if (data.length === 1 && data >= " ") {
			this.switcherState = {
				query: this.switcherState.query + data,
				selectedIndex: 0,
			};
			return true;
		}
		return false;
	}

	private _moveSwitcherSelection(step: number): boolean {
		const stages = this.cachedLayout.map((layoutNode) => layoutNode.stage);
		const filtered = filterStages(stages, this.switcherState.query);
		const maxIndex = Math.max(0, filtered.length - 1);
		this.switcherState = {
			...this.switcherState,
			selectedIndex: Math.max(0, Math.min(this.switcherState.selectedIndex + step, maxIndex)),
		};
		return true;
	}

	private _moveByDepth(step: number): boolean {
		const navigation = this.cachedNavigation[this.focusedIndex];
		const next = step < 0 ? navigation?.up : navigation?.down;
		if (next !== undefined) this._setFocusedIndex(next);
		return true;
	}

	private _moveBySibling(step: number): boolean {
		const navigation = this.cachedNavigation[this.focusedIndex];
		const next = step < 0 ? navigation?.left : navigation?.right;
		if (next !== undefined) this._setFocusedIndex(next);
		return true;
	}

	protected _activateFocusedNode(): void {
		// Tool nodes open a read-only snapshot detail; they never enter the
		// stage-chat attach path even though they share the graph card shape.
		if (this._openFocusedToolDetail()) return;

		if (this._openFocusedStageDetail()) return;
		this._attachFocusedStage();
	}

	private _attachFocusedStage(): boolean {
		if (!this.onStageAttach) return false;
		const target = this._focusedStageChatTarget();
		if (!target) return false;
		this.onStageAttach(target.runId, target.stageId);
		return true;
	}

	private _setFocusedIndex(index: number): void {
		const max = Math.max(0, this.cachedLayout.length - 1);
		const next = Math.max(0, Math.min(index, max));
		if (next === this.focusedIndex) return;
		this._disarmStop();
		this.focusedIndex = next;
		this.pendingEnsureFocusedVisible = true;
	}
	private _scrollGraphVertically(deltaRows: number): void {
		this.pendingEnsureFocusedVisible = false;
		this.graphLayout.scrollView.scrollBy(deltaRows);
	}

	private _handleWheelDelta(delta: MouseWheelDelta): boolean {
		if (delta.rows !== 0) this._scrollGraphVertically(delta.rows);
		if (delta.cols !== 0) this._scrollGraphHorizontallyBy(delta.cols);
		return true;
	}

	private _scrollGraphHorizontallyBy(deltaCols: number): void {
		this.pendingEnsureFocusedVisible = false;
		this.graphScrollColOffset = Math.max(0, this.graphScrollColOffset + deltaCols);
	}

	private _graphNodeIndexForClick(data: string): number | null | undefined {
		const click = this._sgrLeftMousePress(data);
		if (!click) return undefined;
		if (this.mode !== "overlay") return undefined;
		if (this.cachedLayout.length === 0) return null;

		for (const rect of this.graphNodeHitRects) {
			if (click.row >= rect.top && click.row < rect.bottom && click.col >= rect.left && click.col < rect.right) {
				return rect.index;
			}
		}
		return null;
	}
	private _sgrLeftMousePress(data: string): { col: number; row: number } | null {
		const event = parseTerminalMouseInput(data);
		if (event?.protocol !== "sgr" || !isTerminalLeftMousePress(event)) return null;
		return { col: event.col, row: event.row };
	}

	private _mouseWheelDelta(data: string): MouseWheelDelta | null {
		const event = parseTerminalMouseInput(data);
		if (!event) return null;
		const direction = terminalMouseWheelDirection(event);
		if (direction === "up") return { cols: 0, rows: -GRAPH_SCROLL_WHEEL_LINES };
		if (direction === "down") return { cols: 0, rows: GRAPH_SCROLL_WHEEL_LINES };
		if (direction === "left") return { cols: -GRAPH_SCROLL_STEP_COLS, rows: 0 };
		if (direction === "right") return { cols: GRAPH_SCROLL_STEP_COLS, rows: 0 };
		return null;
	}

	get _graphScrollbarGeometry() {
		this._syncLayout();
		return this.graphLayout.scrollbarGeometry;
	}

	get _toolDetail(): typeof this.toolDetail {
		this._syncLayout();
		return this.toolDetail;
	}
	get _toolDetailExpanded(): boolean {
		this._syncLayout();
		return this.toolDetailExpanded;
	}

	// ---- test seams (read the layout as the next frame would) ----
	get _focusedIndex(): number {
		this._syncLayout();
		return this.focusedIndex;
	}
	get _switcherOpen(): boolean {
		this._syncLayout();
		return this.switcherOpen;
	}
	get _switcherState(): SwitcherState {
		this._syncLayout();
		return this.switcherState;
	}
	get _graphScrollOffset(): number {
		this._syncLayout();
		return this._graphScrollTop();
	}
	get _graphScrollColOffset(): number {
		this._syncLayout();
		return this.graphScrollColOffset;
	}
}
