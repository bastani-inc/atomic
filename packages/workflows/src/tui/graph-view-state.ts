import type { ReadonlyFooterDataProvider } from "@bastani/atomic";
import {
	type ExpandedWorkflowGraph,
	type ExpandedWorkflowStage,
	type ExpandedWorkflowStageTarget,
	type ExpandedWorkflowTool,
	expandedStageTarget,
	expandWorkflowGraph,
} from "../shared/expanded-workflow-graph.js";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import type { Store } from "../shared/store.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { RunSnapshot, StageSnapshot, StoreSnapshot } from "../shared/store-types.js";
import { buildGraphEdgeIndex, type GraphEdgeIndex, type GraphRenderEdge } from "./graph-edge-index.js";
import { buildGraphNavigation, type GraphNodeNavigation } from "./graph-navigation.js";
import type { GraphTheme } from "./graph-theme.js";
import { ANIMATION_TICK_MS } from "./graph-view-constants.js";
import type { GraphStageActions, GraphViewMode, GraphViewOpts } from "./graph-view-types.js";
import { computeLayout, type LayoutNode, NODE_H, NODE_W } from "./layout.js";
import { nodeCardHeight } from "./node-card.js";
import { buildRunOutcome, type RunOutcome, type RunOutcomeBlocker } from "./run-outcome.js";
import { isQuitRun } from "./run-state-indicator.js";
import { stageFailureReason } from "./stage-failure-detail.js";
import type { SwitcherState } from "./switcher.js";

export const GRAPH_STATUS_FILTERS = ["all", "running", "stopped", "completed", "failed"] as const;
export type GraphStatusFilter = (typeof GRAPH_STATUS_FILTERS)[number];

export function stageMatchesStatusFilter(stage: StageSnapshot, filter: GraphStatusFilter): boolean {
	switch (filter) {
		case "all":
			return true;
		case "running":
			return stage.status === "running" || stage.status === "awaiting_input" || stage.status === "blocked";
		case "stopped":
			return stage.status === "paused" || stage.status === "suspended" || stage.toolStatus === "cancelled";
		case "completed":
			return stage.status === "completed";
		case "failed":
			return stage.status === "failed";
	}
}

export interface GraphNotice {
	readonly text: string;
	readonly tone: "info" | "error";
	readonly until: number;

	readonly arm?: boolean;
}

export interface GraphStageDetail {
	readonly runId: string;
	readonly stageId: string;

	readonly nodeId: string;
	readonly status: "failed" | "completed";

	logs: boolean;
}

export interface GraphRunDetail {
	logs: boolean;
	selected: number;
	selectedKey?: string;
}

export function blockerKey(blocker: RunOutcomeBlocker): string {
	return `${blocker.node}:${blocker.id}`;
}

export interface GraphStageCounts {
	pending: number;
	running: number;
	awaiting_input: number;
	paused: number;
	blocked: number;
	suspended: number;
	completed: number;
	failed: number;
	skipped: number;
}

interface GraphNodeHitRect {
	index: number;
	top: number;
	bottom: number;
	left: number;
	right: number;
}

interface GraphViewportGeometry {
	leftMargin: number;
	viewportWidth: number;
}

interface GraphLayoutBand {
	top: number;
	bottom: number;
	nodeIndices: number[];
	nodeLefts: number[];
}

interface GraphRenderGeometry {
	canvasWidth: number;
	totalRows: number;
	bands: GraphLayoutBand[];
	edges: GraphRenderEdge[];
	edgeIndex: GraphEdgeIndex;
}

/** Expansion, focus, prompt, and store-backed layout state for GraphView. */
export abstract class GraphViewState {
	protected disposed = false;
	protected mode: GraphViewMode;
	protected runId: string | null;
	protected store: Store;
	protected graphTheme: GraphTheme;
	protected onClose?: () => void;
	protected onHide?: () => void;
	protected onStageAttach?: (runId: string, stageId: string) => void;
	protected onDetach?: () => void;
	protected stageActions?: GraphStageActions;
	protected onShowRun?: GraphViewOpts["onShowRun"];

	protected forkConfirm: { rootRunId: string; stageId: string; name: string } | null = null;
	protected quitConfirmTarget: { readonly runId: string; readonly status: string; readonly until: number } | null =
		null;

