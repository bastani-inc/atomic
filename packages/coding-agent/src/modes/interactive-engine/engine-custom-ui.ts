import type { Component, OverlayHandle, OverlayOptions, Terminal } from "@earendil-works/pi-tui";
import { TUI } from "@earendil-works/pi-tui";
import { runCallback } from "../../core/callback-activity.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import type { Theme } from "../interactive/theme/theme.ts";
import { theme } from "../interactive/theme/theme.ts";
import {
	INTERACTIVE_ENGINE_MAX_FRAME_CHARS,
	isJsonValue,
	parseInteractiveEngineCommand,
	serializeInteractiveEngineMessage,
	type InteractiveEngineMessage,
	type JsonValue,
	type SerializableOverlayOptions,
} from "./protocol.ts";

interface CustomUiOptions {
	overlay?: boolean;
	deferInlineCustomUiFocus?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
	signal?: AbortSignal;
}

interface ActiveComponent {
	component: Component & { dispose?(): void };
	resolve: (value: JsonValue | undefined) => void;
	overlay: boolean;
	terminal: RemoteTerminal;
	tui: TUI;
}

class RemoteTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private readonly invalidate: () => void;
	constructor(invalidate: () => void) { this.invalidate = invalidate; }
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void { this.invalidate(); }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function serializableOverlayOptions(options: CustomUiOptions["overlayOptions"]): SerializableOverlayOptions | undefined {
	const value = typeof options === "function" ? options() : options;
	if (!value) return undefined;
	const { anchor, col, margin, maxHeight, minWidth, offsetX, offsetY, row, width } = value;
	return { anchor, col, margin, maxHeight, minWidth, offsetX, offsetY, row, width };
}

function jsonResult(value: object | boolean | null | number | string | undefined): JsonValue | undefined {
	if (value === undefined) return undefined;
	const encoded = JSON.stringify(value);
	if (encoded === undefined) return undefined;
	const decoded = JSON.parse(encoded) as JsonValue;
	if (!isJsonValue(decoded)) throw new Error("Custom UI result is not JSON-safe");
	return decoded;
}

function boundedLines(lines: string[]): string[] {
	let remaining = INTERACTIVE_ENGINE_MAX_FRAME_CHARS - 512;
	const bounded: string[] = [];
	for (const line of lines) {
		if (remaining <= 0) break;
		const next = line.length <= remaining ? line : line.slice(0, remaining);
		bounded.push(next);
		remaining -= next.length;
	}
	return bounded;
}

export class EngineCustomUiService {
	private readonly active = new Map<string, ActiveComponent>();
	private nextId = 0;
	private readonly write: (line: string) => void;
	private readonly stateListeners = new Set<(state: { blockingInlineCustomUiDepth: number; blockingInlineCustomUiActive: boolean }) => void>();

	constructor(write: (line: string) => void) { this.write = write; }

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
		const completion = new Promise<T>((resolve) => { resolveCompletion = resolve; });
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
		const terminal = new RemoteTerminal(() => this.send({ type: "engine_custom_invalidate", componentId }));
		const tui = new TUI(terminal);
		const component = await factory(tui, theme, KeybindingsManager.create(), done);
		tui.addChild(component);
		tui.setFocus(component);
		const record: ActiveComponent = {
			component,
			resolve: (value) => resolveCompletion(value as T),
			terminal,
			tui,
			overlay: options?.overlay === true,
		};
		this.active.set(componentId, record);
		this.notifyState();
		opened = true;
		this.send({
			type: "engine_custom_open",
			componentId,
			overlay: options?.overlay === true,
			deferInlineCustomUiFocus: options?.deferInlineCustomUiFocus,
			overlayOptions: serializableOverlayOptions(options?.overlayOptions),
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
	getHostCustomUiState(): { blockingInlineCustomUiDepth: number; blockingInlineCustomUiActive: boolean } {
		const depth = [...this.active.values()].filter((record) => !record.overlay).length;
		return { blockingInlineCustomUiDepth: depth, blockingInlineCustomUiActive: depth > 0 };
	}

	onHostCustomUiStateChange(
		listener: (state: { blockingInlineCustomUiDepth: number; blockingInlineCustomUiActive: boolean }) => void,
	): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	focusHostInlineCustomUi(): boolean { return this.getHostCustomUiState().blockingInlineCustomUiActive; }


	requestRender(): void {
		for (const componentId of this.active.keys()) this.send({ type: "engine_custom_invalidate", componentId });
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (!command) return false;
		const record = this.active.get(command.componentId);
		if (!record) return true;
		switch (command.type) {
			case "engine_custom_render":
				record.terminal.columns = Math.max(1, command.width);
				record.terminal.rows = Math.max(1, command.rows);
				void runCallback(
					{ kind: "renderer", name: command.componentId },
					() => record.component.render(record.terminal.columns),
				).then((lines) => this.send({
					type: "engine_custom_frame",
					componentId: command.componentId,
					requestId: command.requestId,
					lines: boundedLines(lines),
				})).catch((error: Error) => this.send({
					type: "engine_custom_frame",
					componentId: command.componentId,
					requestId: command.requestId,
					lines: [`Remote component render failed: ${error.message}`],
				}));
				break;
			case "engine_custom_input":
				void runCallback(
					{ kind: "renderer", name: command.componentId },
					() => record.component.handleInput?.(command.data),
				).catch(() => undefined);
				break;
			case "engine_custom_dispose":
				this.disposeComponent(command.componentId, true);
				break;
		}
		return true;
	}

	dispose(): void {
		for (const componentId of [...this.active.keys()]) this.disposeComponent(componentId, true);
	}

	private disposeComponent(componentId: string, resolve: boolean): void {
		const record = this.active.get(componentId);
		if (!record) return;
		this.active.delete(componentId);
		record.component.dispose?.();
		record.tui.stop();
		this.notifyState();
		if (resolve) record.resolve(undefined);
	}
	private notifyState(): void {
		const state = this.getHostCustomUiState();
		for (const listener of this.stateListeners) listener(state);
	}


	private remoteHandle(componentId: string): OverlayHandle {
		let hidden = false;
		let focused = true;
		return {
			hide: () => this.send({ type: "engine_custom_control", componentId, action: "hide" }),
			setHidden: (value) => {
				hidden = value;
				this.send({ type: "engine_custom_control", componentId, action: value ? "hide" : "show" });
			},
			isHidden: () => hidden,
			focus: () => {
				focused = true;
				this.send({ type: "engine_custom_control", componentId, action: "focus" });
			},
			unfocus: () => {
				focused = false;
				this.send({ type: "engine_custom_control", componentId, action: "unfocus" });
			},
			isFocused: () => focused,
		};
	}

	private sendDone<T>(componentId: string, result: T): void {
		this.send({
			type: "engine_custom_done",
			componentId,
			result: jsonResult(result as object | boolean | null | number | string | undefined),
		});
	}

	private send(message: InteractiveEngineMessage): void {
		this.write(serializeInteractiveEngineMessage(message));
	}
}
