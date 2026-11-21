import {
	type Component,
	isKeyRelease,
	type OverlayHandle,
	type OverlayOptions,
	runAsHintActivation,
	type Terminal,
	type TUI,
	TuiMainScreen,
	type TuiMode,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@bastani/atomic-tui";
import { getAgentDir } from "../../config.js";
import { runCallback, runSynchronousCallback } from "../../core/callback-activity.ts";
import type { HostCustomUiState, HostCustomUiStateListener } from "../../core/extensions/index.js";
import type { ScrollableWidgetComponent, WidgetScrollRequest } from "../../core/extensions/ui-types.js";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { sourceError } from "../../core/tasks/agent-panel-source.ts";
import { ensurePngTranscoder } from "../../utils/image-convert.ts";
import { agentPanelReturning } from "../interactive/agent-panel-return.ts";
import { runRendererCleanup } from "../interactive/components/renderer-disposal.js";
import type { Theme } from "../interactive/theme/theme.js";
import { theme } from "../interactive/theme/theme.js";
import { BackgroundRenderLane, BackgroundRenderTui } from "./background-render-lane.ts";
import {
	type EngineBlockedStatus,
	type EngineHostRenderSettings,
	type EngineTerminalControl,
	type InteractiveEngineMessage,
	isJsonValue,
	type JsonValue,
	parseInteractiveEngineCommand,
	type SerializableOverlayOptions,
	serializeInteractiveEngineMessage,
} from "./protocol.ts";
import { transcriptLayoutOf } from "./transcript-frame-layout.ts";

interface CustomUiOptions {
	purpose?: "prompt" | "navigation";
	overlay?: boolean;
	deferInlineCustomUiFocus?: boolean;
	/** The component binds Ctrl+C itself; see ExtensionUIContext.custom options. */
	handlesCtrlC?: boolean;
	/** The component claims internal UI actions such as the jump-to-bottom URL. */
	handlesInternalUiAction?: boolean;
	/** Bound this overlay and reserve transcript scroll extent on the host. */
	reserveTranscriptRows?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
	signal?: AbortSignal;
	/** Report the host as blocked on user input: inline while visible, an overlay until `done()`. */
	blocked?: EngineBlockedStatus;
}

interface ActiveComponent {
	component: Component & { dispose?(): void };
	/** A viewed subagent's transcript, which the host draws in its transcript area rather than as custom UI. */
	transcript?: true;
	resolve: (value: JsonValue | undefined) => void;
	overlay: boolean;
	purpose?: "prompt" | "navigation";
	terminal: RemoteTerminal;
	tui: TUI;
	widgetKey?: string;
	/** The host renderer's mode from this component's latest frame request, which its TUI reports as `mode`. */
	hostMode?: TuiMode;
	/**
	 * Overlay visibility as last driven through the remote OverlayHandle.
	 * Hidden components are skipped by the extension-level `requestRender()`
	 * broadcast (#1856) — invalidating a hidden overlay only produced host
	 * render work and terminal writes for frames the user cannot see.
	 */
	hidden?: boolean;
	/** The latest frame request from the host; a custom component pushes its frames only once the host laid it out. */
	lastRequestId?: number;
	/** The frame the host holds, so a repaint that changed nothing sends nothing. */
	lastFrame?: {
		readonly lines: readonly string[];
		readonly scrollRequest: WidgetScrollRequest | undefined;
		readonly rowKeys: readonly string[] | undefined;
	};
	/** The next frame answers a host request and is sent even when it is unchanged. */
	frameRequested?: boolean;
	/** The number of the last frame sent; a click on any other frame is dropped. */
	frame?: number;
	/** A hidden component changed and the host was told to ask for a frame once it shows it again. */
	staleWhileHidden?: boolean;
	handlingInput?: boolean;
	paintAfterInput?: boolean;
	/** What clicks the component took leave for when they turn out single, by the host's click number. */
	singleClickActions?: Map<number, TuiMouseEventResult>;
}

/** Older hosts sent numbered clicks but never told the engine which ones they canceled. */
const LEGACY_WAITING_SINGLE_CLICKS = 16;

/**
 * The engine-side TUI of one custom component. Its paced renders paint the component once and push the frame to the
 * host, instead of rendering it once here to detect a change and again when the host asks for the frame.
 */
class RemoteComponentTui extends TuiMainScreen {
	private readonly paint: () => void;
	/** A frame was asked for and is not painted yet: its paced render has not run. */
	private framePending = false;

	constructor(terminal: Terminal, paint: () => void) {
		super(terminal, undefined, getAgentDir());
		this.paint = paint;
	}

	override requestRender(force?: boolean): void {
		this.framePending = true;
		super.requestRender(force);
	}

	override requestImmediateRender(): void {
		this.framePending = true;
		super.requestImmediateRender();
	}

	/** Paint the frame asked for now, ahead of its paced render; nothing when every asked-for frame is painted. */
	paintPendingFrame(): void {
		if (this.framePending) this.renderNow();
	}

	protected override doRender(): void {
		this.framePending = false;
		if (!this.stopped) this.paint();
	}
}

class RemoteTerminal implements Terminal {
	colorDepth?: number;
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private readonly invalidate: () => void;
	private readonly control: ((control: EngineTerminalControl) => void) | undefined;
	private readonly copy: ((requestId: number, text: string) => void) | undefined;
	private nextCopyId = 0;
	private readonly pendingCopies = new Map<
		number,
		{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	constructor(
		invalidate: () => void,
		control?: (control: EngineTerminalControl) => void,
		copy?: (requestId: number, text: string) => void,
	) {
		this.invalidate = invalidate;
		this.control = control;
		this.copy = copy;
	}
	copyTextToHost(text: string): Promise<void> {
		if (!this.copy) return Promise.reject(new Error("Host clipboard unavailable"));
		return new Promise((resolve, reject) => {
			const requestId = ++this.nextCopyId;
			const timer = setTimeout(() => {
				this.pendingCopies.delete(requestId);
				reject(new Error("Host clipboard did not respond"));
			}, 15_000);
			this.pendingCopies.set(requestId, { resolve, reject, timer });
			this.copy?.(requestId, text);
		});
	}
	resolveCopy(requestId: number, error?: string): void {
		const pending = this.pendingCopies.get(requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingCopies.delete(requestId);
		if (error) pending.reject(new Error(error));
		else pending.resolve();
	}
	close(): void {
		for (const requestId of this.pendingCopies.keys()) this.resolveCopy(requestId, "Sign-in screen closed");
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {
		this.invalidate();
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	/** Ask the host to toggle host-TTY autowrap (DECAWM) for this component. */
	setAutowrap(enabled: boolean): void {
		this.control?.({ kind: "autowrap", enabled });
	}
}

function serializableOverlayOptions(
	options: CustomUiOptions["overlayOptions"],
): SerializableOverlayOptions | undefined {
	const value = typeof options === "function" ? options() : options;
	if (!value) return undefined;
	const { anchor, col, margin, maxHeight, minWidth, offsetX, offsetY, row, width } = value;
	return { anchor, col, margin, maxHeight, minWidth, offsetX, offsetY, row, width };
}

function sameFrame(
	frame: NonNullable<ActiveComponent["lastFrame"]>,
	lines: readonly string[],
	scrollRequest: WidgetScrollRequest | undefined,
	rowKeys: readonly string[] | undefined,
): boolean {
	if (frame.lines.length !== lines.length) return false;
	for (let index = 0; index < lines.length; index++) if (frame.lines[index] !== lines[index]) return false;
	// The same text drawn for other items is another frame: a click on it must not act on the new item.
	if ((frame.rowKeys === undefined) !== (rowKeys === undefined)) return false;
	if (frame.rowKeys && rowKeys && frame.rowKeys.some((key, index) => key !== rowKeys[index])) return false;
	return JSON.stringify(frame.scrollRequest) === JSON.stringify(scrollRequest);
}

/** What `component` reports it drew on each of its `count` rows, when it reports anything. */
function rowKeysOf(component: Component, count: number): string[] | undefined {
	const key = component.paintedRowKey;
	if (key === undefined) return undefined;
	return Array.from({ length: count }, (_, row) => key.call(component, row) ?? "");
}

function jsonResult(value: object | boolean | null | number | string | undefined): JsonValue | undefined {
	if (value === undefined) return undefined;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) return undefined;
	const decoded = JSON.parse(encoded) as JsonValue;
	if (!isJsonValue(decoded)) throw new Error("Custom UI result is not JSON-safe");
	return decoded;
}

const GENERIC_SOURCE_FAILURE = sourceError(Object.create(null)).message;

function renderError(error: unknown): Error {
	const message = sourceError(error).message;
	return new Error(message === GENERIC_SOURCE_FAILURE ? "Remote component render failed." : message);
}

export class EngineCustomUiService {
	private readonly widgetIds = new Map<string, string>();
	private readonly active = new Map<string, ActiveComponent>();
	private nextId = 0;
	private readonly write: (line: string) => void;
	private readonly keybindings: KeybindingsManager;
	private readonly stateListeners = new Set<HostCustomUiStateListener>();
	private readonly widgetReleaseListeners = new Map<string, Set<() => void>>();
	/** Widget renders and repaint checks; keyboard input and custom UI frames never wait in it. */
	private readonly backgroundRenders = new BackgroundRenderLane();
	private hostRenderSettings: EngineHostRenderSettings | undefined;
	/** The host renderer's mode from the latest frame request of any component. */
	private latestHostMode: TuiMode | undefined;

	/** The host chat settings the latest render request carried; undefined before the host sent any. */
	getHostRenderSettings(): EngineHostRenderSettings | undefined {
		return this.hostRenderSettings;
	}

	setWidget(
		key: string,
		factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		placement?: "aboveEditor" | "belowEditor",
		scroll?: { maxHeight: number; maxHeightFraction?: number },
	): void {
		const previous = this.widgetIds.get(key);
		if (previous) this.disposeComponent(previous, false, false);
		if (!factory) {
			this.notifyWidgetRelease(key);
			return;
		}
		const componentId = `remote_widget_${++this.nextId}`;
		this.widgetIds.set(key, componentId);
		const terminal = new RemoteTerminal(() => this.send({ type: "engine_custom_invalidate", componentId }));
		const tui = new BackgroundRenderTui(terminal, this.backgroundRenders, `check:${componentId}`, (error) =>
			this.sendComponentRenderFailure(componentId, error),
		);
		this.followHostMode(tui, componentId);
		ensurePngTranscoder(() => {
			tui.invalidate();
			tui.requestRender();
		});
		void runCallback({ kind: "renderer", name: `widget:${key}` }, () => factory(tui, theme))
			.then((component) => {
				if (this.widgetIds.get(key) !== componentId) {
					component.dispose?.();
					tui.stop();
					return;
				}
				tui.addChild(component);
				this.active.set(componentId, {
					component,
					resolve: () => {},
					overlay: false,
					terminal,
					tui,
					widgetKey: key,
				});
				this.send({
					type: "engine_custom_open",
					componentId,
					overlay: false,
					widgetKey: key,
					widgetPlacement: placement,
					...(scroll ? { widgetScroll: scroll } : {}),
				});
			})
			.catch((error: unknown) => {
				if (this.widgetIds.get(key) === componentId) this.widgetIds.delete(key);
				tui.stop();
				this.send({
					type: "engine_custom_frame",
					componentId,
					requestId: 0,
					lines: [`Widget ${key} failed: ${renderError(error).message}`],
				});
			});
	}
	constructor(write: (line: string) => void, keybindings: KeybindingsManager) {
		this.write = write;
		this.keybindings = keybindings;
	}

	async custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: CustomUiOptions,
	): Promise<T> {
		const componentId = `remote_component_${++this.nextId}`;
		let resolveCompletion!: (value: T) => void;
		const completion = new Promise<T>((resolve) => {
			resolveCompletion = resolve;
		});
		let opened = false;
		let pendingDone: T | undefined;
		let doneCalled = false;
		const done = (result: T): void => {
			if (doneCalled) return;
			doneCalled = true;
			pendingDone = result;
			resolveCompletion(result);
			if (opened) this.sendDone(componentId, result);
		};
		const terminal = new RemoteTerminal(
			() => this.send({ type: "engine_custom_invalidate", componentId }),
			(control) => this.send({ type: "engine_custom_terminal", componentId, control }),
			(requestId, text) => this.send({ type: "engine_custom_copy", componentId, requestId, text }),
		);
		const tui = new RemoteComponentTui(terminal, () => this.paintComponent(componentId));
		this.followHostMode(tui, componentId);
		ensurePngTranscoder(() => {
			tui.invalidate();
			tui.requestRender();
		});
		const component = await factory(tui, theme, this.keybindings, done);
		tui.addChild(component);
		tui.setFocus(component);
		const record: ActiveComponent = {
			component,
			// Cancellation must settle through the same guarded host completion as done().
			resolve: (value) => done(value as T),
			terminal,
			tui,
			overlay: options?.overlay === true,
			purpose: options?.purpose,
		};
		this.active.set(componentId, record);
		this.notifyState();
		opened = true;
		this.send({
			type: "engine_custom_open",
			componentId,
			overlay: options?.overlay === true,
			purpose: options?.purpose,
			deferInlineCustomUiFocus: options?.deferInlineCustomUiFocus,
			handlesCtrlC: options?.handlesCtrlC,
			handlesInternalUiAction: options?.handlesInternalUiAction,
			reserveTranscriptRows: options?.reserveTranscriptRows,
			overlayOptions: serializableOverlayOptions(options?.overlayOptions),
			blocked: options?.blocked,
		});
		if (options?.onHandle) options.onHandle(this.remoteHandle(componentId));
		if (doneCalled) this.sendDone(componentId, pendingDone as T);
		const onAbort = () => this.disposeComponent(componentId, true);
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await completion;
		} finally {
			options?.signal?.removeEventListener("abort", onAbort);
			this.disposeComponent(componentId, false);
		}
	}
	/**
	 * Open `component` as view `viewId`'s transcript, which the host draws where its main transcript is: frames, keys,
	 * clicks and copies travel as for any custom component, but it blocks nothing and resolves nothing. Answers its
	 * component id, its engine TUI and its close, which tells the host.
	 */
	mountTranscript(
		viewId: string,
		factory: (tui: TUI) => Component & { dispose?(): void },
	): { readonly componentId: string; readonly tui: TUI; close(): void; paintPendingFrame(): void } {
		const componentId = `remote_component_${++this.nextId}`;
		const terminal = new RemoteTerminal(
			() => this.send({ type: "engine_custom_invalidate", componentId }),
			(control) => this.send({ type: "engine_custom_terminal", componentId, control }),
			(requestId, text) => this.send({ type: "engine_custom_copy", componentId, requestId, text }),
		);
		const tui = new RemoteComponentTui(terminal, () => this.paintComponent(componentId));
		this.followHostMode(tui, componentId);
		ensurePngTranscoder(() => {
			tui.invalidate();
			tui.requestRender();
		});
		const component = factory(tui);
		tui.addChild(component);
		tui.setFocus(component);
		this.active.set(componentId, { component, resolve: () => {}, terminal, tui, overlay: false, transcript: true });
		this.send({ type: "engine_custom_open", componentId, overlay: false, placement: "transcript", viewId });
		return {
			componentId,
			tui,
			close: () => this.disposeComponent(componentId, false),
			paintPendingFrame: () => tui.paintPendingFrame(),
		};
	}

	getHostCustomUiState(): HostCustomUiState {
		const inline = [...this.active.values()].filter(
			(record) => !record.overlay && !record.widgetKey && record.transcript !== true,
		);
		const navigation = inline.filter((record) => record.purpose === "navigation").length;
		return {
			blockingInlineCustomUiDepth: inline.length,
			blockingInlineCustomUiActive: inline.length > 0,
			...(navigation > 0 ? { blockingInlineCustomUiNeedsInput: inline.length > navigation } : {}),
		};
	}

	onHostCustomUiStateChange(listener: HostCustomUiStateListener): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}
	onWidgetRelease(key: string, listener: () => void): () => void {
		const listeners = this.widgetReleaseListeners.get(key) ?? new Set<() => void>();
		listeners.add(listener);
		this.widgetReleaseListeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.widgetReleaseListeners.delete(key);
		};
	}

	focusHostInlineCustomUi(): boolean {
		return this.getHostCustomUiState().blockingInlineCustomUiActive;
	}

	requestRender(): void {
		for (const [componentId, record] of this.active) {
			if (record.hidden === true) continue;
			// A laid-out custom component paints its next frame itself; anything else asks the host for a frame.
			if (record.widgetKey === undefined && record.lastRequestId !== undefined) record.tui.requestRender();
			else this.send({ type: "engine_custom_invalidate", componentId });
		}
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (!command) return false;
		if (!command.type.startsWith("engine_custom_")) return false;
		const record = this.active.get(command.componentId);
		if (!record) {
			if (command.type === "engine_custom_input")
				this.send({
					type: "engine_custom_input_result",
					componentId: command.componentId,
					requestId: command.requestId,
					handled: false,
				});
			return true;
		}
		switch (command.type) {
			case "engine_custom_scroll":
				(record.component as ScrollableWidgetComponent).onScroll?.(command.state);
				break;
			case "engine_custom_render": {
				if (command.renderSettings !== undefined) this.hostRenderSettings = command.renderSettings;
				if (command.hostMode !== undefined) {
					const laidOutFor = record.tui.mode;
					record.hostMode = command.hostMode;
					this.latestHostMode = command.hostMode;
					// A component that caches its lines by width alone would keep the old mode's layout.
					if (laidOutFor !== command.hostMode) record.tui.invalidate();
				}
				if (command.colorDepth !== undefined) record.terminal.colorDepth = command.colorDepth;
				record.terminal.columns = Math.max(1, command.width);
				record.terminal.rows = Math.max(1, command.rows);
				const { componentId, requestId } = command;
				record.lastRequestId = requestId;
				if (record.widgetKey !== undefined) {
					this.backgroundRenders.schedule(`frame:${componentId}`, () =>
						this.renderWidgetFrame(componentId, requestId, record),
					);
					break;
				}
				// Answered at once, and through the component's TUI so a paint it already had scheduled is not repeated.
				record.frameRequested = true;
				record.staleWhileHidden = false;
				record.tui.renderNow();
				break;
			}
			case "engine_custom_input": {
				// Keys run as soon as they arrive: a yield here would queue the reader's keystroke behind agent work.
				let handled = false;
				record.handlingInput = true;
				try {
					handled = runSynchronousCallback({ kind: "renderer", name: command.componentId }, () => {
						if (isKeyRelease(command.data) && record.component.wantsKeyRelease !== true) return false;
						const handleInput = record.component.handleInput as
							| ((data: string) => boolean | undefined)
							| undefined;
						const handle = () => handleInput?.call(record.component, command.data) === true;
						return command.hint === true ? runAsHintActivation(handle) : handle();
					});
				} catch {
					handled = false;
				} finally {
					record.handlingInput = false;
				}
				this.send({
					type: "engine_custom_input_result",
					componentId: command.componentId,
					requestId: command.requestId,
					handled,
				});
				if (record.paintAfterInput === true) {
					record.paintAfterInput = false;
					this.paintComponent(command.componentId);
				}
				break;
			}
			case "engine_custom_click": {
				// A component that names its rows takes the click while the clicked row still shows the item the host
				// showed there, through frames that only animate. Otherwise a newer frame than the one clicked may have
				// moved what was under the pointer, and the click is dropped.
				// A row the component left unnamed is sent as an empty name, and needs the frame itself unchanged.
				const paintedRowKey = record.component.paintedRowKey;
				if (paintedRowKey !== undefined && command.rowKey) {
					if (paintedRowKey.call(record.component, command.y) !== command.rowKey) break;
				} else if (command.frame !== record.frame) break;
				const { x, y, width, height, clickId } = command;
				record.handlingInput = true;
				try {
					runSynchronousCallback({ kind: "renderer", name: command.componentId }, () => {
						const handleMouse = record.component.handleMouse as
							| ((event: TuiMouseEvent) => TuiMouseEventResult | undefined)
							| undefined;
						const result = handleMouse?.call(record.component, {
							type: "click",
							button: "left",
							x,
							y,
							screenX: x,
							screenY: y,
							width,
							height,
							shift: false,
							alt: false,
							ctrl: false,
							clickCount: 1,
						});
						// Resolved against the frame the host clicked, it acts once the host settles the click. A host from
						// before clicks were settled numbers none and settles none: its click acts now, as it did there.
						if (!result?.whenSingleClick) return;
						if (clickId === undefined) result.whenSingleClick();
						else {
							const waiting = record.singleClickActions ?? new Map<number, TuiMouseEventResult>();
							record.singleClickActions = waiting;
							waiting.set(clickId, result);
							if (!command.cancelsClicks && waiting.size > LEGACY_WAITING_SINGLE_CLICKS) {
								const oldest = waiting.keys().next().value!;
								const evicted = waiting.get(oldest);
								waiting.delete(oldest);
								evicted?.onSingleClickCancel?.();
							}
						}
					});
				} catch {
					// A click a component fails to handle changes nothing; the host keeps its frame.
				} finally {
					record.handlingInput = false;
				}
				if (record.paintAfterInput === true) {
					record.paintAfterInput = false;
					this.paintComponent(command.componentId);
				}
				break;
			}
			case "engine_custom_click_cancel":
			case "engine_custom_click_settle": {
				const result = record.singleClickActions?.get(command.clickId);
				record.singleClickActions?.delete(command.clickId);
				const action =
					command.type === "engine_custom_click_cancel" ? result?.onSingleClickCancel : result?.whenSingleClick;
				if (action === undefined) break;
				record.handlingInput = true;
				try {
					runSynchronousCallback({ kind: "renderer", name: command.componentId }, action);
				} catch {
					// A click a component fails to act on changes nothing; the host keeps its frame.
				} finally {
					record.handlingInput = false;
				}
				if (record.paintAfterInput === true) {
					record.paintAfterInput = false;
					this.paintComponent(command.componentId);
				}
				break;
			}
			case "engine_custom_copy_result":
				record.terminal.resolveCopy(command.requestId, command.error);
				break;
			case "engine_custom_dispose":
				this.disposeComponent(command.componentId, true);
				break;
		}
		return true;
	}

	dispose(): void {
		for (const componentId of [...this.active.keys()]) this.disposeComponent(componentId, true, false);
	}

	/**
	 * Make an engine TUI report the host renderer's mode as its own `mode`. The engine paints every component into a
	 * headless main-screen TUI, whose class constant is "regular" whether the host is fullscreen or not. A component
	 * gets the mode of its latest frame request; before its first request it gets the mode of the latest request
	 * of any component, and "regular" when no host request has carried a mode.
	 */
	private followHostMode(tui: TUI, componentId: string): void {
		Object.defineProperty(tui, "mode", {
			configurable: true,
			enumerable: true,
			get: (): TuiMode => this.active.get(componentId)?.hostMode ?? this.latestHostMode ?? "regular",
		});
	}

	private disposeComponent(componentId: string, resolve: boolean, notifyWidgetRelease = true): void {
		const record = this.active.get(componentId);
		if (!record) return;
		this.active.delete(componentId);
		for (const result of record.singleClickActions?.values() ?? []) runRendererCleanup(result.onSingleClickCancel);
		record.singleClickActions?.clear();
		record.terminal.close();
		// Claim cancellation before user disposal code can call done() reentrantly.
		if (resolve) record.resolve(undefined);
		record.component.dispose?.();
		record.tui.stop();
		if (record.widgetKey) {
			if (this.widgetIds.get(record.widgetKey) === componentId) this.widgetIds.delete(record.widgetKey);
			this.send({ type: "engine_custom_close", componentId });
			if (notifyWidgetRelease) this.notifyWidgetRelease(record.widgetKey);
		} else if (record.transcript) this.send({ type: "engine_custom_close", componentId });
		this.notifyState();
	}

	/**
	 * Paints a custom component's frame and sends it to the host. A frame the host asked for is always sent; one the
	 * component's own repaint produced is sent only when it changed what the host shows. A component the host has not
	 * laid out, or has hidden, gets no frame: the host is asked once to request one when it can show it.
	 */
	private paintComponent(componentId: string): void {
		const record = this.active.get(componentId);
		if (!record) return;
		if (record.handlingInput === true) {
			record.paintAfterInput = true;
			return;
		}
		const requestId = record.lastRequestId;
		if (requestId === undefined || record.hidden === true) {
			if (record.staleWhileHidden === true) return;
			if (requestId === undefined && record.hidden !== true && !this.rendersWithoutFailure(componentId, record))
				return;
			record.staleWhileHidden = record.hidden === true;
			this.send({ type: "engine_custom_invalidate", componentId });
			return;
		}
		const requested = record.frameRequested === true;
		record.frameRequested = false;
		record.staleWhileHidden = false;
		let lines: string[];
		let scrollRequest: WidgetScrollRequest | undefined;
		try {
			lines = runSynchronousCallback({ kind: "renderer", name: componentId }, () =>
				record.component.render(record.terminal.columns),
			);
			scrollRequest = (record.component as ScrollableWidgetComponent).getScrollRequest?.();
		} catch (error) {
			record.lastFrame = undefined;
			this.sendRenderFailure(componentId, requestId, error);
			return;
		}
		const rowKeys = rowKeysOf(record.component, lines.length);
		if (!requested && record.lastFrame !== undefined && sameFrame(record.lastFrame, lines, scrollRequest, rowKeys))
			return;
		record.lastFrame = { lines: [...lines], scrollRequest, rowKeys };
		this.sendFrame(componentId, requestId, record, lines);
	}

	private rendersWithoutFailure(componentId: string, record: ActiveComponent): boolean {
		try {
			runSynchronousCallback({ kind: "renderer", name: componentId }, () =>
				record.component.render(record.terminal.columns),
			);
			return true;
		} catch (error) {
			this.sendRenderFailure(componentId, 0, error);
			return false;
		}
	}

	/** Renders a widget frame on the background lane. A widget closed while the render waited gets none. */
	private renderWidgetFrame(componentId: string, requestId: number, record: ActiveComponent): void {
		if (this.active.get(componentId) !== record) return;
		try {
			const lines = runSynchronousCallback({ kind: "renderer", name: componentId }, () =>
				record.component.render(record.terminal.columns),
			);
			this.sendFrame(componentId, requestId, record, lines);
		} catch (error) {
			this.sendRenderFailure(componentId, requestId, error);
		}
	}

	private sendFrame(componentId: string, requestId: number, record: ActiveComponent, lines: string[]): void {
		const scrollRequest = (record.component as ScrollableWidgetComponent).getScrollRequest?.();
		const rowKeys = rowKeysOf(record.component, lines.length);
		const layout = record.transcript === true ? transcriptLayoutOf(record.component) : undefined;
		record.frame = (record.frame ?? 0) + 1;
		this.send({
			type: "engine_custom_frame",
			componentId,
			requestId,
			lines,
			frame: record.frame,
			...(rowKeys ? { rowKeys } : {}),
			...(layout ? { layout } : {}),
			...(scrollRequest ? { scrollRequest } : {}),
		});
	}

	private sendComponentRenderFailure(componentId: string, error: unknown): void {
		const record = this.active.get(componentId);
		if (!record) return;
		this.sendRenderFailure(componentId, record.lastRequestId ?? 0, error);
	}

	private sendRenderFailure(componentId: string, requestId: number, error: unknown): void {
		this.send({
			type: "engine_custom_frame",
			componentId,
			requestId,
			lines: [`Remote component render failed: ${renderError(error).message}`],
		});
	}
	private notifyWidgetRelease(key: string): void {
		for (const listener of this.widgetReleaseListeners.get(key) ?? []) {
			try {
				listener();
			} catch {
				// A release observer must not break engine UI teardown.
			}
		}
	}
	private notifyState(): void {
		const state = this.getHostCustomUiState();
		for (const listener of this.stateListeners) listener(state);
	}

	private remoteHandle(componentId: string): OverlayHandle {
		let focused = true;
		const setHiddenFlag = (value: boolean): void => {
			const record = this.active.get(componentId);
			if (record) record.hidden = value;
		};
		return {
			hide: () => {
				setHiddenFlag(true);
				this.send({ type: "engine_custom_control", componentId, action: "hide" });
			},
			setHidden: (value) => {
				setHiddenFlag(value);
				this.send({ type: "engine_custom_control", componentId, action: value ? "hide" : "show" });
			},
			isHidden: () => this.active.get(componentId)?.hidden === true,
			focus: () => {
				focused = true;
				this.send({ type: "engine_custom_control", componentId, action: "focus" });
			},
			unfocus: () => {
				focused = false;
				this.send({ type: "engine_custom_control", componentId, action: "unfocus" });
			},
			isFocused: () => focused,
			getBounds: () => undefined,
		};
	}

	private sendDone<T>(componentId: string, result: T): void {
		this.send({
			type: "engine_custom_done",
			componentId,
			result: jsonResult(result as object | boolean | null | number | string | undefined),
			// The view that hid the agent panel closes, and the panel opens again in the same step.
			...(agentPanelReturning() ? { panel: true as const } : {}),
		});
	}

	private send(message: InteractiveEngineMessage): void {
		this.write(serializeInteractiveEngineMessage(message));
	}
}