	protected retryWatch: { nodeId: string; failedAt: number | undefined; sawRetry: boolean } | null = null;
	protected initialFocusedStageId?: string;
	protected initialFocusedRunId?: string;
	protected piTui?: GraphViewOpts["piTui"];
	protected requestRender?: () => void;
	protected piKeybindings?: unknown;
	protected footerData?: ReadonlyFooterDataProvider;
	protected getStageQueuedMessageCount?: (runId: string, stageId: string, snapshotCount: number) => number;
	private getQueuedStageSignature?: GraphViewOpts["getQueuedStageSignature"];
	private queuedSignature: string | undefined;

	protected focusedIndex = 0;
	protected switcherOpen = false;
	protected switcherState: SwitcherState = { query: "", selectedIndex: 0 };
	protected detailsExpanded = true;
	protected cachedLayout: LayoutNode[] = [];
	protected cachedNavigation: readonly GraphNodeNavigation[] = [];
	/** Stages mirrored from `cachedLayout` — shared across card renders. */
	protected cachedDisplayStages: StageSnapshot[] = [];
	protected expandedGraph: ExpandedWorkflowGraph = {
		stages: [],
		renderStages: [],
		tools: [],
		nodes: [],
		targets: new Map(),
	};
	protected currentSnapshot: StoreSnapshot | null = null;
	/** Selected read-only tool detail; tool nodes never become stage chats. */
	protected toolDetail: ExpandedWorkflowTool | null = null;
	/** Tool message blocks open collapsed and own expansion independently of graph cards. */
	protected toolDetailExpanded = false;

	protected stageDetail: GraphStageDetail | null = null;
	protected runDetail: GraphRunDetail | null = null;
	protected runDetailReturn: GraphRunDetail | null = null;
	protected runDetailRevealSelected = false;
	protected paintedView: "tool" | "stage" | "run" | "graph" = "graph";
	protected paintedBlockerKey: string | null = null;
	private runOutcomeCache: {
		readonly run: RunSnapshot;
		readonly snapshot: StoreSnapshot | null;
		readonly outcome: RunOutcome;
	} | null = null;
	protected statusFilter: GraphStatusFilter = "all";

	protected keysHelpOpen = false;

	protected graphNotice: GraphNotice | null = null;
	protected abstract _graphScrollTop(): number;
	protected graphScrollColOffset = 0;
	protected graphNodeHitRects: GraphNodeHitRect[] = [];
	protected lastGraphViewport: GraphViewportGeometry | null = null;
	protected lastGraphTopPad = 0;
	protected lastGraphVisibleRows = 0;
	protected pendingEnsureFocusedVisible = true;
	protected lastAutoFocusedAwaitingInputKey: string | null = null;
	protected lastBuiltSnapshotVersion: number | null = null;
	protected hasAnimatingStages = false;
	protected cachedRenderGeometry: GraphRenderGeometry = {
		canvasWidth: 0,
		totalRows: 0,
		bands: [],
		edges: [],
		edgeIndex: { bands: [] },
	};

	protected _intervalId: ReturnType<typeof setInterval> | null = null;
	protected _lastGTime: number | null = null;
	protected _unsubscribe: (() => void) | null = null;
	/** A store change arrived since the layout was last built. */
	private storeChanged = false;
	/** `invalidate()` was called since the layout was last built. */
	private layoutInvalidated = false;

