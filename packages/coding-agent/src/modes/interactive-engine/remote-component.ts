import {
	type Component,
	isHintActivation,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	type TuiMode,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.js";
import type { WidgetScrollRequest, WidgetScrollState } from "../../core/extensions/ui-types.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { isSingleLeftClick } from "../interactive/components/single-click.ts";
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

export type RemoteComponentRuntime = Pick<
	IsolatedInteractiveRuntime,
	"onEngineMessage" | "onGenerationEnded" | "sendEngineCommand"
>;

export type RemoteComponentUI = Pick<ExtensionUIContext, "custom" | "requestRender" | "setWidget" | "onWidgetRelease">;

interface MountedRemoteComponent {
	component: RemoteComponent;
	done: (result: JsonValue | undefined) => void;
	engineDone: boolean;
	/** The extension declared that this component binds Ctrl+C itself. */
	handlesCtrlC: boolean;
	/** The extension declared that this component claims internal UI actions. */
	handlesInternalUiAction: boolean;
	handle?: OverlayHandle;
	widgetKey?: string;
	unsubscribeWidgetRelease?: () => void;
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
	acceptsClickFocus = true;
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
	/** The number of the last click forwarded to the engine. */
	private clickId = 0;
	private dirty = true;
	private disposed = false;
	private readonly pendingInputs = new Map<number, PendingInput>();
	/** Handled keys whose frame has not arrived yet. */
	private readonly answeredInputs = new Set<number>();
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

	render(width: number): string[] {
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
		this.paintedFrame = this.frame;
		this.paintedRowKeys = this.rowKeys;
		return this.frameClamp.clamp(this.lines, width);
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
		if (this.disposed || !isSingleLeftClick(event) || this.paintedFrame === undefined) return undefined;
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
			if (this.disposed) return;
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
		if (this.disposed) return Promise.resolve(undefined);
		const requestId = ++this.inputRequestId;
		const frameRequestId = this.width > 0 ? this.requestId + 1 : undefined;
		const result = new Promise<boolean | undefined>((resolve) => {
			const timer = setTimeout(() => this.resolveInput(requestId, false), REMOTE_INPUT_REPLY_TIMEOUT_MS);
			timer.unref?.();
			this.pendingInputs.set(requestId, { resolve, timer, frameRequestId });
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

	invalidate(): void {
		this.dirty = true;
	}

	applyFrame(
		requestId: number,
		lines: string[],
		scrollRequest?: WidgetScrollRequest,
		frame?: number,
		rowKeys?: readonly string[],
	): void {
		if (this.disposed || requestId < this.appliedRequestId) return;
		this.appliedRequestId = requestId;
		this.lines = lines;
		this.frame = frame;
		this.rowKeys = rowKeys;
		this.scrollRequest = scrollRequest;
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
		for (const requestId of [...this.pendingInputs.keys()]) this.resolveInput(requestId, undefined);
		if (notifyEngine)
			this.runtime.sendEngineCommand({ type: "engine_custom_dispose", componentId: this.componentId });
	}
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
		// Teardown is driven by engine death rather than the NEXT generation's
		// `engine_ready`, so a crash with no restart, or a hung/failed restart,
		// still releases the host editor, focus, and inline-custom-UI depth.
		this.unsubscribeGenerationEnded = runtime.onGenerationEnded(() => this.disposeAll("generation-lost"));
	}

	dispose(): void {
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
			if (record.component === component) return record.widgetKey === undefined ? component : undefined;
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
			if (record.component !== component || record.widgetKey !== undefined) continue;
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
		const records = [...this.mounted.entries()].reverse();
		this.mounted.clear();
		for (const [componentId, record] of records) {
			this.terminalModes.onUnmount(componentId);
			record.unsubscribeWidgetRelease?.();
			record.component.dispose(reason === "host-shutdown" && !record.engineDone);
			if (record.widgetKey) this.ui.setWidget(record.widgetKey, undefined);
			else if (reason === "generation-lost") record.done(undefined);
		}
		this.terminalModes.resetAll();
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
					message.acceptsClickFocus !== false,
				);
				break;
			case "engine_custom_close":
				this.close(message.componentId);
				break;
			case "engine_custom_frame":
				this.mounted
					.get(message.componentId)
					?.component.applyFrame(
						message.requestId,
						message.lines,
						message.scrollRequest,
						message.frame,
						message.rowKeys,
					);
				break;
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
					record.done(message.result);
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
		acceptsClickFocus = true,
	): void {
		if (this.mounted.has(componentId)) return;
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
			component.acceptsClickFocus = acceptsClickFocus;
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
			this.ui.setWidget(
				widgetKey,
				(tui) => {
					component.hostColorDepth = tui.terminal?.colorDepth;
					getRows = () => tui.terminal.rows;
					paintNow = () => tui.requestImmediateRender();
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
					component.acceptsClickFocus = acceptsClickFocus;
					component.hostColorDepth = tui.terminal?.colorDepth;
					mounted = { component, done, engineDone: false, handlesCtrlC, handlesInternalUiAction };
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
		if (record.widgetKey) this.ui.setWidget(record.widgetKey, undefined);
		record.component.dispose();
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
