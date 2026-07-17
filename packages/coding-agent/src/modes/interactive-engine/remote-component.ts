import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import type { InteractiveEngineMessage, JsonValue, SerializableOverlayOptions } from "./protocol.ts";
import { TerminalModeController } from "./terminal-mode-controller.ts";

interface MountedRemoteComponent {
	component: RemoteComponent;
	done: (result: JsonValue | undefined) => void;
	engineDone: boolean;
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

	constructor(
		private readonly componentId: string,
		private readonly runtime: IsolatedInteractiveRuntime,
		private readonly requestRender: () => void,
		private readonly getRows: () => number,
	) {}

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
		return this.lines;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		this.runtime.sendEngineCommand({ type: "engine_custom_input", componentId: this.componentId, data });
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
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
	return typeof terminal?.write === "function"
		? (terminal as { write(data: string): void })
		: { write: () => {} };
}

export class RemoteComponentController {
	private readonly mounted = new Map<string, MountedRemoteComponent>();
	private readonly unsubscribe: () => void;
	private readonly terminalModes = new TerminalModeController();

	constructor(
		private readonly runtime: IsolatedInteractiveRuntime,
		private readonly ui: ExtensionUIContext,
	) {
		this.unsubscribe = runtime.onEngineMessage((message) => this.handleMessage(message));
	}

	dispose(): void {
		this.unsubscribe();
		this.terminalModes.resetAll();
		for (const record of this.mounted.values()) {
			if (record.widgetKey) this.ui.setWidget(record.widgetKey, undefined);
			record.component.dispose();
		}
		this.mounted.clear();
	}

	private handleMessage(message: InteractiveEngineMessage): void {
		switch (message.type) {
			case "engine_ready":
				// A fresh engine generation replaced the child: any terminal modes
				// the dead generation left on are stale. Reset them so a crashed or
				// restarted overlay never strands the host TTY in mouse-reporting
				// or autowrap-off mode; the new generation re-asserts on remount.
				this.terminalModes.resetAll();
				break;
			case "engine_custom_open":
				this.open(message.componentId, message.overlay, message.deferInlineCustomUiFocus, message.overlayOptions, message.widgetKey, message.widgetPlacement);
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
	): void {
		if (this.mounted.has(componentId)) return;
		if (widgetKey) {
			let rows = 24;
			const component = new RemoteComponent(componentId, this.runtime, () => this.ui.requestRender(), () => rows);
			this.mounted.set(componentId, { component, done: () => {}, engineDone: false, widgetKey });
			this.ui.setWidget(widgetKey, (tui) => {
				rows = tui.terminal.rows;
				return component;
			}, { placement: widgetPlacement });
			return;
		}
		let mounted: MountedRemoteComponent | undefined;
		void this.ui.custom<JsonValue | undefined>(
			(tui, _theme, _keybindings, done) => {
				const component = new RemoteComponent(
					componentId, this.runtime, () => this.ui.requestRender(), () => tui.terminal.rows,
				);
				mounted = { component, done, engineDone: false };
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
				onHandle: (handle) => { if (mounted) mounted.handle = handle; },
			},
		).catch(() => undefined).finally(() => {
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
			case "focus": handle.focus(); break;
			case "hide": handle.setHidden(true); break;
			case "show": handle.setHidden(false); break;
			case "unfocus": handle.unfocus(); break;
		}
	}
}