	constructor(opts: GraphViewOpts) {
		this.mode = opts.mode;
		this.runId = opts.runId;
		this.store = opts.store;
		this.graphTheme = opts.graphTheme;
		this.onClose = opts.onClose;
		this.onHide = opts.onHide;
		this.onStageAttach = opts.onStageAttach;
		this.onDetach = opts.onDetach;
		this.stageActions = opts.stageActions;
		this.onShowRun = opts.onShowRun;
		if (opts.carry?.notice) this.graphNotice = { ...opts.carry.notice, until: Date.now() + 4000 };
		this.initialFocusedStageId = opts.initialFocusedStageId ?? opts.carry?.focusStageId;
		this.initialFocusedRunId = opts.initialFocusedRunId;
		this.piTui = opts.piTui;
		this.requestRender = opts.requestRender;
		this.piKeybindings = opts.piKeybindings;
		this.footerData = opts.footerData;
		this.getStageQueuedMessageCount = opts.getStageQueuedMessageCount;
		this.getQueuedStageSignature = opts.getQueuedStageSignature;

		// Store changes only mark the layout stale; it is rebuilt once when next read (#4009).
		this._unsubscribe = subscribeStoreInvalidation(this.store, () => {
			this.storeChanged = true;
		});
		this.currentSnapshot = readGraphStoreSnapshot(this.store);
		this._rebuildLayout();

		// Animation tick: while the overlay is mounted, fire a render
		// request every `ANIMATION_TICK_MS` so the duration counter on
		// each running stage advances and the border-pulse lerp animates
		// even when the user isn't pressing keys. Only overlay mode owns
		// visible animations; widget mode renders a single status line
		// that never needs a steady cadence. The host's `requestRender`
		// is responsible for gating on overlay visibility / focus — see
		// `overlay-adapter.ts` and `workflow-attach-pane.ts`. With that
		// gate in place the previous tmux scrollback "ghost overlay"
		// failure mode does not apply: pi-tui owns the screen buffer
		// and diff-blits frames in place.
		//
		// Skip ticks when nothing is animating (#2100): a large completed
		// or pending-only graph must not burn ~10 full paints/sec.
		if (this.mode === "overlay" && this.requestRender) {
			this._intervalId = setInterval(() => {
				if (!this._needsAnimationTick()) return;
				this.requestRender?.();
			}, ANIMATION_TICK_MS);
			(this._intervalId as { unref?: () => void }).unref?.();
		}
	}

	protected _needsAnimationTick(): boolean {
		this._syncLayout();

		return this.hasAnimatingStages || (this.graphNotice !== null && Date.now() > this.graphNotice.until);
	}

	/**
	 * Brings the layout up to the store's current snapshot, if a store change or an invalidation
	 * arrived since it was last built. A pooled fan-out publishes hundreds of store changes in one
	 * turn of the event loop; rebuilding the layout for each of them made every change cost the
	 * whole graph (#4009), so the layout is rebuilt only where it is read: rendering, input, the
	 * animation tick and the test seams.
	 */
	protected _syncLayout(): void {
		if (!this.storeChanged && !this.layoutInvalidated) return;
		if (this.storeChanged) this.currentSnapshot = readGraphStoreSnapshot(this.store);
		this.storeChanged = false;
		this.layoutInvalidated = false;
		this._rebuildLayout();
	}

	private _nodeHeight(stage: StageSnapshot): number {
		const baseHeight = nodeCardHeight(stage);
		// A badge that fits existing space cannot affect layout. Keep queue reads
		// viewport-bound for those cards instead of fetching them during sizing.
		if (!this.getStageQueuedMessageCount || nodeCardHeight(stage, { queuedMessageCount: 1 }) === baseHeight) {
			return baseHeight;
		}
		return nodeCardHeight(stage, { queuedMessageCount: this._stageQueuedMessageCount(stage) });
	}

	protected _refreshQueuedNodeHeights(): void {
		const signature = this.getQueuedStageSignature?.(this.currentSnapshot);
		if (signature === undefined || signature === this.queuedSignature) return;
		this.lastBuiltSnapshotVersion = null;
		this._rebuildLayout();
	}

