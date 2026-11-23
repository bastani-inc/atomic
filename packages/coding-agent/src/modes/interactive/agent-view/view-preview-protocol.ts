import type { TaskId } from "../../../core/tasks/contracts.js";

/**
 * Host-side preview gate for an engine widget whose frames may show a speculative target before the host commits it
 * (the idle agent panel while a `panelOnView` open from `/tasks` is in flight).
 * - `staged`: preview `previewSeq` is in flight; matching frames buffer for `watchWidgetFrames` (0-frame gap on commit)
 *   but never paint to the live screen until promoted.
 * - `committed`: normal live rendering; if `promotedSeq` is set (immediately after a preview committed), late frames
 *   carrying `promotedSeq` are still accepted until the next view change clears `promotedSeq`, while all other
 *   speculative `previewSeq` tags are dropped.
 */
export type WidgetPreviewGate =
	| { readonly kind: "committed"; readonly promotedSeq?: number }
	| { readonly kind: "staged"; readonly previewSeq: number; readonly tagged: boolean };

export type WidgetFrameClassification = "accept-committed" | "accept-staged" | "drop";

export const COMMITTED_WIDGET_PREVIEW_GATE: WidgetPreviewGate = { kind: "committed" };

/** Classify an incoming `engine_custom_frame` against the widget's active preview gate. */
export function classifyWidgetFrame(
	gate: WidgetPreviewGate,
	framePreviewSeq: number | undefined,
): WidgetFrameClassification {
	if (gate.kind === "staged") {
		if (framePreviewSeq !== undefined) {
			return framePreviewSeq === gate.previewSeq ? "accept-staged" : "drop";
		}
		return gate.tagged ? "accept-committed" : "accept-staged";
	}
	if (framePreviewSeq !== undefined) {
		return gate.promotedSeq !== undefined && framePreviewSeq === gate.promotedSeq ? "accept-committed" : "drop";
	}
	return "accept-committed";
}

/** Whether a widget's currently buffered frame is allowed to paint on the live screen. */
export function canPaintWidgetFrame(
	gate: WidgetPreviewGate,
	bufferedPreviewSeq: number | undefined,
	hidden: boolean,
): boolean {
	if (hidden) return false;
	if (gate.kind === "staged") return false;
	return bufferedPreviewSeq === undefined;
}

/** Engine-side speculative preview state (never mutates committed `viewedTaskId()` or promotes `/tasks` anchors). */
export type EngineAgentViewPreview =
	| { readonly kind: "none" }
	| {
			readonly kind: "preview";
			readonly taskId: TaskId;
			readonly previewSeq: number;
			readonly requestId?: number;
	  };

/** Typed engine-side state for the host <-> engine agent-view protocol. */
export interface EngineAgentViewState {
	/** What the host's screen actually shows (committed truth). */
	readonly committed: TaskId | undefined;
	/** Active panel-only speculative preview while a `panelOnView` open is in flight on the host. */
	readonly preview: EngineAgentViewPreview;
	/** Highest host-assigned `viewSeq` applied in this generation (0 when only untagged legacy hosts spoke). */
	readonly appliedViewSeq: number;
	/** Latest engine-assigned `engine_view_agent.requestId` emitted by this bridge. */
	readonly lastRequestId: number;
	/** Highest `settledRequestId` reported by the host in this generation. */
	readonly settledRequestId: number;
	/** Count of committed `set_viewed_agent` deliveries (kept for `engineAgentViewSettlementSeq` compatibility). */
	readonly settledCount: number;
	/** Count of legacy untagged `set_viewed_agent` deliveries (no `settledRequestId`). */
	readonly legacySettledCount: number;
}

export const NO_ENGINE_PREVIEW: EngineAgentViewPreview = { kind: "none" };

export function initialEngineAgentViewState(): EngineAgentViewState {
	return {
		committed: undefined,
		preview: NO_ENGINE_PREVIEW,
		appliedViewSeq: 0,
		lastRequestId: 0,
		settledRequestId: 0,
		settledCount: 0,
		legacySettledCount: 0,
	};
}

