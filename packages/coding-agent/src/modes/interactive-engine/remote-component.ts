import {
	type Component,
	isHintActivation,
	type OverlayHandle,
	type OverlayOptions,
	stripHintMarkers,
	type TUI,
	type TuiMode,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import type { WidgetScrollRequest, WidgetScrollState } from "../../core/extensions/ui-types.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import {
	COMMITTED_WIDGET_PREVIEW_GATE,
	canPaintWidgetFrame,
	classifyWidgetFrame,
	isUnansweredCancelMatch,
	type WidgetPreviewGate,
} from "../interactive/agent-view/view-preview-protocol.js";
import { awaitFirstContent, PROMPT_SLOT_HOLD_MS } from "../interactive/components/prompt-slot.ts";
import { isSingleLeftClick } from "../interactive/components/single-click.ts";
import { AGENT_PANEL_WIDGET_KEY } from "../rpc/agent-panel-bridge.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.js";
import type {
	EngineBlockedStatus,
	EngineHostRenderSettings,
	InteractiveEngineMessage,
	JsonValue,
	SerializableOverlayOptions,
} from "./protocol.ts";
import { RemoteFrameWidthClamp } from "./remote-frame-clamp.ts";
import { TerminalModeController } from "./terminal-mode-controller.ts";
import type { TranscriptFrameLayout } from "./transcript-frame-layout.ts";

export type RemoteComponentRuntime = Pick<
	IsolatedInteractiveRuntime,
	"onEngineMessage" | "onGenerationEnded" | "sendEngineCommand"
>;

export type RemoteComponentUI = Pick<ExtensionUIContext, "custom" | "requestRender" | "setWidget" | "onWidgetRelease">;