	protected _rebuildLayout(): void {
		const version = this.currentSnapshot?.version ?? null;
		// Overlay adapter calls `invalidate()` after GraphView's own store
		// subscriber already rebuilt for this snapshot — skip the duplicate.
		if (version !== null && version === this.lastBuiltSnapshotVersion) {
			this._refreshQueuedNodeHeights();
			return;
		}

		this.queuedSignature = this.getQueuedStageSignature?.(this.currentSnapshot);
		const run = this._getCurrentRun();
		if (!run) {
			this.cachedLayout = [];
			this.cachedNavigation = [];
			this.cachedDisplayStages = [];
			this.cachedRenderGeometry = { canvasWidth: 0, totalRows: 0, bands: [], edges: [], edgeIndex: { bands: [] } };
			this.expandedGraph = { stages: [], renderStages: [], tools: [], nodes: [], targets: new Map() };
			this.focusedIndex = 0;
			this.switcherOpen = false;
			this.switcherState = { query: "", selectedIndex: 0 };
			this.keysHelpOpen = false;
			this.graphScrollColOffset = 0;
			this.graphNodeHitRects = [];
			this.lastGraphViewport = null;
			this.pendingEnsureFocusedVisible = true;
			this.runDetail = null;
			this.runDetailReturn = null;
			this.runDetailRevealSelected = false;
			this.toolDetail = null;
			this.toolDetailExpanded = false;
			this._clearQuitConfirmTarget();
			this._closeStageDetail();
			this.hasAnimatingStages = false;
			this.lastBuiltSnapshotVersion = version;
			return;
		}

		const previousFocusedStageId = this.cachedLayout[this.focusedIndex]?.stage.id;
		const graphStages = this._graphStages(run);
		const sameTopology =
			this.cachedLayout.length === graphStages.length &&
			this.cachedLayout.length > 0 &&
			this.cachedLayout.every((node, index) => {
				const next = graphStages[index];
				if (!next || node.stage.id !== next.id || node.stage.nodeKind !== next.nodeKind) return false;
				if ((node.height ?? NODE_H) !== this._nodeHeight(next)) return false;
				if (node.stage.parentIds.length !== next.parentIds.length) return false;
				return node.stage.parentIds.every((parentId, parentIndex) => parentId === next.parentIds[parentIndex]);
			});

		if (sameTopology) {
			for (let index = 0; index < this.cachedLayout.length; index++) {
				this.cachedLayout[index]!.stage = graphStages[index]!;
			}
			this.cachedDisplayStages = [...graphStages];
			this.hasAnimatingStages = graphStages.some(
				(stage) => stage.status === "running" || stage.status === "awaiting_input",
			);
			this._finalizeFocus(previousFocusedStageId, true);
			this._syncToolDetail(run);
			this.lastBuiltSnapshotVersion = version;
			return;
		}

		const nextLayout = computeLayout(graphStages, {
			orientation: "vertical",
			nodeHeight: (stage) => this._nodeHeight(stage),
		});
		this.cachedLayout = nextLayout;
		this.cachedNavigation = buildGraphNavigation(nextLayout);
		this.cachedDisplayStages = nextLayout.map((node) => node.stage);
		this.cachedRenderGeometry = this._buildRenderGeometry(nextLayout);
		this.hasAnimatingStages = graphStages.some(
			(stage) => stage.status === "running" || stage.status === "awaiting_input",
		);
		this.graphNodeHitRects = [];
		this.lastGraphViewport = null;
		this._finalizeFocus(previousFocusedStageId, false);
		this._syncToolDetail(run);
		this.lastBuiltSnapshotVersion = version;
	}

	private _buildRenderGeometry(layout: readonly LayoutNode[]): GraphRenderGeometry {
		let canvasWidth = 0;
		let totalRows = 0;
		const nodeByStageId = new Map<string, LayoutNode>();
		const bandsByTop = new Map<number, GraphLayoutBand>();
		for (let index = 0; index < layout.length; index++) {
			const node = layout[index]!;
			canvasWidth = Math.max(canvasWidth, node.x + NODE_W);
			const bottom = node.y + (node.height ?? NODE_H);
			totalRows = Math.max(totalRows, bottom);
			nodeByStageId.set(node.stage.id, node);
			const band = bandsByTop.get(node.y);
			if (band) {
				band.nodeIndices.push(index);
				band.bottom = Math.max(band.bottom, bottom);
			} else bandsByTop.set(node.y, { top: node.y, bottom, nodeIndices: [index], nodeLefts: [] });
		}

		const edges: GraphRenderEdge[] = [];
		for (const node of layout) {
			for (const parentId of node.stage.parentIds) {
				const parent = nodeByStageId.get(parentId);
				if (!parent) continue;
				const parentCol = parent.x + Math.floor(NODE_W / 2);
				const childCol = node.x + Math.floor(NODE_W / 2);
				edges.push({
					parentX: parent.x,
					parentY: parent.y,
					parentHeight: parent.height ?? NODE_H,
					childX: node.x,
					childY: node.y,
					top: parent.y + (parent.height ?? NODE_H),
					bottom: node.y,
					left: Math.min(parentCol, childCol),
					right: Math.max(parentCol, childCol) + 1,
				});
			}
		}
		return {
			canvasWidth,
			totalRows,
			bands: [...bandsByTop.values()]
				.sort((left, right) => left.top - right.top)
				.map((band) => {
					band.nodeIndices.sort((a, b) => layout[a]!.x - layout[b]!.x);
					band.nodeLefts = band.nodeIndices.map((index) => layout[index]!.x);
					return band;
				}),
			edges,
			edgeIndex: buildGraphEdgeIndex(edges),
		};
	}

