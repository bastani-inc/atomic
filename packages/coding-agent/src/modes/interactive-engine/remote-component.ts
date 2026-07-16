import type { Component, OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "../../core/extensions/index.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import type { InteractiveEngineMessage, JsonValue, SerializableOverlayOptions } from "./protocol.ts";

interface MountedRemoteComponent {
	component: RemoteComponent;
	done: (result: JsonValue | undefined) => void;
	engineDone: boolean;
	handle?: OverlayHandle;
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

export class RemoteComponentController {
	private readonly mounted = new Map<string, MountedRemoteComponent>();
	private readonly unsubscribe: () => void;

	constructor(
		private readonly runtime: IsolatedInteractiveRuntime,
		private readonly ui: ExtensionUIContext,
	) {
		this.unsubscribe = runtime.onEngineMessage((message) => this.handleMessage(message));
	}

	dispose(): void {
		this.unsubscribe();
		for (const record of this.mounted.values()) record.component.dispose();
		this.mounted.clear();
	}

	private handleMessage(message: InteractiveEngineMessage): void {
		switch (message.type) {
			case "engine_custom_open":
				this.open(message.componentId, message.overlay, message.deferInlineCustomUiFocus, message.overlayOptions);
				break;
			case "engine_custom_frame":
				this.mounted.get(message.componentId)?.component.applyFrame(message.requestId, message.lines);
				break;
			case "engine_custom_invalidate":
				this.mounted.get(message.componentId)?.component.requestRemoteRender();
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
	): void {
		if (this.mounted.has(componentId)) return;
		let mounted: MountedRemoteComponent | undefined;
		void this.ui.custom<JsonValue | undefined>(
			(tui, _theme, _keybindings, done) => {
				const component = new RemoteComponent(
					componentId, this.runtime, () => this.ui.requestRender(), () => tui.terminal.rows,
				);
				mounted = { component, done, engineDone: false };
				this.mounted.set(componentId, mounted);
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
		).catch(() => undefined).finally(() => {
			const record = this.mounted.get(componentId);
			if (!record) return;
			this.mounted.delete(componentId);
			if (!record.engineDone) record.component.dispose();
		});
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