/** Advance engine state when the engine sends a new `engine_view_agent` request. */
export function beginEngineViewRequest(state: EngineAgentViewState): {
	readonly state: EngineAgentViewState;
	readonly requestId: number;
	readonly previewCleared: boolean;
} {
	const requestId = state.lastRequestId + 1;
	const previewCleared = state.preview.kind === "preview";
	return {
		state: {
			...state,
			lastRequestId: requestId,
			preview: NO_ENGINE_PREVIEW,
		},
		requestId,
		previewCleared,
	};
}

export interface HostSetViewedAgentInput {
	readonly taskId: TaskId | undefined;
	readonly preview?: true;
	readonly viewSeq?: number;
	readonly requestId?: number;
	readonly settledRequestId?: number;
}

export interface EngineSetViewedAgentTransition {
	readonly state: EngineAgentViewState;
	readonly committedChanged: boolean;
	readonly panelChanged: boolean;
	/** When present, settle `/tasks` return records against `viewed` using `settledRequestId` causality. */
	readonly settle?: {
		readonly viewed: TaskId | undefined;
		readonly settledRequestId: number | undefined;
		/** True when only settling already-superseded pending records without replacing committed state. */
		readonly supersededOnly?: true;
	};
}

function validPositiveSeq(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validNonNegativeSeq(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Apply an incoming host `set_viewed_agent` command to the engine's typed state machine. */
export function applyEngineSetViewedAgent(
	state: EngineAgentViewState,
	command: HostSetViewedAgentInput,
): EngineSetViewedAgentTransition {
	const viewSeq = validPositiveSeq(command.viewSeq);
	if (viewSeq !== undefined && viewSeq <= state.appliedViewSeq) {
		return { state, committedChanged: false, panelChanged: false };
	}
	const nextAppliedViewSeq = viewSeq ?? state.appliedViewSeq;
	const settledRequestId = validNonNegativeSeq(command.settledRequestId);
	const nextSettledRequestId =
		settledRequestId !== undefined && settledRequestId > state.settledRequestId
			? settledRequestId
			: state.settledRequestId;

	if (command.preview === true) {
		const reqId = validPositiveSeq(command.requestId);
		const stalePreview = reqId !== undefined && reqId < state.lastRequestId;
		const nextPreview: EngineAgentViewPreview =
			stalePreview || command.taskId === undefined
				? state.preview
				: {
						kind: "preview",
						taskId: command.taskId,
						previewSeq: viewSeq ?? 0,
						...(reqId === undefined ? {} : { requestId: reqId }),
					};
		const panelChanged =
			nextPreview.kind !== state.preview.kind ||
			(nextPreview.kind === "preview" &&
				state.preview.kind === "preview" &&
				(nextPreview.taskId !== state.preview.taskId || nextPreview.previewSeq !== state.preview.previewSeq));
		return {
			state: {
				...state,
				preview: nextPreview,
				appliedViewSeq: nextAppliedViewSeq,
				settledRequestId: nextSettledRequestId,
			},
			committedChanged: false,
			panelChanged,
			...(settledRequestId !== undefined
				? { settle: { viewed: state.committed, settledRequestId, supersededOnly: true as const } }
				: {}),
		};
	}

	const committedChanged = state.committed !== command.taskId;
	// Preserve an active preview whose own requestId has not yet been settled by the host
	// (e.g., a prior viewed subagent went gone while the next panelOnView open is still in flight).
	const keepPreview =
		state.preview.kind === "preview" &&
		state.preview.requestId !== undefined &&
		settledRequestId !== undefined &&
		settledRequestId < state.preview.requestId;
	const nextPreview = keepPreview ? state.preview : NO_ENGINE_PREVIEW;
	const previewCleared = state.preview.kind === "preview" && !keepPreview;
	const panelChanged = committedChanged || previewCleared;
	return {
		state: {
			...state,
			committed: command.taskId,
			preview: nextPreview,
			appliedViewSeq: nextAppliedViewSeq,
			settledRequestId: nextSettledRequestId,
			settledCount: state.settledCount + 1,
			legacySettledCount: settledRequestId === undefined ? state.legacySettledCount + 1 : state.legacySettledCount,
		},
		committedChanged,
		panelChanged,
		settle: {
			viewed: command.taskId,
			settledRequestId,
		},
	};
}

/** In-flight engine request tracked on the host until it commits, fails, cancels, or is superseded. */
export interface HostPendingEngineRequest {
	readonly hostRequestId: number;
	readonly engineRequestId?: number;
	readonly previewSeq?: number;
	/** True when the engine supplied `requestId` (and therefore tags preview frames with `previewSeq`). */
	readonly tagged: boolean;
}

/** Host-side typed state synchronizing `AgentViewSwitcher`, `RemoteComponentController`, and `set_viewed_agent`. */
export interface HostEngineViewSyncState {
	readonly viewSeq: number;
	readonly settledRequestId: number;
	readonly lastSentSettledRequestId: number;
	readonly pendingEngine: HostPendingEngineRequest | undefined;
}

export function initialHostEngineViewSyncState(): HostEngineViewSyncState {
	return {
		viewSeq: 0,
		settledRequestId: 0,
		lastSentSettledRequestId: 0,
		pendingEngine: undefined,
	};
}

export interface HostSetViewedPayload {
	readonly taskId?: TaskId;
	readonly preview?: true;
	readonly viewSeq: number;
	readonly requestId?: number;
	readonly settledRequestId?: number;
}

/** Panel-only speculative preview currently attached to an engine `AgentViewBridge`. */
export interface BridgePanelPreview {
	readonly taskId: TaskId;
	readonly previewSeq: number;
}

const bridgePanelPreviews = new WeakMap<object, BridgePanelPreview>();

/** Record or clear the active speculative panel preview for `bridge` (weakly keyed, zero retention). */
export function setBridgePanelPreview(bridge: object, preview: BridgePanelPreview | undefined): void {
	if (preview === undefined) bridgePanelPreviews.delete(bridge);
	else bridgePanelPreviews.set(bridge, preview);
}

/** Active speculative panel preview for `bridge`, or undefined when showing committed state. */
export function bridgePanelPreview(bridge: object | undefined): BridgePanelPreview | undefined {
	return bridge === undefined ? undefined : bridgePanelPreviews.get(bridge);
}

/**
 * Decide whether an incoming `engine_view_agent` should be cancelled immediately on arrival because the closing
 * navigation component (`/tasks`) already has an unanswered cancel key (`Esc` / `app.interrupt`) in flight.
 */
export function shouldCancelEngineViewOnArrival(
	hasTaskId: boolean,
	keepScreen: boolean,
	topIsLiveNavigation: boolean,
	hasUnansweredCancel: boolean,
): boolean {
	return hasTaskId && keepScreen && topIsLiveNavigation && hasUnansweredCancel;
}

/**
 * Whether an in-flight `RemoteComponent` input represents a cancel key pressed after the action that triggered an
 * incoming `engine_view_agent` (excluding the triggering `minUnansweredId` by identity so arbitrary keybinding
 * overlaps never self-cancel, while still honoring host-consumed watermarks and physical `Esc` after a settled click).
 */
export function isUnansweredCancelMatch(
	inputAnswered: boolean,
	isCancelKey: boolean,
	isPhysicalEsc: boolean,
	inputId: number,
	minUnansweredId: number,
	cancelUpToInputId: number,
	clickBeforeOldest: boolean,
): boolean {
	if (inputAnswered) return false;
	if (inputId <= cancelUpToInputId) return true;
	if (inputId > minUnansweredId) return isCancelKey;
	return clickBeforeOldest && isPhysicalEsc;
}

/**
 * Compute the next `settledRequestId` watermark and whether a committed `set_viewed_agent` acknowledgement must still
 * be sent after cancelling an incoming `engine_view_agent` on arrival.
 */
export function planPreViewCancelAck(
	currentSettledReq: number,
	lastSentSettledReq: number,
	engineRequestId: number,
	priorPendingActive: boolean,
): { readonly nextSettledReq: number; readonly shouldSendAck: boolean } {
	const nextSettledReq = engineRequestId > currentSettledReq ? engineRequestId : currentSettledReq;
	const effectiveLastSent = priorPendingActive ? nextSettledReq : lastSentSettledReq;
	const shouldSendAck = engineRequestId === 0 ? !priorPendingActive : effectiveLastSent < engineRequestId;
	return { nextSettledReq, shouldSendAck };
}