	protected *_visibleBandNodeIndices(band: GraphLayoutBand, left: number, right: number): Generator<number> {
		let low = 0;
		let high = band.nodeLefts.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (band.nodeLefts[middle]! + NODE_W <= left) low = middle + 1;
			else high = middle;
		}
		for (let index = low; index < band.nodeIndices.length && band.nodeLefts[index]! < right; index++) {
			yield band.nodeIndices[index]!;
		}
	}

	protected _firstVisibleLayoutBand(viewportTop: number): number {
		const bands = this.cachedRenderGeometry.bands;
		let low = 0;
		let high = bands.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (bands[middle]!.bottom <= viewportTop) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	protected _finalizeFocus(previousFocusedStageId: string | undefined, preserveHitRects: boolean): void {
		let focusNeedsReveal = this.pendingEnsureFocusedVisible;
		// One-shot: if the host passed `initialFocusedStageId`, snap the
		// cursor to that stage now that the layout exists. The attach shell
		// uses this when swapping back from chat mode so the focus lands on
		// the same node the user just attached to.
		if (this.initialFocusedStageId !== undefined) {
			const idx = this.cachedLayout.findIndex((node) => {
				const target = expandedStageTarget(this.expandedGraph, node.stage.id);
				if (this.initialFocusedRunId === undefined) {
					return node.stage.id === this.initialFocusedStageId || target?.stageId === this.initialFocusedStageId;
				}
				return (
					target !== undefined &&
					target.stageId === this.initialFocusedStageId &&
					target.runId === this.initialFocusedRunId
				);
			});
			if (idx >= 0 && idx !== this.focusedIndex) {
				this.focusedIndex = idx;
				focusNeedsReveal = true;
			}
			this.initialFocusedStageId = undefined;
			this.initialFocusedRunId = undefined;
		} else if (previousFocusedStageId !== undefined) {
			const idx = this.cachedLayout.findIndex((n) => n.stage.id === previousFocusedStageId);
			if (idx >= 0 && idx !== this.focusedIndex) {
				this.focusedIndex = idx;
				focusNeedsReveal = true;
			}
		}

		const awaitingTarget = this._awaitingInputFocusTarget();
		if (awaitingTarget) {
			if (awaitingTarget.key !== this.lastAutoFocusedAwaitingInputKey) {
				this.focusedIndex = awaitingTarget.index;
				focusNeedsReveal = true;
				this.lastAutoFocusedAwaitingInputKey = awaitingTarget.key;
			}
		} else {
			this.lastAutoFocusedAwaitingInputKey = null;
		}

		if (this.cachedLayout.length === 0) {
			this.focusedIndex = 0;
			this.graphScrollColOffset = 0;
		} else if (this.focusedIndex >= this.cachedLayout.length) {
			this.focusedIndex = this.cachedLayout.length - 1;
			focusNeedsReveal = true;
		}
		this.pendingEnsureFocusedVisible = focusNeedsReveal;
		if (!preserveHitRects && focusNeedsReveal) {
			this.graphNodeHitRects = [];
			this.lastGraphViewport = null;
		}
	}

	protected _awaitingInputFocusTarget(): { index: number; key: string } | null {
		let newest: { index: number; key: string; createdAt: number } | null = null;
		for (let index = 0; index < this.cachedLayout.length; index++) {
			const stage = this.cachedLayout[index]!.stage;
			const target = this._awaitingInputKey(stage);
			if (!target) continue;
			if (!newest || target.createdAt >= newest.createdAt) {
				newest = { index, key: target.key, createdAt: target.createdAt };
			}
		}
		return newest ? { index: newest.index, key: newest.key } : null;
	}

	protected _awaitingInputKey(stage: StageSnapshot): { key: string; createdAt: number } | null {
		const target = expandedStageTarget(this.expandedGraph, stage.id);
		const prefix = target ? `${target.runId}:${target.stageId}` : stage.id;
		if (stage.pendingPrompt) {
			return {
				key: `prompt:${prefix}:${stage.pendingPrompt.id}`,
				createdAt: stage.pendingPrompt.createdAt,
			};
		}
		if (stage.inputRequest) {
			return {
				key: `input-request:${prefix}:${stage.inputRequest.id}`,
				createdAt: stage.inputRequest.createdAt,
			};
		}
		if (stage.status === "awaiting_input") {
			return {
				key: `awaiting:${prefix}:${stage.awaitingInputSince ?? "active"}`,
				createdAt: stage.awaitingInputSince ?? stage.startedAt ?? 0,
			};
		}
		return null;
	}

	protected _graphStages(run: RunSnapshot): ExpandedWorkflowStage[] {
		const snapshot = this.currentSnapshot;
		if (!snapshot) return [];
		this.expandedGraph = expandWorkflowGraph(snapshot, run.id);
		const stages = [...this.expandedGraph.renderStages];
		const hasStagePrompt = stages.some(
			(stage) =>
				stage.pendingPrompt !== undefined ||
				(stage.status === "awaiting_input" && stage.promptFootprint?.kind === "custom"),
		);
		if (!hasStagePrompt) return stages;
		return stages.filter((stage) => {
			const isUnstartedPlaceholder =
				stage.status === "pending" &&
				stage.startedAt === undefined &&
				stage.pendingPrompt === undefined &&
				stage.toolEvents.length === 0;
			return !isUnstartedPlaceholder;
		});
	}

	/** Stage-only control target shared by hints and activation. */
	protected _stageChatTarget(stage: StageSnapshot | undefined): ExpandedWorkflowStageTarget | undefined {
		if (!stage || stage.nodeKind === "tool") return undefined;
		return expandedStageTarget(this.expandedGraph, stage.id);
	}
	/** Resolve the focused graph projection back to its full tool snapshot. */
	protected _focusedTool(): ExpandedWorkflowTool | undefined {
		const stage = this.cachedLayout[this.focusedIndex]?.stage;
		if (stage?.nodeKind !== "tool") return undefined;
		return this.expandedGraph.tools.find((tool) => tool.id === stage.id);
	}

	protected _openFocusedToolDetail(): boolean {
		const tool = this._focusedTool();
		if (tool === undefined) return false;
		this.toolDetail = tool;
		this.toolDetailExpanded = false;
		this.graphLayoutInvalidateForDetail();
		return true;
	}

	protected _closeToolDetail(): boolean {
		if (this.toolDetail === null) return false;
		this.toolDetail = null;
		this.toolDetailExpanded = false;
		this._returnToRunDetail();
		this.graphLayoutInvalidateForDetail();
		return true;
	}

	private _syncToolDetail(run?: RunSnapshot | null): void {
		this._isQuitArmed(run);
		if (this.stageDetail !== null && this._stageDetailStage()?.status !== this.stageDetail.status) {
			this._closeStageDetail();
		}
		this._syncRetryWatch();
		if (this.toolDetail === null) return;
		const nextTool = this.expandedGraph.tools.find((tool) => tool.id === this.toolDetail?.id) ?? null;
		if (nextTool === null) {
			this._closeToolDetail();
			return;
		}
		this.toolDetail = nextTool;
	}

	protected _focusedStageDetailsAvailable(
		stage: StageSnapshot | undefined = this.cachedLayout[this.focusedIndex]?.stage,
	): boolean {
		if (stage === undefined || this._stageChatTarget(stage) === undefined) return false;
		return stage.status === "failed" || stage.status === "completed";
	}

	protected _openFocusedStageDetail(allowCompleted = false): boolean {
		const stage = this.cachedLayout[this.focusedIndex]?.stage;
		if (stage === undefined) return false;
		if (stage.status !== "failed" && (!allowCompleted || stage.status !== "completed")) return false;
		const target = this._stageChatTarget(stage);
		if (target === undefined) return false;
		this.stageDetail = {
			runId: target.runId,
			stageId: target.stageId,
			nodeId: stage.id,
			status: stage.status,
			logs: false,
		};
		this.graphLayoutInvalidateForDetail();
		return true;
	}

	protected _runOutcomeFor(run: RunSnapshot): RunOutcome {
		const snapshot = this.currentSnapshot;
		const cached = this.runOutcomeCache;
		if (cached !== null && cached.run === run && cached.snapshot === snapshot) return cached.outcome;
		const fullResult = this.store.run(run.id)?.result;
		const outcomeRun = fullResult === undefined || fullResult === run.result ? run : { ...run, result: fullResult };
		const buildOutcome: (target: RunSnapshot, now?: number, runs?: readonly RunSnapshot[]) => RunOutcome =
			buildRunOutcome;
		const outcome = buildOutcome(outcomeRun, Date.now(), snapshot?.runs);
		this.runOutcomeCache = { run, snapshot, outcome };
		return outcome;
	}

	protected _runDetailBlockers(run: RunSnapshot | null = this._getCurrentRun()): readonly RunOutcomeBlocker[] {
		return run === null ? [] : this._runOutcomeFor(run).blockers;
	}

	protected _resolveRunDetailSelection(blockers: readonly RunOutcomeBlocker[]): number {
		const detail = this.runDetail;
		if (detail === null || blockers.length === 0) return 0;
		const kept =
			detail.selectedKey === undefined
				? -1
				: blockers.findIndex((blocker) => blockerKey(blocker) === detail.selectedKey);
		detail.selected = kept >= 0 ? kept : Math.max(0, Math.min(detail.selected, blockers.length - 1));
		detail.selectedKey = blockerKey(blockers[detail.selected]!);
		return detail.selected;
	}

	protected _moveRunDetailSelection(blockers: readonly RunOutcomeBlocker[], delta: number): void {
		const detail = this.runDetail;
		if (detail === null || blockers.length === 0) return;
		const from = this._resolveRunDetailSelection(blockers);
		detail.selected = Math.max(0, Math.min(blockers.length - 1, from + delta));
		detail.selectedKey = blockerKey(blockers[detail.selected]!);
	}

	private _returnToRunDetail(): void {
		if (this.runDetailReturn === null) return;
		this.runDetail = this.runDetailReturn;
		this.runDetailReturn = null;
		this.runDetailRevealSelected = true;
	}

	protected _openRunDetail(): boolean {
		if (this._getCurrentRun() === null) return false;
		this.runDetail = { logs: false, selected: 0 };
		this.graphLayoutInvalidateForDetail();
		return true;
	}

	protected _closeRunDetail(): boolean {
		if (this.runDetail === null) return false;
		this.runDetail = null;
		this.graphLayoutInvalidateForDetail();
		return true;
	}

	protected _focusBlockerNode(node: "stage" | "tool", id: string): boolean {
		const index = this.cachedLayout.findIndex((layoutNode) => {
			if ((layoutNode.stage.nodeKind === "tool") !== (node === "tool")) return false;
			return layoutNode.stage.id === id;
		});
		if (index < 0) return false;
		this.runDetailReturn = this.runDetail;
		this.runDetail = null;
		this.focusedIndex = index;
		this.pendingEnsureFocusedVisible = true;
		this.graphLayoutInvalidateForDetail();
		return true;
	}

	protected _currentViewKind(): "tool" | "stage" | "run" | "graph" {
		if (this.toolDetail !== null) return "tool";
		if (this.stageDetail !== null) return "stage";
		if (this.runDetail !== null) return "run";
		return "graph";
	}

	protected _recordPaintedState(): void {
		this.paintedView = this._currentViewKind();
		if (this.runDetail !== null && !this.runDetail.logs) {
			const blockers = this._runDetailBlockers();
			if (blockers.length > 0) {
				const selected = this._resolveRunDetailSelection(blockers);
				this.paintedBlockerKey = blockerKey(blockers[selected]!);
				return;
			}
		}
		this.paintedBlockerKey = null;
	}

	protected _runControlState(run: RunSnapshot): string {
		if (isQuitRun(run)) return "quit";
		return effectiveRunStatus(run);
	}

	protected _runPausable(run: RunSnapshot | null = this._getCurrentRun()): boolean {
		if (this.stageActions?.pauseRun === undefined || run === null || run.endedAt !== undefined) return false;
		return effectiveRunStatus(run) === "running";
	}

	protected _runResumable(run: RunSnapshot | null = this._getCurrentRun()): boolean {
		if (this.stageActions?.resumeRun === undefined || run === null || run.resumable === false) return false;
		const status = effectiveRunStatus(run);
		return status === "paused" || status === "blocked" || this.stageActions.canResumeRun?.(run.id) === true;
	}

	protected _runQuittable(run: RunSnapshot | null = this._getCurrentRun()): boolean {
		if (this.stageActions?.quitRun === undefined || run === null || run.endedAt !== undefined || isQuitRun(run)) {
			return false;
		}
		const status = effectiveRunStatus(run);
		return status === "running" || status === "paused" || status === "blocked";
	}

	protected _clearQuitConfirmTarget(): void {
		if (this.quitConfirmTarget === null) return;
		this.quitConfirmTarget = null;
		if (this.graphNotice?.arm === true) this.graphNotice = null;
	}

	protected _isQuitArmed(run?: RunSnapshot | null): boolean {
		const armed = this.quitConfirmTarget;
		if (armed === null) return false;
		const currentRun = run === undefined ? this._getCurrentRun() : run;
		if (
			currentRun === null ||
			Date.now() > armed.until ||
			armed.runId !== currentRun.id ||
			armed.status !== this._runControlState(currentRun) ||
			!this._runQuittable(currentRun)
		) {
			this._clearQuitConfirmTarget();
			return false;
		}
		return true;
	}

	protected _closeStageDetail(): boolean {
		if (this.stageDetail === null) return false;
		if (this.forkConfirm !== null) {
			this.forkConfirm = null;
			this.graphNotice = null;
		}
		this.stageDetail = null;
		this._returnToRunDetail();
		this.graphLayoutInvalidateForDetail();
		return true;
	}

	protected _stageDetailStage(): StageSnapshot | undefined {
		const detail = this.stageDetail;
		if (detail === null) return undefined;
		return this.cachedLayout.find((node) => node.stage.id === detail.nodeId)?.stage;
	}

	protected _detailOpen(): boolean {
		return this.toolDetail !== null || this.stageDetail !== null || this.runDetail !== null;
	}

	private _syncRetryWatch(): void {
		const watch = this.retryWatch;
		if (watch === null) return;
		const stage = this.cachedLayout.find((node) => node.stage.id === watch.nodeId)?.stage;
		if (stage === undefined || stage.status === "completed") {
			this.retryWatch = null;
			return;
		}
		if (stage.status !== "failed") {
			watch.sawRetry = true;
			return;
		}
		if (!watch.sawRetry && stage.endedAt === watch.failedAt) return;
		this.retryWatch = null;
		this.graphNotice = {
			text: `retry failed again: ${stageFailureReason(stage)}`,
			tone: "error",
			until: Date.now() + 8000,
		};
	}

	/** Let the renderer discard any cached body frame after a detail transition. */
	protected graphLayoutInvalidateForDetail(): void {
		this.pendingEnsureFocusedVisible = true;
		this.graphNodeHitRects = [];
		this.lastGraphViewport = null;
	}

	/**
	 * Pending queued messages for a rendered node. Tool nodes own no session, and
	 * a nested stage's virtual graph id is not a registry key, so resolve the
	 * real `{runId, stageId}` first.
	 */
	protected _stageQueuedMessageCount(stage: StageSnapshot | undefined): number {
		const read = this.getStageQueuedMessageCount;
		if (!read) return 0;
		const target = this._stageChatTarget(stage);
		if (!target) return 0;
		const count = read(target.runId, target.stageId, stage?.queuedUserMessageCount ?? 0);
		if (typeof count !== "number" || !Number.isFinite(count)) return 0;
		return Math.max(0, Math.trunc(count));
	}

	protected _focusedStageChatTarget(): ExpandedWorkflowStageTarget | undefined {
		return this._stageChatTarget(this.cachedLayout[this.focusedIndex]?.stage);
	}

	protected _getCurrentRun(): RunSnapshot | null {
		if (!this.currentSnapshot) return null;
		// Pin to the first run we see so a completed run stays visible after
		// `activeRunId()` clears. Caller can still pass an explicit runId.
		if (this.runId == null) {
			const activeId = this.store.activeRunId();
			if (activeId != null) {
				this.runId = activeId;
			}
		}
		if (this.runId == null) return null;
		return this.currentSnapshot.runs.find((r) => r.id === this.runId) ?? null;
	}

	protected _displayStages(run: RunSnapshot): StageSnapshot[] {
		return this.cachedDisplayStages.length > 0 ? this.cachedDisplayStages : [...run.stages];
	}

	protected _counts(stages: readonly StageSnapshot[]): GraphStageCounts {
		const c: GraphStageCounts = {
			pending: 0,
			running: 0,
			awaiting_input: 0,
			paused: 0,
			blocked: 0,
			suspended: 0,
			completed: 0,
			failed: 0,
			skipped: 0,
		};
		for (const s of stages) c[s.status]++;
		return c;
	}

	dispose(): void {
		this.disposed = true;
		if (this._intervalId != null) {
			clearInterval(this._intervalId);
			this._intervalId = null;
		}
		if (this._unsubscribe) {
			this._unsubscribe();
			this._unsubscribe = null;
		}
	}

	invalidate(): void {
		this.layoutInvalidated = true;
	}
}
