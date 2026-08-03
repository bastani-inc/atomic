import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import type { InteractiveEngineMessage, JsonValue, SerializableOverlayOptions } from "./protocol.ts";
import { RemoteFrameWidthClamp } from "./remote-frame-clamp.ts";
import { TerminalModeController } from "./terminal-mode-controller.ts";

interface MountedRemoteComponent {
	component: RemoteComponent;
	done: (result: JsonValue | undefined) => void;
	engineDone: boolean;
	/** The extension declared that this component binds Ctrl+C itself. */
	handlesCtrlC: boolean;
	handle?: OverlayHandle;
	widgetKey?: string;
}

class RemoteComponent implements Component {
	wantsKeyRelease = true;
	private lines = ["Loading remote component…"];
	private width = 0;
	private requestId = 0;
	private appliedRequestId = 0;
	private dirty = true;
	private disposed = false;
	private readonly frameClamp = new RemoteFrameWidthClamp();

	private readonly componentId: string;
	private readonly runtime: IsolatedInteractiveRuntime;
	private readonly requestRender: () => void;
	private readonly getRows: () => number;

	constructor(
		componentId: string,
		runtime: IsolatedInteractiveRuntime,
		requestRender: () => void,
		getRows: () => number,
	) {
		this.componentId = componentId;
		this.runtime = runtime;
		this.requestRender = requestRender;
		this.getRows = getRows;
	}

	render(width: number): string[] {
		if (!this.disposed && (this.dirty || width !== this.width)) {
			this.width = width;
			this.dirty = false;
			this.runtime.sendEngineCommand({
				type: "engine_custom_render",
				componentId: this.componentId,
				requestId: ++this.requestId,
				width,
				rows: this.getRows(),
			});
		}
		// The engine child re-renders asynchronously; until the fresh frame
		// arrives, the previous frame may be wrapped for an older terminal
		// width. Clamp so a resize never replays overflowing lines (pi-tui
		// crashes on any rendered line wider than the terminal).
		return this.frameClamp.clamp(this.lines, width);
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		this.runtime.sendEngineCommand({ type: "engine_custom_input", componentId: this.componentId, data });
		// Engine commands are delivered in order, so a frame requested now is
		// rendered by the child only AFTER it has applied this input. Pipelining
		// the request keeps keypress latency at a single round trip and repaints
		// components that never self-invalidate, instead of waiting for a
		// child-side invalidate (or an unrelated refresh) to trigger a frame.
		this.dirty = true;
		this.requestRender();
	}

	invalidate(): void {
		this.dirty = true;
	}

	applyFrame(requestId: number, lines: string[]): void {
		if (this.disposed || requestId < this.appliedRequestId) return;
		this.appliedRequestId = requestId;
		this.lines = lines;
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
		if (notifyEngine)
			this.runtime.sendEngineCommand({ type: "engine_custom_dispose", componentId: this.componentId });
	}
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

export class RemoteComponentController {
	private readonly mounted = new Map<string, MountedRemoteComponent>();
	private readonly unsubscribe: () => void;
	private readonly unsubscribeGenerationEnded: () => void;
	private readonly terminalModes = new TerminalModeController();

	private readonly runtime: IsolatedInteractiveRuntime;
	private readonly ui: ExtensionUIContext;

	constructor(runtime: IsolatedInteractiveRuntime, ui: ExtensionUIContext) {
		this.runtime = runtime;
		this.ui = ui;
		this.unsubscribe = runtime.onEngineMessage((message) => this.handleMessage(message));
		// Teardown is driven by engine death rather than the NEXT generation's
		// `engine_ready`, so a crash with no restart, or a hung/failed restart,
		// still releases the host editor, focus, and inline-custom-UI depth.
		this.unsubscribeGenerationEnded = runtime.onGenerationEnded(() => this.disposeAll("generation-lost"));
	}

	dispose(): void {
		this.unsubscribe();
		this.unsubscribeGenerationEnded();
		this.disposeAll("host-shutdown");
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
				);
				break;
			case "engine_custom_close":
				this.close(message.componentId);
				break;
			case "engine_custom_frame":
				this.mounted.get(message.componentId)?.component.applyFrame(message.requestId, message.lines);
				break;
			case "engine_custom_invalidate":
				this.mounted.get(message.componentId)?.component.requestRemoteRender();
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
	): void {
		if (this.mounted.has(componentId)) return;
		if (widgetKey) {
			let rows = 24;
			const component = new RemoteComponent(
				componentId,
				this.runtime,
				() => this.ui.requestRender(),
				() => rows,
			);
			this.mounted.set(componentId, { component, done: () => {}, engineDone: false, handlesCtrlC, widgetKey });
			this.ui.setWidget(
				widgetKey,
				(tui) => {
					rows = tui.terminal.rows;
					return component;
				},
				{ placement: widgetPlacement },
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
					);
					mounted = { component, done, engineDone: false, handlesCtrlC };
					this.mounted.set(componentId, mounted);
					// Bind this component to the real host terminal so buffered/pending
					// terminal-mode controls (e.g. mouse-scroll reporting the overlay
					// enabled before the mount frame) apply to the host TTY.
					this.terminalModes.onMount(componentId, hostTerminal(tui));
					return component;
				},
				{
					overlay,
					deferInlineCustomUiFocus,
					overlayOptions: overlayOptions(options),
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
				if (!record.engineDone) record.component.dispose();
			});
	}

	private close(componentId: string): void {
		const record = this.mounted.get(componentId);
		if (!record) return;
		this.terminalModes.onUnmount(componentId);
		this.mounted.delete(componentId);
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
