import { TwoPressConfirm } from "@bastani/atomic";
import { GRAPH_SCROLL_STEP_COLS } from "./graph-view-constants.js";
import { GraphViewRenderer } from "./graph-view-render.js";
import { GRAPH_STATUS_FILTERS } from "./graph-view-state.js";
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
/** How long an action's result stays on the hint line. */
const GRAPH_NOTICE_MS = 4000;

/** Keyboard, mouse, switcher, prompt, and focus navigation handling. */
export abstract class GraphViewInputController extends GraphViewRenderer {
	/** Returns true if consumed. */
	handleInput(data: string): boolean {
		this._syncLayout();
		if (this.keysHelpOpen) return this._handleKeysHelpInput(data);
		if (this.switcherOpen) return this._handleSwitcherInput(data);
		if (this._matchesNavAction(data, APP_ACTION.keysHelp)) {
			this.keysHelpOpen = true;
			return true;
		}
		if (this.toolDetail !== null) return this._handleToolDetailInput(data);
		if (this.stageDetail !== null) return this._handleStageDetailInput(data);
		if (this.runDetail !== null) return this._handleRunDetailInput(data);
		if (this._isGraphBackInput(data)) {
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
		// Esc closes the detail view; the back key, one level up, returns to the graph too.
		if (matchesKey(data, Key.escape) || this._matchesNavAction(data, APP_ACTION.navBack)) {
			this._closeToolDetail();
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose?.();
			return true;
		}
		if (matchesKey(data, "h") && this.onHide) {
			this.onHide();
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

	/** The `?` overlay is open: Esc or `?` closes it, and every other key waits for it to close. */
	private _handleKeysHelpInput(data: string): boolean {
		if (matchesKey(data, Key.escape) || this._matchesNavAction(data, APP_ACTION.keysHelp)) this.keysHelpOpen = false;
		else if (matchesKey(data, Key.ctrl("c"))) {
			this.keysHelpOpen = false;
			this.onClose?.();
		}
		return true;
	}

	/** A failed stage's detail: retry, fork, transcript and logs, and the way back to the graph. */
	private _handleStageDetailInput(data: string): boolean {
		const detail = this.stageDetail;
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
		if (matchesKey(data, Key.escape) || this._matchesNavAction(data, APP_ACTION.navBack)) {
			this._closeStageDetail();
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose?.();
			return true;
		}
		const name = this._stageDetailStage()?.name ?? detail.stageId;
		if (matchesKey(data, "r") && this.stageActions?.retry) {
			this._runStageAction(this.stageActions.retry(detail.runId, detail.stageId), `Retrying ${name}\u2026`);
			return true;
		}
		if (matchesKey(data, "f") && this.stageActions?.fork) {
			this._runStageAction(this.stageActions.fork(detail.runId, detail.stageId), `Forking the run\u2026`);
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
		if (matchesKey(data, Key.down)) this._scrollGraphVertically(1);
		else if (matchesKey(data, Key.up)) this._scrollGraphVertically(-1);
		else if (matchesKey(data, Key.pageDown)) this._scrollGraphVertically(this._toolDetailPageRows());
		else if (matchesKey(data, Key.pageUp)) this._scrollGraphVertically(-this._toolDetailPageRows());
		return true;
	}

	/** The run details: ↑↓ pick a blocker, Enter opens it, `l` toggles the full log, Esc or ← go back to the graph. */
	private _handleRunDetailInput(data: string): boolean {
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
		if (matchesKey(data, Key.escape) || this._matchesNavAction(data, APP_ACTION.navBack)) {
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
		if (blockers.length > 0) {
			if (matchesKey(data, Key.down)) {
				detail.selected = Math.min(blockers.length - 1, detail.selected + 1);
				this.runDetailRevealSelected = true;
				return true;
			}
			if (matchesKey(data, Key.up)) {
				detail.selected = Math.max(0, detail.selected - 1);
				this.runDetailRevealSelected = true;
				return true;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
				const blocker = blockers[Math.min(detail.selected, blockers.length - 1)]!;
				if (this._focusBlockerNode(blocker.node, blocker.id)) this._activateFocusedNode();
				return true;
			}
		}
		if (matchesKey(data, Key.down)) this._scrollGraphVertically(1);
		else if (matchesKey(data, Key.up)) this._scrollGraphVertically(-1);
		else if (matchesKey(data, Key.pageDown)) this._scrollGraphVertically(this._toolDetailPageRows());
		else if (matchesKey(data, Key.pageUp)) this._scrollGraphVertically(-this._toolDetailPageRows());
		return true;
	}

	/** Show an action's progress, then its result, on the hint line; a new run the action started is shown. */
	private _runStageAction(result: Promise<GraphStageActionResult>, progress: string): void {
		this.graphNotice = { text: progress, tone: "info", until: Date.now() + 60_000 };
		void result.then(
			(outcome) => {
				this.graphNotice = {
					text: outcome.message,
					tone: outcome.ok ? "info" : "error",
					until: Date.now() + GRAPH_NOTICE_MS,
				};
				if (outcome.ok && outcome.runId !== undefined) {
					this._closeStageDetail();
					this.onShowRun?.(outcome.runId);
				}
				this.requestRender?.();
			},
			(error: unknown) => {
				this.graphNotice = {
					text: error instanceof Error ? error.message : String(error),
					tone: "error",
					until: Date.now() + GRAPH_NOTICE_MS,
				};
				this.requestRender?.();
			},
		);
	}

	/** `x x` on a working stage stops it so it can be resumed; the first press only says what the second will do. */
	private _handleStopInput(): boolean {
		const stage = this.cachedLayout[this.focusedIndex]?.stage;
		const target = this._stageChatTarget(stage);
		if (!this._focusedStageStoppable() || stage === undefined || target === undefined) return true;
		const key = `${target.runId}\u0000${target.stageId}`;
		if (!this.stopConfirm.press(key)) {
			this.graphNotice = {
				text: `Press x again within 3s to stop ${stage.name}`,
				tone: "info",
				until: Date.now() + 3000,
			};
			return true;
		}
		this.graphNotice = null;
		const stop = this.stageActions?.stop;
		if (stop) this._runStageAction(stop(target.runId, target.stageId), `Stopping ${stage.name}\u2026`);
		return true;
	}

	private readonly stopConfirm = new TwoPressConfirm();

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

	/**
	 * The graph has no prompt, so Esc pops it one level: back to where it was opened from. The back key does the same
	 * on a node with nothing to its left; elsewhere it moves between nodes.
	 */
	private _isGraphBackInput(data: string): boolean {
		if (matchesKey(data, Key.escape)) return true;
		return this._matchesNavAction(data, APP_ACTION.navBack) && !this._hasSiblingBefore();
	}

	private _leaveGraph(): void {
		this.stopConfirm.reset();
		if (this.onDetach) this.onDetach();
		else this.onHide?.();
	}

	private _handleGraphInput(data: string): boolean {
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
		if (matchesKey(data, "/")) {
			this.switcherOpen = true;
			this.switcherState = { query: "", selectedIndex: 0 };
			return true;
		}
		if (matchesKey(data, Key.enter)) {
			this._activateFocusedNode();
			return true;
		}
		if (matchesKey(data, "o")) return this._openRunDetail();
		if (matchesKey(data, "f")) {
			const next = (GRAPH_STATUS_FILTERS.indexOf(this.statusFilter) + 1) % GRAPH_STATUS_FILTERS.length;
			this.statusFilter = GRAPH_STATUS_FILTERS[next]!;
			return true;
		}
		if (this._matchesNavAction(data, APP_ACTION.listStop)) return this._handleStopInput();
		if (matchesKey(data, "h") && this.onHide) {
			this.onHide();
			return true;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
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

	/**
	 * Move focus to the nearest node `step` depth-levels away (↑/↓).
	 * Picks the sibling with the closest `row` to the current node so
	 * navigation feels spatially continuous in the vertical layout.
	 */
	private _moveByDepth(step: number): boolean {
		const cur = this.cachedLayout[this.focusedIndex];
		if (!cur) return true;
		const targetCol = cur.col + step;
		const candidates = this.cachedLayout.map((n, i) => ({ n, i })).filter(({ n }) => n.col === targetCol);
		if (candidates.length === 0) return true;
		let best = candidates[0]!;
		let bestDist = Math.abs(best.n.row - cur.row);
		for (const c of candidates) {
			const d = Math.abs(c.n.row - cur.row);
			if (d < bestDist) {
				best = c;
				bestDist = d;
			}
		}
		this._setFocusedIndex(best.i);
		return true;
	}

	/**
	 * Move focus to the next sibling at the same depth (←/→). Clamps
	 * at the band edges — no wrap, so the user always knows when they
	 * hit a boundary.
	 */
	private _moveBySibling(step: number): boolean {
		const cur = this.cachedLayout[this.focusedIndex];
		if (!cur) return true;
		const siblings = this.cachedLayout
			.map((n, i) => ({ n, i }))
			.filter(({ n }) => n.col === cur.col)
			.sort((a, b) => a.n.row - b.n.row);
		const pos = siblings.findIndex(({ i }) => i === this.focusedIndex);
		if (pos === -1) return true;
		const next = siblings[pos + step];
		if (!next) return true;
		this._setFocusedIndex(next.i);
		return true;
	}

	protected _activateFocusedNode(): void {
		// Tool nodes open a read-only snapshot detail; they never enter the
		// stage-chat attach path even though they share the graph card shape.
		if (this._openFocusedToolDetail()) return;
		// A failed stage opens its failure detail first: the reason, then retry, fork, transcript and logs.
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
		this.stopConfirm.reset();
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
