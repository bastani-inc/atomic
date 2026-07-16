import type { Component } from "@earendil-works/pi-tui";
import type { CustomMessage } from "../../core/messages.ts";
import type { ToolExecutionComponent } from "../interactive/components/tool-execution.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import type { InteractiveEngineCommand, JsonObject, JsonValue } from "./protocol.ts";

type RenderableToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

let nextRemoteRendererId = 0;

function jsonValue(value: unknown): JsonValue {
	if (value === undefined) return null;
	const encoded = JSON.stringify(value);
	return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
}

abstract class RemoteRenderer implements Component {
	protected readonly componentId = `remote_renderer_${++nextRemoteRendererId}`;
	private lines = ["Loading isolated renderer…"];
	private width = 0;
	private requestId = 0;
	private appliedRequestId = 0;
	private dirty = true;
	private disposed = false;
	private readonly unsubscribe: () => void;

	constructor(
		protected readonly runtime: IsolatedInteractiveRuntime,
		private readonly requestRender: () => void,
	) {
		this.unsubscribe = runtime.onEngineMessage((message) => {
			if (!("componentId" in message) || message.componentId !== this.componentId) return;
			if (message.type === "engine_custom_frame") {
				if (message.requestId < this.appliedRequestId) return;
				this.appliedRequestId = message.requestId;
				this.lines = message.lines;
				this.requestRender();
			} else if (message.type === "engine_custom_invalidate") {
				this.markDirty();
			}
		});
	}

	render(width: number): string[] {
		if (!this.disposed && (this.dirty || width !== this.width)) {
			this.width = width;
			this.dirty = false;
			this.runtime.sendEngineCommand(this.command(++this.requestId, width));
		}
		return this.lines;
	}

	invalidate(): void { this.markDirty(); }

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.runtime.sendEngineCommand({ type: "engine_render_dispose", componentId: this.componentId });
	}

	protected changed(): void {
		this.markDirty();
		this.requestRender();
	}

	protected abstract command(requestId: number, width: number): InteractiveEngineCommand;

	private markDirty(): void { this.dirty = true; }
}

export class RemoteToolExecutionComponent extends RemoteRenderer {
	private result: RenderableToolResult | undefined;
	private executionStarted = false;
	private argsComplete = false;
	private isPartial = true;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;

	constructor(
		private readonly toolName: string,
		private readonly toolCallId: string,
		private args: unknown,
		options: { showImages?: boolean; imageWidthCells?: number },
		runtime: IsolatedInteractiveRuntime,
		requestRender: () => void,
	) {
		super(runtime, requestRender);
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
	}

	updateArgs(args: unknown): void { this.args = args; this.changed(); }
	markExecutionStarted(): void { this.executionStarted = true; this.changed(); }
	setArgsComplete(): void { this.argsComplete = true; this.changed(); }
	updateResult(result: RenderableToolResult, isPartial = false): void {
		this.result = result;
		this.isPartial = isPartial;
		this.changed();
	}
	setExpanded(expanded: boolean): void { this.expanded = expanded; this.changed(); }
	setShowImages(show: boolean): void { this.showImages = show; this.changed(); }
	setImageWidthCells(width: number): void { this.imageWidthCells = Math.max(1, Math.floor(width)); this.changed(); }

	protected command(requestId: number, width: number): InteractiveEngineCommand {
		return {
			type: "engine_tool_render",
			componentId: this.componentId,
			requestId,
			width,
			toolName: this.toolName,
			toolCallId: this.toolCallId,
			args: jsonValue(this.args),
			result: this.result ? jsonValue(this.result) as JsonObject : undefined,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			imageWidthCells: this.imageWidthCells,
		};
	}
}

export class RemoteCustomMessageComponent extends RemoteRenderer {
	private expanded = false;
	constructor(
		private readonly message: CustomMessage<unknown>,
		runtime: IsolatedInteractiveRuntime,
		requestRender: () => void,
	) { super(runtime, requestRender); }

	setExpanded(expanded: boolean): void { this.expanded = expanded; this.changed(); }

	protected command(requestId: number, width: number): InteractiveEngineCommand {
		return {
			type: "engine_message_render",
			componentId: this.componentId,
			requestId,
			width,
			message: jsonValue(this.message) as JsonObject,
			expanded: this.expanded,
		};
	}
}