/** A frame line as a picture: what it shows, without key hints or links a click could run. */
function inertLine(line: string): string {
	return stripHintMarkers(line).replace(/\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

interface MountedRemoteComponent {
	component: RemoteComponent;
	done: (result: JsonValue | undefined) => void;
	engineDone: boolean;
	/** The extension declared that this component binds Ctrl+C itself. */
	handlesCtrlC: boolean;
	/** The extension declared that this component claims internal UI actions. */
	handlesInternalUiAction: boolean;
	purpose?: "prompt" | "navigation";
	handle?: OverlayHandle;
	widgetKey?: string;
	unsubscribeWidgetRelease?: () => void;
	/** A viewed subagent's transcript (`placement: "transcript"`), drawn by the host's transcript area. */
	transcript?: RemoteTranscriptMount;
}

/**
 * A stalled engine must not make fullscreen input wait forever. A timed-out
 * reply is treated as unhandled and lets the viewport process the key.
 */
export const REMOTE_INPUT_REPLY_TIMEOUT_MS = 250;

interface PendingInput {
	resolve: (handled: boolean | undefined) => void;
	timer: ReturnType<typeof setTimeout>;
	/** The frame requested with the key: a handled key answers once that frame is here, so one paint shows it. */
	readonly frameRequestId: number | undefined;
	/** Raw key data sent in `engine_custom_input`, used to detect unanswered pre-view cancel keys on arrival. */
	readonly data: string;
}

class RemoteComponent implements Component {
	hostColorDepth?: number;
	private scrollRequest: WidgetScrollRequest | undefined;
	getScrollRequest(): WidgetScrollRequest | undefined {
		return this.scrollRequest;
	}
	onScroll(state: WidgetScrollState): void {
		if (!this.disposed)
			this.runtime.sendEngineCommand({ type: "engine_custom_scroll", componentId: this.componentId, state });
	}
	wantsKeyRelease = true;
	readonly handlesInternalUiAction: boolean;
	private lines: string[] = [];
	private width = 0;
	private rows = 0;
	private hostMode: TuiMode | undefined;
	private requestId = 0;
	private inputRequestId = 0;
	private appliedRequestId = 0;
	/** The engine's number for the frame in `lines`, and for the frame the last `render` returned. */
	private frame: number | undefined;
	private paintedFrame: number | undefined;
	/** What the engine component drew on each row of `lines`, and of the frame the last `render` returned. */
	private rowKeys: readonly string[] | undefined;
	private paintedRowKeys: readonly string[] | undefined;
	/** How a viewed subagent's transcript laid out `lines`, and the frame the last `render` returned. */
	private layout: TranscriptFrameLayout | undefined;
	private paintedFrameLayout: TranscriptFrameLayout | undefined;
	/** The number of the last click forwarded to the engine. */
	private clickId = 0;
	private dirty = true;
	private disposed = false;
	private readonly pendingInputs = new Map<number, PendingInput>();
	/** Handled keys whose frame has not arrived yet. */
	private readonly answeredInputs = new Set<number>();
	/** Highest `inputRequestId` sent when a host-level cancel (`Esc`) was consumed while this component was mounted. */
	private cancelUpToInputId = 0;
	private readonly frameClamp = new RemoteFrameWidthClamp();

	private readonly componentId: string;
	private readonly runtime: RemoteComponentRuntime;
	private readonly requestRender: () => void;
	private readonly paintNow: () => void;
	private readonly getRows: () => number;
	private readonly getHostMode: () => TuiMode;
	private readonly getRenderSettings: () => EngineHostRenderSettings | undefined;
	private renderSettingsKey = "";
	/** The frame request sent with the latest key; the frame answering it paints at once, as a local key does. */
	private keyFrameRequestId = 0;

	constructor(
		componentId: string,
		runtime: RemoteComponentRuntime,
		requestRender: () => void,
		getRows: () => number,
		getHostMode: () => TuiMode,
		handlesInternalUiAction = false,
		getRenderSettings: () => EngineHostRenderSettings | undefined = () => undefined,
		paintNow: () => void = requestRender,
	) {
		this.componentId = componentId;
		this.runtime = runtime;
		this.requestRender = requestRender;
		this.paintNow = paintNow;
		this.getRows = getRows;
		this.getHostMode = getHostMode;
		this.handlesInternalUiAction = handlesInternalUiAction;
		this.getRenderSettings = getRenderSettings;
	}

	/**
	 * Frames up to this request may draw what the screen was about to show and no longer does: they are not shown, and a
	 * frame asked for after it is (see hideFramesUntilFresh).
	 */
	private hiddenUpTo: number | undefined;
	private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
	/** Speculative preview gate for engine widgets (the agent panel during `panelOnView`). */
	private previewGate: WidgetPreviewGate = COMMITTED_WIDGET_PREVIEW_GATE;
	/** Preview sequence number that produced the currently buffered `lines`, when staged/unpromoted. */
	private framePreviewSeq: number | undefined;

	private clearBufferedFrame(): void {
		this.lines = [];
		this.frame = undefined;
		this.rowKeys = undefined;
		this.layout = undefined;
		this.scrollRequest = undefined;
		this.framePreviewSeq = undefined;
	}

	/** Stage a speculative preview so matching frames buffer for `watchWidgetFrames` without painting live until commit. */
	stagePreview(previewSeq: number, tagged: boolean): void {
		if (this.disposed) return;
		this.showFramesAgain();
		if (this.framePreviewSeq !== undefined && this.framePreviewSeq !== previewSeq) {
			this.clearBufferedFrame();
			this.dirty = true;
		}
		this.previewGate = { kind: "staged", previewSeq, tagged };
	}

	/** Promote a staged preview buffer to live visibility on commit (0-frame gap). */
	commitPreview(previewSeq: number): void {
		if (this.disposed) return;
		this.showFramesAgain();
		this.previewGate = { kind: "committed", promotedSeq: previewSeq };
		if (this.framePreviewSeq === previewSeq) {
			this.framePreviewSeq = undefined;
		} else if (this.framePreviewSeq !== undefined) {
			this.clearBufferedFrame();
			this.dirty = true;
		}
	}

	/** Cancel/revoke a staged speculative preview so its buffered and late frames can never paint. */
	cancelPreview(legacyHideCapMs?: number): void {
		if (this.disposed) return;
		this.previewGate = COMMITTED_WIDGET_PREVIEW_GATE;
		if (this.framePreviewSeq !== undefined || legacyHideCapMs !== undefined) {
			this.clearBufferedFrame();
			this.dirty = true;
		}
		if (legacyHideCapMs !== undefined) this.hideFramesUntilFresh(legacyHideCapMs);
		else this.requestRender();
	}

	/** Stop accepting late preview frames after leaving the view that promoted a preview. */
	clearPromotedPreview(): void {
		if (this.previewGate.kind === "committed" && this.previewGate.promotedSeq !== undefined) {
			this.previewGate = COMMITTED_WIDGET_PREVIEW_GATE;
		}
	}

	/** Shows nothing until a frame asked for from now on comes, or `capMs` passes. */
	hideFramesUntilFresh(capMs: number): void {
		if (this.disposed) return;
		this.hiddenUpTo = this.requestId;
		this.clearBufferedFrame();
		this.dirty = true;
		clearTimeout(this.hiddenTimer);
		this.hiddenTimer = setTimeout(() => {
			this.showFramesAgain();
			this.requestRender();
		}, capMs);
		this.hiddenTimer.unref?.();
	}

	private showFramesAgain(): void {
		clearTimeout(this.hiddenTimer);
		this.hiddenTimer = undefined;
		this.hiddenUpTo = undefined;
	}

	render(width: number): string[] {
		if (this.retiredShowing !== undefined) {
			// Only the picture it was painted as, at that width.
			const picture = this.retiredPicture;
			return this.retiredShowing() && picture?.width === width ? [...picture.lines] : [];
		}
		const rows = this.getRows();
		// A renderer switch in the host changes the mode the engine component lays itself out for.
		const hostMode = this.getHostMode();
		const renderSettings = this.getRenderSettings();
		const renderSettingsKey = renderSettingsCacheKey(renderSettings);
		if (
			!this.disposed &&
			(this.dirty ||
				width !== this.width ||
				rows !== this.rows ||
				hostMode !== this.hostMode ||
				renderSettingsKey !== this.renderSettingsKey)
		) {
			this.requestFrame(width, rows, hostMode, renderSettings, renderSettingsKey);
		}
		// The engine child re-renders asynchronously; until the fresh frame
		// arrives, the previous frame may be wrapped for an older terminal
		// width. Clamp so a resize never replays overflowing lines (pi-tui
		// crashes on any rendered line wider than the terminal).
		if (!canPaintWidgetFrame(this.previewGate, this.framePreviewSeq, this.hiddenUpTo !== undefined)) {
			this.paintedFrame = undefined;
			this.paintedRowKeys = undefined;
			this.paintedFrameLayout = undefined;
			this.paintedLines = [];
			this.paintedWidth = width;
			return [];
		}
		this.paintedFrame = this.frame;
		this.paintedRowKeys = this.rowKeys;
		this.paintedFrameLayout = this.layout;
		const lines = this.frameClamp.clamp(this.lines, width);
		this.paintedLines = lines;
		this.paintedWidth = width;
		return lines;
	}

	/** How the frame the last `render` returned laid out its rows, when the engine said. */
	paintedLayout(): TranscriptFrameLayout | undefined {
		return this.paintedFrameLayout;
	}

	/** What the engine component drew on `row` of the frame this host painted, when it names its rows. */
	paintedRowKey(row: number): string | undefined {
		return this.paintedRowKeys?.[row];
	}

	/**
	 * Forward a single click to the engine component, at its row and column there. Presses, drags and multi-clicks stay
	 * with the host's text selection. The click is numbered: once it stays a single click, the host settles that number,
	 * and what the component left for that moment runs.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || this.retiredShowing !== undefined || !isSingleLeftClick(event)) return undefined;
		if (this.paintedFrame === undefined) return undefined;
		const rowKey = this.paintedRowKeys?.[Math.floor(event.y)];
		const clickId = ++this.clickId;
		this.runtime.sendEngineCommand({
			type: "engine_custom_click",
			componentId: this.componentId,
			frame: this.paintedFrame,
			...(rowKey === undefined ? {} : { rowKey }),
			clickId,
			cancelsClicks: true,
			x: Math.max(0, Math.floor(event.x)),
			y: Math.max(0, Math.floor(event.y)),
			width: Math.max(0, Math.floor(event.width)),
			height: Math.max(0, Math.floor(event.height)),
		});
		const finish = (type: "engine_custom_click_settle" | "engine_custom_click_cancel") => {
			if (this.disposed || this.retiredShowing !== undefined) return;
			try {
				this.runtime.sendEngineCommand({ type, componentId: this.componentId, clickId });
			} catch {
				// An engine that went away takes no click; the host keeps its frame.
			}
		};
		return {
			handled: true,
			whenSingleClick: () => finish("engine_custom_click_settle"),
			onSingleClickCancel: () => finish("engine_custom_click_cancel"),
		};
	}

	handleInput(data: string): Promise<boolean | undefined> {
		if (this.disposed || this.retiredShowing !== undefined) return Promise.resolve(undefined);
		const requestId = ++this.inputRequestId;
		const frameRequestId = this.width > 0 ? this.requestId + 1 : undefined;
		const result = new Promise<boolean | undefined>((resolve) => {
			const timer = setTimeout(() => this.resolveInput(requestId, false), REMOTE_INPUT_REPLY_TIMEOUT_MS);
			timer.unref?.();
			this.pendingInputs.set(requestId, { resolve, timer, frameRequestId, data });
		});
		try {
			this.runtime.sendEngineCommand({
				type: "engine_custom_input",
				componentId: this.componentId,
				requestId,
				data,
				...(isHintActivation() ? { hint: true as const } : {}),
			});
		} catch {
			this.resolveInput(requestId, false);
		}
		// Engine commands are delivered in order, so a frame requested now is
		// rendered by the child only AFTER it has applied this input. Asking for
		// it with the key, rather than on the next paced host render, keeps the
		// keypress at a single round trip, and repaints components that never
		// self-invalidate.
		if (frameRequestId !== undefined) {
			const renderSettings = this.getRenderSettings();
			this.keyFrameRequestId = frameRequestId;
			this.requestFrame(
				this.width,
				this.getRows(),
				this.getHostMode(),
				renderSettings,
				renderSettingsCacheKey(renderSettings),
			);
		} else {
			this.dirty = true;
			this.requestRender();
		}
		return result;
	}

	private requestFrame(
		width: number,
		rows: number,
		hostMode: TuiMode,
		renderSettings: EngineHostRenderSettings | undefined,
		renderSettingsKey: string,
	): void {
		this.width = width;
		this.rows = rows;
		this.hostMode = hostMode;
		this.renderSettingsKey = renderSettingsKey;
		this.dirty = false;
		this.runtime.sendEngineCommand({
			type: "engine_custom_render",
			componentId: this.componentId,
			...(this.requestId === 0 && this.hostColorDepth !== undefined ? { colorDepth: this.hostColorDepth } : {}),
			requestId: ++this.requestId,
			width,
			rows,
			hostMode,
			...(renderSettings === undefined ? {} : { renderSettings }),
		});
	}

	resolveInput(requestId: number, handled: boolean | undefined): void {
		const pending = this.pendingInputs.get(requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		// A handled key answers with the frame that shows it: resolving before it arrives would repaint the frame the
		// key has not reached, and the key's own frame would wait behind that paint.
		if (handled === true && pending.frameRequestId !== undefined && this.appliedRequestId < pending.frameRequestId) {
			pending.timer = setTimeout(() => this.settleInput(requestId, true), REMOTE_INPUT_REPLY_TIMEOUT_MS);
			pending.timer.unref?.();
			this.answeredInputs.add(requestId);
			return;
		}
		this.settleInput(requestId, handled);
	}

	private settleInput(requestId: number, handled: boolean | undefined): void {
		const pending = this.pendingInputs.get(requestId);
		if (!pending) return;
		this.pendingInputs.delete(requestId);
		this.answeredInputs.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(handled);
	}

	/** Record that a host-level cancel key (`Esc`) was consumed while this component had inputs in flight. */
	noteHostCancel(): void {
		if (this.disposed || this.retiredShowing !== undefined) return;
		if (this.inputRequestId > this.cancelUpToInputId) this.cancelUpToInputId = this.inputRequestId;
	}

	/**
	 * True when this component has an unanswered cancel input (or an unanswered input already in flight when a
	 * host-level cancel consumed `Esc`), meaning `Esc` was pressed after the input/click that emitted `engine_view_agent`.
	 */
	hasUnansweredCancelInput(isCancel: (data: string) => boolean): boolean {
		if (this.disposed || this.retiredShowing !== undefined) return false;
		for (const [requestId, pending] of this.pendingInputs) {
			if (
				isUnansweredCancelMatch(
					this.answeredInputs.has(requestId),
					isCancel(pending.data),
					requestId,
					this.cancelUpToInputId,
				)
			) {
				return true;
			}
		}
		return false;
	}

	invalidate(): void {
		this.dirty = true;
	}

	/**
	 * Closed by the engine while what replaces it is not on screen yet: it keeps showing its last frame, as a picture that
	 * takes no clicks and asks for no frames, while `showing` answers true, and draws nothing after that.
	 */
	retire(showing: () => boolean): boolean {
		const painted = this.paintedLines;
		if (painted === undefined || painted.length === 0) return false;
		this.retiredShowing = showing;
		this.retiredPicture = { width: this.paintedWidth, lines: painted.map(inertLine) };
		// What was painted takes no click from now on.
		this.paintedFrame = undefined;
		this.paintedRowKeys = undefined;
		this.clickId++;
		this.cancelUpToInputId = 0;
		for (const requestId of [...this.pendingInputs.keys()]) this.resolveInput(requestId, undefined);
		return true;
	}

	private retiredShowing: (() => boolean) | undefined;
	/** What the last render returned, at its width: the picture a retired component keeps showing. */
	private paintedLines: readonly string[] | undefined;
	private paintedWidth = 0;
	private retiredPicture: { readonly width: number; readonly lines: readonly string[] } | undefined;

	/** Nothing to draw yet: the engine has not sent its first frame. */
	awaitingFirstContent(): boolean {
		return !this.disposed && this.appliedRequestId === 0;
	}

	/** Called with each frame the engine sends, once it is the one `render` returns. */
	onFrame: (() => void) | undefined;

	/** Ask for a frame of `width` x `rows` now, before the host lays the component out. */
	prime(width: number, rows: number): void {
		if (this.disposed) return;
		const renderSettings = this.getRenderSettings();
		this.requestFrame(width, rows, this.getHostMode(), renderSettings, renderSettingsCacheKey(renderSettings));
	}

	applyFrame(
		requestId: number,
		lines: string[],
		scrollRequest?: WidgetScrollRequest,
		frame?: number,
		rowKeys?: readonly string[],
		layout?: TranscriptFrameLayout,
		previewSeq?: number,
	): void {
		if (this.disposed || requestId < this.appliedRequestId) return;
		const decision = classifyWidgetFrame(this.previewGate, previewSeq);
		if (decision === "drop") {
			if (requestId === this.requestId) {
				this.dirty = true;
				this.requestRender();
			}
			return;
		}
		this.appliedRequestId = requestId;
		if (decision === "accept-staged") {
			this.lines = lines;
			this.frame = frame;
			this.rowKeys = rowKeys;
			this.layout = layout;
			this.scrollRequest = scrollRequest;
			this.framePreviewSeq = this.previewGate.kind === "staged" ? this.previewGate.previewSeq : previewSeq;
			this.onFrame?.();
			return;
		}
		if (this.hiddenUpTo !== undefined && requestId > this.hiddenUpTo) this.showFramesAgain();
		this.lines = lines;
		this.frame = frame;
		this.rowKeys = rowKeys;
		this.layout = layout;
		this.scrollRequest = scrollRequest;
		this.framePreviewSeq = undefined;
		this.onFrame?.();
		let answeredKey = false;
		for (const inputId of [...this.answeredInputs]) {
			const frameRequestId = this.pendingInputs.get(inputId)?.frameRequestId;
			if (frameRequestId === undefined || frameRequestId > requestId) continue;
			this.settleInput(inputId, true);
			answeredKey = true;
		}
		if (this.keyFrameRequestId !== 0 && requestId >= this.keyFrameRequestId) {
			this.keyFrameRequestId = 0;
			// A key answered now repaints as its input settles; a frame that overtook its key's answer paints at once.
			if (!answeredKey) this.paintNow();
			return;
		}
		this.requestRender();
	}

	requestRemoteRender(): void {
		if (this.disposed) return;
		this.dirty = true;
		this.requestRender();
	}

	/**
	 * Tear the proxy down. `notifyEngine` must be false once the writer no longer
	 * points at the generation that owns this component: component IDs restart at
	 * `remote_component_1` for every child, so a late dispose would address an
	 * unrelated component in the replacement engine.
	 */
	dispose(notifyEngine = true): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelUpToInputId = 0;
		clearTimeout(this.hiddenTimer);
		for (const requestId of [...this.pendingInputs.keys()]) this.resolveInput(requestId, undefined);
		if (notifyEngine)
			this.runtime.sendEngineCommand({ type: "engine_custom_dispose", componentId: this.componentId });
	}
}

/** The engine component behind a transcript mount, as the host's transcript area uses it. */
export type RemoteTranscriptComponent = Pick<
	RemoteComponent,
	| "render"
	| "handleInput"
	| "handleMouse"
	| "paintedRowKey"
	| "paintedLayout"
	| "invalidate"
	| "prime"
	| "hostColorDepth"
>;

/**
 * A viewed subagent's transcript the engine opened with `placement: "transcript"` for view `viewId`. The host's
 * transcript area draws it in the rows it sets; it is closed by the engine (`engine_custom_close`) or with its engine.
 */
export class RemoteTranscriptMount {
	readonly componentId: string;
	readonly viewId: string;
	readonly component: RemoteTranscriptComponent;
	/** The rows the transcript area gives it; frames are requested at this height. */
	rows = 24;
	private framed = false;
	private isClosed = false;
	private readonly waiting = new Set<(framed: boolean) => void>();
	private readonly closeListeners = new Set<() => void>();

	constructor(componentId: string, viewId: string, component: RemoteComponent) {
		this.componentId = componentId;
		this.viewId = viewId;
		this.component = component;
		component.onFrame = () => {
			if (this.framed) return;
			this.framed = true;
			for (const resolve of [...this.waiting]) resolve(true);
			this.waiting.clear();
		};
	}

	get closed(): boolean {
		return this.isClosed;
	}

	/** Resolves true once the engine's first frame is here, false if the mount closed first. */
	firstFrame(): Promise<boolean> {
		if (this.framed) return Promise.resolve(true);
		if (this.isClosed) return Promise.resolve(false);
		return new Promise((resolve) => this.waiting.add(resolve));
	}

	onClose(listener: () => void): () => void {
		if (this.isClosed) {
			listener();
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	/** @internal The controller closed it. */
	markClosed(): void {
		if (this.isClosed) return;
		this.isClosed = true;
		for (const resolve of [...this.waiting]) resolve(false);
		this.waiting.clear();
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch {
				// A listener's failure must not stop the others.
			}
		}
		this.closeListeners.clear();
	}
}

const transcriptMounts = new WeakMap<object, Map<string, RemoteTranscriptMount>>();

/** The transcript the engine of `runtime` opened for view `viewId`, while it is open. */
export function remoteTranscriptMount(runtime: object, viewId: string): RemoteTranscriptMount | undefined {
	return transcriptMounts.get(runtime)?.get(viewId);
}

/** A watch over the widgets an engine opens under `widgetKey`, from when it began. */
interface WidgetFrameWatch {
	readonly widgetKey: string;
	/** A widget opened under the key since the watch began. */
	opened: boolean;
	/** Waiting for those widgets to draw (`drawn`). */
	readonly waiters: Array<() => void>;
}

const widgetFrameWatches = new WeakMap<object, Set<WidgetFrameWatch>>();
const controllers = new WeakMap<object, RemoteComponentController>();

/**
 * Watch the widgets the engine of `runtime` opens under `widgetKey` from now on. `drawn` resolves once such a widget
 * has opened and no widget under the key is without its first frame now: one that closed leaves nothing to wait for,
 * one that replaced it is waited for in turn. A widget open before the watch began does not count as opened.
 */
/** See RemoteComponentController.hideWidgetFramesUntilFresh. */
export function hideWidgetFramesUntilFresh(runtime: object, widgetKey: string, capMs: number): void {
	controllers.get(runtime)?.hideWidgetFramesUntilFresh(widgetKey, capMs);
}

/** Stage a speculative preview gate for `widgetKey` until commit or cancel. */
export function stageWidgetPreview(runtime: object, widgetKey: string, previewSeq: number, tagged: boolean): void {
	controllers.get(runtime)?.stageWidgetPreview(widgetKey, previewSeq, tagged);
}

/** Promote a staged preview buffer for `widgetKey` so it paints immediately on commit. */
export function commitWidgetPreview(runtime: object, widgetKey: string, previewSeq: number): void {
	controllers.get(runtime)?.commitWidgetPreview(widgetKey, previewSeq);
}

/** Revoke a staged speculative preview for `widgetKey` so its buffered and late frames never paint. */
export function cancelWidgetPreview(runtime: object, widgetKey: string, legacyHideCapMs?: number): void {
	controllers.get(runtime)?.cancelWidgetPreview(widgetKey, legacyHideCapMs);
}

/** Clear `promotedSeq` for `widgetKey` once the screen leaves the view that promoted a preview. */
export function clearPromotedWidgetPreview(runtime: object, widgetKey: string): void {
	controllers.get(runtime)?.clearPromotedWidgetPreview(widgetKey);
}

/** Reset preview gate and hide state for `widgetKey` across engine generation replacement. */
export function resetWidgetPreview(runtime: object, widgetKey: string): void {
	controllers.get(runtime)?.resetWidgetPreview(widgetKey);
}

/**
 * True when the topmost live interactive component on `runtime` is a navigation view (`/tasks`) that already has an
 * unanswered cancel key in flight (or had an unanswered input in flight when a host-level cancel consumed `Esc`).
 */
export function hasUnansweredNavigationCancelInput(runtime: object, isCancel: (data: string) => boolean): boolean {
	return controllers.get(runtime)?.hasUnansweredNavigationCancelInput(isCancel) === true;
}

/** Record that a host-level `Esc` cancelled a pending open while the topmost live navigation component was mounted. */
export function noteNavigationHostCancel(runtime: object): void {
	controllers.get(runtime)?.noteNavigationHostCancel();
}

export function watchWidgetFrames(runtime: object, widgetKey: string): { drawn(): Promise<void>; stop(): void } {
	let watches = widgetFrameWatches.get(runtime);
	if (watches === undefined) {
		watches = new Set();
		widgetFrameWatches.set(runtime, watches);
	}
	const all = watches;
	const watch: WidgetFrameWatch = { widgetKey, opened: false, waiters: [] };
	all.add(watch);
	let stopped = false;
	return {
		drawn: async () => {
			while (!stopped) {
				if (watch.opened && controllers.get(runtime)?.widgetWithoutFrame(widgetKey) !== true) return;
				await new Promise<void>((resolve) => watch.waiters.push(resolve));
				// One read can close a widget and open its replacement: what is open once that read is handled decides.
			}
		},
		stop: () => {
			stopped = true;
			all.delete(watch);
			for (const resolve of watch.waiters.splice(0)) resolve();
		},
	};
}

function renderSettingsCacheKey(renderSettings: EngineHostRenderSettings | undefined): string {
	return renderSettings === undefined
		? ""
		: `${renderSettings.hideThinkingBlock}|${renderSettings.toolOutputExpanded}|${renderSettings.fullscreenScrollbar}|${renderSettings.fullscreenWheelScrollLines}`;
}

function overlayOptions(options: SerializableOverlayOptions | undefined): OverlayOptions | undefined {
	return options as OverlayOptions | undefined;
}

/**
 * Resolve the real host terminal from the pi-tui TUI handed to the overlay
 * factory. Optional: some hosts / test seams do not surface `tui.terminal`, in
 * which case terminal-mode controls harmlessly no-op.
 */
function hostTerminal(tui: TUI): { write(data: string): void } {
	const terminal = (tui as { terminal?: { write?(data: string): void } }).terminal;
	return typeof terminal?.write === "function" ? (terminal as { write(data: string): void }) : { write: () => {} };
}

export interface TuiRendererLifecycle {
	isFullscreen(): boolean;
	onRendererReplaced(listener: () => void): () => void;
	/** What the host's own chat shows; transcripts the engine paints in its overlays and widgets follow it. */
	chatRenderSettings?(): EngineHostRenderSettings;
	/**
	 * A navigation view began and the prompt's slot still shows the prompt: what it hides is still on screen until the
	 * view draws.
	 */
	navigationPending?(): boolean;
	/** Keep the navigation view the prompt's slot shows on screen until `ready` settles, as it closes. */
	keepPromptUntil?(ready: Promise<unknown>): void;
}

export class RemoteComponentController {
	private readonly mounted = new Map<string, MountedRemoteComponent>();
	private readonly unsubscribe: () => void;
	private readonly unsubscribeGenerationEnded: () => void;
	private readonly terminalModes: TerminalModeController;
	private readonly unsubscribeTuiRendererReplaced: () => void;

	private readonly runtime: RemoteComponentRuntime;
	private readonly ui: RemoteComponentUI;
	private readonly copyText: (text: string) => Promise<void>;
	private readonly tuiRendererLifecycle: TuiRendererLifecycle;
	/** The agent panel closed while a navigation view was on its way, still showing until that view draws. */
	private retiredPanel: RemoteComponent | undefined;
	/** The engine's second clear of the retired panel's slot, over the dialog channel, is still to come. */
	private retiredClearPending = false;
	/** The waits for the agent panel's first frame as a view that hid it closes (`engine_custom_done.panel`). */
	private readonly panelReturns = new Set<() => void>();

	constructor(
		runtime: RemoteComponentRuntime,
		ui: RemoteComponentUI,
		tuiRendererLifecycle: TuiRendererLifecycle,
		copyText: (text: string) => Promise<void> = copyToClipboard,
	) {
		this.runtime = runtime;
		this.ui = ui;
		this.copyText = copyText;
		this.tuiRendererLifecycle = tuiRendererLifecycle;
		this.terminalModes = new TerminalModeController(() => tuiRendererLifecycle.isFullscreen());
		this.unsubscribeTuiRendererReplaced = tuiRendererLifecycle.onRendererReplaced(() =>
			this.terminalModes.rebindTui(),
		);
		this.unsubscribe = runtime.onEngineMessage((message) => this.handleMessage(message));
		controllers.set(runtime, this);
		// Teardown is driven by engine death rather than the NEXT generation's
		// `engine_ready`, so a crash with no restart, or a hung/failed restart,
		// still releases the host editor, focus, and inline-custom-UI depth.
		this.unsubscribeGenerationEnded = runtime.onGenerationEnded(() => this.disposeAll("generation-lost"));
	}

	dispose(): void {
		if (controllers.get(this.runtime) === this) controllers.delete(this.runtime);
		this.unsubscribeTuiRendererReplaced();
		this.unsubscribe();
		this.unsubscribeGenerationEnded();
		this.disposeAll("host-shutdown");
	}

	/** The mode of the host's current renderer, which engine components lay themselves out for. */
	private hostMode(): TuiMode {
		return this.tuiRendererLifecycle.isFullscreen() ? "fullscreen" : "regular";
	}

	/** The remote overlay proxy that currently holds focus (see remote-input-ownership.ts). */
	focusedRemoteOverlay(): unknown {
		for (const record of this.mounted.values()) {
			if (record.handle?.isFocused() === true) return record.component;
		}
		return undefined;
	}

	/** `component` itself when it is one of this generation's live non-widget proxies. */
	remoteProxyOwner(component: unknown): unknown {
		if (!(component instanceof RemoteComponent)) return undefined;
		for (const record of this.mounted.values()) {
			if (record.component === component)
				return record.widgetKey === undefined && record.transcript === undefined ? component : undefined;
		}
		return undefined;
	}

	/** True when the extension that mounted `component` declared it binds Ctrl+C. */
	remoteProxyHandlesCtrlC(component: unknown): boolean {
		for (const record of this.mounted.values()) {
			if (record.component === component) return record.handlesCtrlC;
		}
		return false;
	}

	/**
	 * Close exactly one live proxy through the ordinary host close path.
	 *
	 * The host escape from a component that traps Ctrl+C, and deliberately not
	 * `disposeAll()`: that is generation-death teardown, which would also close
	 * unrelated nested components and suppress the child notification. Here the
	 * record stays registered while `done` runs, so `showExtensionCustom()`
	 * hides this overlay (or remounts the editor) and its finalizer disposes the
	 * proxy normally — which tells the healthy child to resolve its own
	 * `ui.custom()` promise with `undefined`, exactly like a user cancel.
	 */
	dismissRemoteProxy(component: unknown): boolean {
		for (const record of this.mounted.values()) {
			if (record.component !== component || record.widgetKey !== undefined || record.transcript !== undefined)
				continue;
			record.done(undefined);
			this.ui.requestRender();
			return true;
		}
		return false;
	}

	private releaseWidget(widgetKey: string): void {
		for (const [componentId, record] of this.mounted) {
			if (record.widgetKey !== widgetKey) continue;
			this.mounted.delete(componentId);
			record.unsubscribeWidgetRelease?.();
			record.unsubscribeWidgetRelease = undefined;
			this.terminalModes.onUnmount(componentId);
		}
		this.checkWidgetFrames();
	}

	/**
	 * The widgets open under `widgetKey`, and those the engine opens under it within `capMs`, show nothing until a frame
	 * asked for from now on comes (or `capMs` passes): what they have may draw what the screen no longer shows.
	 */
	hideWidgetFramesUntilFresh(widgetKey: string, capMs: number): void {
		this.hideOpening.set(widgetKey, performance.now() + capMs);
		for (const record of this.mounted.values())
			if (record.widgetKey === widgetKey) record.component.hideFramesUntilFresh(capMs);
	}

	stageWidgetPreview(widgetKey: string, previewSeq: number, tagged: boolean): void {
		this.hideOpening.delete(widgetKey);
		this.previewGates.set(widgetKey, { kind: "staged", previewSeq, tagged });
		for (const record of this.mounted.values())
			if (record.widgetKey === widgetKey) record.component.stagePreview(previewSeq, tagged);
	}

	commitWidgetPreview(widgetKey: string, previewSeq: number): void {
		this.hideOpening.delete(widgetKey);
		this.previewGates.set(widgetKey, { kind: "committed", promotedSeq: previewSeq });
		for (const record of this.mounted.values())
			if (record.widgetKey === widgetKey) record.component.commitPreview(previewSeq);
	}

	cancelWidgetPreview(widgetKey: string, legacyHideCapMs?: number): void {
		this.previewGates.delete(widgetKey);
		if (legacyHideCapMs !== undefined) this.hideOpening.set(widgetKey, performance.now() + legacyHideCapMs);
		for (const record of this.mounted.values())
			if (record.widgetKey === widgetKey) record.component.cancelPreview(legacyHideCapMs);
	}

	clearPromotedWidgetPreview(widgetKey: string): void {
		const gate = this.previewGates.get(widgetKey);
		if (gate?.kind === "committed" && gate.promotedSeq !== undefined) this.previewGates.delete(widgetKey);
		for (const record of this.mounted.values())
			if (record.widgetKey === widgetKey) record.component.clearPromotedPreview();
	}

	resetWidgetPreview(widgetKey: string): void {
		this.previewGates.delete(widgetKey);
		this.hideOpening.delete(widgetKey);
		for (const record of this.mounted.values()) if (record.widgetKey === widgetKey) record.component.cancelPreview();
	}

	private topmostLiveNavigationComponent(): RemoteComponent | undefined {
		const records = [...this.mounted.values()];
		for (let i = records.length - 1; i >= 0; i--) {
			const record = records[i]!;
			if (record.widgetKey !== undefined || record.transcript !== undefined) continue;
			if (record.purpose !== "navigation" || record.engineDone) return undefined;
			return record.component;
		}
		return undefined;
	}

	hasUnansweredNavigationCancelInput(isCancel: (data: string) => boolean): boolean {
		return this.topmostLiveNavigationComponent()?.hasUnansweredCancelInput(isCancel) === true;
	}

	noteNavigationHostCancel(): void {
		this.topmostLiveNavigationComponent()?.noteHostCancel();
	}

	private readonly hideOpening = new Map<string, number>();
	private readonly previewGates = new Map<string, WidgetPreviewGate>();

	/** Whether a widget open under `widgetKey` has not drawn its first frame yet. */
	widgetWithoutFrame(widgetKey: string): boolean {
		for (const record of this.mounted.values())
			if (record.widgetKey === widgetKey && record.component.awaitingFirstContent()) return true;
		return false;
	}

	/** Answer the waits for widgets to draw (`watchWidgetFrames`) that nothing keeps waiting now. */
	private checkWidgetFrames(): void {
		const watches = widgetFrameWatches.get(this.runtime);
		if (watches === undefined || watches.size === 0) return;
		for (const watch of watches) {
			if (watch.waiters.length === 0 || !watch.opened || this.widgetWithoutFrame(watch.widgetKey)) continue;
			for (const resolve of watch.waiters.splice(0)) resolve();
		}
	}
	/**
	 * Close every mounted component.
	 *
	 * `"generation-lost"` closes through the real host close path: it hides the
	 * overlay or remounts the editor into `editorContainer`, restores the saved
	 * draft and focus, releases `blockingInlineCustomUiDepth`, and resolves the
	 * extension's `ui.custom()` promise. Records are removed BEFORE each `done`
	 * runs so the settlement path cannot re-enter the controller, and proxy
	 * disposal is local-only because the writer already points at a replacement
	 * child whose component IDs restart at `remote_component_1`.
	 *
	 * Order is newest-first, matching the TUI's overlay stack. Closing oldest
	 * first would let an overlay mounted above an inline proxy restore focus to
	 * that inline proxy after it had already been disposed.
	 *
	 * `"host-shutdown"` notifies the still-live engine child instead and leaves
	 * host mounts alone: the TUI is already stopping and must not repaint.
	 */
	private disposeAll(reason: "generation-lost" | "host-shutdown"): void {
		this.previewGates.clear();
		this.hideOpening.clear();
		for (const stop of [...this.panelReturns]) stop();
		// Its engine closed it already, and a replacement engine reuses component ids: no message about it.
		this.releaseRetiredPanel(undefined, false);
		const records = [...this.mounted.entries()].reverse();
		this.mounted.clear();
		for (const [componentId, record] of records) {
			this.terminalModes.onUnmount(componentId);
			record.unsubscribeWidgetRelease?.();
			record.component.dispose(reason === "host-shutdown" && !record.engineDone);
			if (record.transcript) this.closeTranscript(record.transcript);
			else if (record.widgetKey) this.ui.setWidget(record.widgetKey, undefined);
			else if (reason === "generation-lost") record.done(undefined);
		}
		this.terminalModes.resetAll();
		this.checkWidgetFrames();
		if (reason === "generation-lost" && records.length > 0) this.ui.requestRender();
	}

	private handleMessage(message: InteractiveEngineMessage): void {
		switch (message.type) {
			case "engine_ready":
				// Idempotent fallback for a generation replacement whose death event
				// was already handled: stale records must be gone before the new child
				// can reuse `remote_component_1`, and any terminal modes the dead
				// generation left on are reset here too.
				this.disposeAll("generation-lost");
				break;
			case "engine_custom_open":
				this.open(
					message.componentId,
					message.overlay,
					message.deferInlineCustomUiFocus,
					message.overlayOptions,
					message.widgetKey,
					message.widgetPlacement,
					message.handlesCtrlC === true,
					message.handlesInternalUiAction === true,
					message.reserveTranscriptRows === true,
					message.purpose,
					message.widgetScroll,
					message.blocked,
					message.placement === "transcript" ? message.viewId : undefined,
				);
				break;
			case "engine_custom_close":
				this.close(message.componentId);
				break;
			case "engine_custom_frame": {
				const record = this.mounted.get(message.componentId);
				record?.component.applyFrame(
					message.requestId,
					message.lines,
					message.scrollRequest,
					message.frame,
					message.rowKeys,
					message.layout,
					message.previewSeq,
				);
				if (record?.widgetKey !== undefined) this.checkWidgetFrames();
				// The view the retired panel gave way to draws now: the panel leaves with the same paint.
				else if (this.retiredPanel !== undefined) this.releaseRetiredPanelWhenDrawn();
				break;
			}
			case "engine_custom_input_result":
				this.mounted.get(message.componentId)?.component.resolveInput(message.requestId, message.handled);
				break;
			case "engine_custom_invalidate":
				this.mounted.get(message.componentId)?.component.requestRemoteRender();
				break;
			case "engine_custom_copy":
				void (async () => {
					let error: string | undefined;
					try {
						if (!this.mounted.has(message.componentId)) throw new Error("Sign-in screen is no longer open");
						await this.copyText(message.text);
					} catch (cause) {
						error = cause instanceof Error ? cause.message : String(cause);
					}
					this.runtime.sendEngineCommand({
						type: "engine_custom_copy_result",
						componentId: message.componentId,
						requestId: message.requestId,
						error,
					});
				})();
				break;
			case "engine_custom_terminal":
				this.terminalModes.applyControl(message.componentId, message.control);
				break;
			case "engine_custom_done": {
				const record = this.mounted.get(message.componentId);
				if (record) {
					record.engineDone = true;
					// The agent panel this view hid opens again as it closes: the view stays on screen until it draws.
					if (
						message.panel === true &&
						record.widgetKey === undefined &&
						record.transcript === undefined &&
						record.handle === undefined
					)
						this.keepPromptForPanel();
					record.done(message.result);
					this.releaseRetiredPanelWhenDrawn();
				}
				break;
			}
			case "engine_custom_control":
				this.control(message.componentId, message.action);
				break;
		}
	}

	private open(
		componentId: string,
		overlay: boolean,
		deferInlineCustomUiFocus: boolean | undefined,
		options: SerializableOverlayOptions | undefined,
		widgetKey?: string,
		widgetPlacement?: "aboveEditor" | "belowEditor",
		handlesCtrlC = false,
		handlesInternalUiAction = false,
		reserveTranscriptRows = false,
		purpose?: "prompt" | "navigation",
		widgetScroll?: { maxHeight: number; maxHeightFraction?: number },
		blocked?: EngineBlockedStatus,
		transcriptViewId?: string,
	): void {
		if (this.mounted.has(componentId)) return;
		if (transcriptViewId !== undefined) {
			this.openTranscript(componentId, transcriptViewId);
			return;
		}
		if (widgetKey) {
			let getRows = () => 24;
			let paintNow = () => this.ui.requestRender();
			const component = new RemoteComponent(
				componentId,
				this.runtime,
				() => this.ui.requestRender(),
				() => getRows(),
				() => this.hostMode(),
				handlesInternalUiAction,
				() => this.tuiRendererLifecycle.chatRenderSettings?.(),
				() => paintNow(),
			);
			const unsubscribeWidgetRelease = this.ui.onWidgetRelease?.(widgetKey, () => this.releaseWidget(widgetKey));
			this.mounted.set(componentId, {
				component,
				done: () => {},
				engineDone: false,
				handlesCtrlC,
				handlesInternalUiAction,
				widgetKey,
				unsubscribeWidgetRelease,
			});
			for (const watch of widgetFrameWatches.get(this.runtime) ?? [])
				if (watch.widgetKey === widgetKey) watch.opened = true;
			const previewGate = this.previewGates.get(widgetKey);
			if (previewGate?.kind === "staged") {
				component.stagePreview(previewGate.previewSeq, previewGate.tagged);
			} else if (previewGate?.kind === "committed" && previewGate.promotedSeq !== undefined) {
				component.commitPreview(previewGate.promotedSeq);
			}
			const hideFor = (this.hideOpening.get(widgetKey) ?? 0) - performance.now();
			if (hideFor > 0) component.hideFramesUntilFresh(hideFor);
			// The panel opened again replaces the one still showing.
			if (widgetKey === AGENT_PANEL_WIDGET_KEY && this.retiredPanel !== undefined) {
				this.retiredPanel.dispose();
				this.retiredPanel = undefined;
				this.retiredClearPending = false;
			}
			this.ui.setWidget(
				widgetKey,
				(tui) => {
					component.hostColorDepth = tui.terminal?.colorDepth;
					getRows = () => tui.terminal.rows;
					paintNow = () => tui.requestImmediateRender();
					// The view that hid the agent panel stays on screen until the panel draws: ask for its frame now, as
					// nothing paints it before then.
					if (widgetKey === AGENT_PANEL_WIDGET_KEY && this.panelReturns.size > 0)
						component.prime(Math.max(1, tui.terminal.columns), tui.terminal.rows);
					return component;
				},
				{ placement: widgetPlacement, ...(widgetScroll ? { scroll: widgetScroll } : {}) },
			);
			return;
		}
		let mounted: MountedRemoteComponent | undefined;
		void this.ui
			.custom<JsonValue | undefined>(
				(tui, _theme, _keybindings, done) => {
					const component = new RemoteComponent(
						componentId,
						this.runtime,
						() => this.ui.requestRender(),
						() => tui.terminal.rows,
						() => this.hostMode(),
						handlesInternalUiAction,
						() => this.tuiRendererLifecycle.chatRenderSettings?.(),
						() => tui.requestImmediateRender(),
					);
					component.hostColorDepth = tui.terminal?.colorDepth;
					// In the prompt's place, the rows there stay until its first frame is here.
					if (!overlay) awaitFirstContent(component, () => component.awaitingFirstContent());
					mounted = { component, done, engineDone: false, handlesCtrlC, handlesInternalUiAction, purpose };
					this.mounted.set(componentId, mounted);
					// Bind this component to the real host terminal so a buffered
					// autowrap control emitted before the mount frame applies to the host TTY.
					this.terminalModes.onMount(componentId, hostTerminal(tui));
					return component;
				},
				{
					overlay,
					purpose,
					deferInlineCustomUiFocus,
					handlesInternalUiAction,
					reserveTranscriptRows,
					overlayOptions: overlayOptions(options),
					blocked,
					onHandle: (handle) => {
						if (mounted) mounted.handle = handle;
					},
				},
			)
			.catch(() => undefined)
			.finally(() => {
				this.terminalModes.onUnmount(componentId);
				const record = this.mounted.get(componentId);
				if (!record) return;
				this.mounted.delete(componentId);
				if (record.engineDone) record.component.dispose(false);
				else record.component.dispose();
			});
	}

	private close(componentId: string): void {
		const record = this.mounted.get(componentId);
		if (!record) return;
		this.terminalModes.onUnmount(componentId);
		this.mounted.delete(componentId);
		record.unsubscribeWidgetRelease?.();
		if (this.retirePanel(record)) {
			if (record.widgetKey !== undefined) this.checkWidgetFrames();
			return;
		}
		if (record.transcript) this.closeTranscript(record.transcript);
		else if (record.widgetKey) this.ui.setWidget(record.widgetKey, undefined);
		record.component.dispose();
		if (record.widgetKey !== undefined) this.checkWidgetFrames();
	}

	/**
	 * The agent panel the engine closed as a navigation view opens in the prompt's place: until that view draws, the
	 * panel's last frame stays on screen with the prompt, so the screen goes from both to the view in one frame. Answers
	 * whether it kept it.
	 */
	private retirePanel(record: MountedRemoteComponent): boolean {
		const pending = this.tuiRendererLifecycle.navigationPending;
		if (record.widgetKey !== AGENT_PANEL_WIDGET_KEY || pending === undefined || !pending()) return false;
		this.releaseRetiredPanel();
		const component = record.component;
		const retired = component.retire(() => {
			if (this.retiredPanel === component && pending()) return true;
			queueMicrotask(() => this.releaseRetiredPanel(component));
			return false;
		});
		// Never painted: nothing of it is on screen to keep.
		if (!retired) return false;
		this.retiredPanel = component;
		this.retiredClearPending = true;
		this.ui.requestRender();
		return true;
	}

	/**
	 * Whether a clear of widget `key` from the dialog channel is the engine's echo of closing the retired agent panel,
	 * which this controller removes itself once the view it gave way to draws: once, for that panel only.
	 */
	takeRetiredWidgetClear(key: string): boolean {
		if (key !== AGENT_PANEL_WIDGET_KEY || this.retiredPanel === undefined || !this.retiredClearPending) return false;
		this.retiredClearPending = false;
		return true;
	}

	/** Widget `key` was written by another channel: a retired agent panel there is replaced, and leaves as it is. */
	supersedeRetiredWidget(key: string): void {
		if (key !== AGENT_PANEL_WIDGET_KEY || this.retiredPanel === undefined) return;
		this.retiredPanel.dispose();
		this.retiredPanel = undefined;
		this.retiredClearPending = false;
	}

	/** Remove the retired agent panel once navigation is no longer pending: the view it gave way to draws, or is gone. */
	private releaseRetiredPanelWhenDrawn(): void {
		if (this.retiredPanel === undefined) return;
		if (this.tuiRendererLifecycle.navigationPending?.() !== true) this.releaseRetiredPanel();
	}

	/** Remove the retired agent panel (or only `component`, when it is still the retired one) from the screen. */
	private releaseRetiredPanel(component?: RemoteComponent, notifyEngine = true): void {
		const retired = this.retiredPanel;
		if (retired === undefined || (component !== undefined && component !== retired)) return;
		this.retiredPanel = undefined;
		this.retiredClearPending = false;
		retired.dispose(notifyEngine);
		// A panel the engine opened since replaced it under the same key: that one stays.
		if (![...this.mounted.values()].some((record) => record.widgetKey === AGENT_PANEL_WIDGET_KEY))
			this.ui.setWidget(AGENT_PANEL_WIDGET_KEY, undefined);
		this.ui.requestRender();
	}

	/** A view that hid the agent panel closes: the prompt's slot keeps it until the panel's first frame, bounded. */
	private keepPromptForPanel(): void {
		const keep = this.tuiRendererLifecycle.keepPromptUntil;
		if (keep === undefined) return;
		const watch = watchWidgetFrames(this.runtime, AGENT_PANEL_WIDGET_KEY);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = () => {
			clearTimeout(timer);
			this.panelReturns.delete(stop);
			watch.stop();
		};
		this.panelReturns.add(stop);
		timer = setTimeout(stop, PROMPT_SLOT_HOLD_MS);
		timer.unref?.();
		keep(watch.drawn().finally(stop));
	}

	/**
	 * A viewed subagent's transcript: drawn by the host's transcript area at the rows it gives, never mounted as custom
	 * UI, so it blocks nothing and takes focus only when the area gives it.
	 */
	private openTranscript(componentId: string, viewId: string): void {
		let mount: RemoteTranscriptMount | undefined;
		const component = new RemoteComponent(
			componentId,
			this.runtime,
			() => this.ui.requestRender(),
			() => mount?.rows ?? 24,
			() => this.hostMode(),
			false,
			() => this.tuiRendererLifecycle.chatRenderSettings?.(),
		);
		mount = new RemoteTranscriptMount(componentId, viewId, component);
		const views = transcriptMounts.get(this.runtime) ?? new Map<string, RemoteTranscriptMount>();
		transcriptMounts.set(this.runtime, views);
		views.get(viewId)?.markClosed();
		views.set(viewId, mount);
		this.mounted.set(componentId, {
			component,
			done: () => {},
			engineDone: false,
			handlesCtrlC: false,
			handlesInternalUiAction: false,
			transcript: mount,
		});
	}

	private closeTranscript(mount: RemoteTranscriptMount): void {
		const views = transcriptMounts.get(this.runtime);
		if (views?.get(mount.viewId) === mount) views.delete(mount.viewId);
		mount.markClosed();
		this.ui.requestRender();
	}

	private control(componentId: string, action: "focus" | "hide" | "show" | "unfocus"): void {
		const handle = this.mounted.get(componentId)?.handle;
		if (!handle) return;
		switch (action) {
			case "focus":
				handle.focus();
				break;
			case "hide":
				handle.setHidden(true);
				break;
			case "show":
				handle.setHidden(false);
				break;
			case "unfocus":
				handle.unfocus();
				break;
		}
	}
}
