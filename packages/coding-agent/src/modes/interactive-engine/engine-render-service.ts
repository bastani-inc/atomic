import type { Terminal } from "@earendil-works/pi-tui";
import { TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { runCallback } from "../../core/callback-activity.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { CustomMessageComponent } from "../interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../interactive/components/tool-execution.ts";
import {
	INTERACTIVE_ENGINE_MAX_FRAME_BYTES,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineCommand,
	serializeInteractiveEngineMessage,
} from "./protocol.ts";

type ToolRenderCommand = Extract<InteractiveEngineCommand, { type: "engine_tool_render" }>;
type MessageRenderCommand = Extract<InteractiveEngineCommand, { type: "engine_message_render" }>;

/**
 * Cached per-componentId render state. Records are REUSED across render
 * requests: recreating (and re-seeding) the component on every request made
 * the seeding setters call `ui.requestRender()` each time, whose eventual
 * terminal write emitted `engine_custom_invalidate` back to the host, which
 * re-sent the render request — a self-sustaining host⇄engine render
 * ping-pong that presented as full-screen TUI flicker (quit/pause while a
 * workflow stage streams). Reuse plus idempotent seeding setters lets the
 * loop converge after at most one round trip while still forwarding
 * legitimate async invalidations (e.g. image conversion).
 */
type RenderRecord =
	| { kind: "message"; component: CustomMessageComponent; terminal: RenderTerminal; tui: TUI }
	| { kind: "tool"; component: ToolExecutionComponent; terminal: RenderTerminal; tui: TUI };

class RenderTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private readonly requestRender: () => void;
	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void { this.requestRender(); }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function boundedLines(lines: string[]): string[] {
	let remaining = INTERACTIVE_ENGINE_MAX_FRAME_BYTES - 512;
	const result: string[] = [];
	for (const line of lines) {
		if (remaining <= 0) break;
		const bytes = Buffer.from(line);
		const value = bytes.length <= remaining ? line : bytes.subarray(0, remaining).toString("utf8");
		result.push(value);
		remaining -= Buffer.byteLength(value, "utf8");
	}
	return result;
}

export class EngineRenderService {
	private readonly records = new Map<string, RenderRecord>();
	private session: AgentSession | undefined;
	private readonly write: (line: string) => void;

	constructor(write: (line: string) => void) {
		this.write = write;
	}

	bindSession(session: AgentSession): void {
		this.dispose();
		this.session = session;
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (!command || !command.type.startsWith("engine_") || command.type.startsWith("engine_custom_")) return false;
		if (command.type === "engine_render_dispose") {
			this.disposeRecord(command.componentId);
			return true;
		}
		if (command.type !== "engine_tool_render" && command.type !== "engine_message_render") return false;
		const name = command.type === "engine_tool_render" ? `tool:${command.toolName}` : `message:${command.message.customType ?? "custom"}`;
		void runCallback({ kind: "renderer", name }, async () => {
			return command.type === "engine_tool_render" ? this.renderTool(command) : this.renderMessage(command);
		}).then((lines) => this.send({
			type: "engine_custom_frame",
			componentId: command.componentId,
			requestId: command.requestId,
			lines,
		})).catch((error: Error) => this.send({
			type: "engine_custom_frame",
			componentId: command.componentId,
			requestId: command.requestId,
			lines: [`Remote renderer failed: ${error.message}`],
		}));
		return true;
	}

	dispose(): void {
		for (const id of [...this.records.keys()]) this.disposeRecord(id);
	}

	private boundSession(): AgentSession {
		const session = this.session;
		if (!session) throw new Error("Renderer session is not bound");
		return session;
	}

	private createTerminal(componentId: string): RenderTerminal {
		return new RenderTerminal(() => this.send({ type: "engine_custom_invalidate", componentId }));
	}

	private renderTool(command: ToolRenderCommand): string[] {
		let record = this.records.get(command.componentId);
		if (record?.kind !== "tool") {
			const session = this.boundSession();
			this.disposeRecord(command.componentId);
			const terminal = this.createTerminal(command.componentId);
			terminal.columns = Math.max(1, command.width);
			const tui = new TUI(terminal);
			const component = new ToolExecutionComponent(
				command.toolName,
				command.toolCallId,
				command.args,
				{ showImages: command.showImages, imageWidthCells: command.imageWidthCells },
				session.getToolDefinition(command.toolName),
				tui,
				session.sessionManager.getCwd(),
			);
			tui.addChild(component);
			record = { kind: "tool", component, terminal, tui };
			this.records.set(command.componentId, record);
		} else {
			record.terminal.columns = Math.max(1, command.width);
			record.component.updateArgs(command.args);
			record.component.setShowImages(command.showImages);
			record.component.setImageWidthCells(command.imageWidthCells);
		}
		const tool = record.component;
		if (command.executionStarted) tool.markExecutionStarted();
		if (command.argsComplete) tool.setArgsComplete();
		tool.setExpanded(command.expanded);
		if (command.result) {
			tool.updateResult(command.result as unknown as Parameters<ToolExecutionComponent["updateResult"]>[0], command.isPartial);
		}
		return boundedLines(tool.render(command.width));
	}

	private renderMessage(command: MessageRenderCommand): string[] {
		let record = this.records.get(command.componentId);
		if (record?.kind !== "message") {
			const session = this.boundSession();
			this.disposeRecord(command.componentId);
			const terminal = this.createTerminal(command.componentId);
			terminal.columns = Math.max(1, command.width);
			const tui = new TUI(terminal);
			const message = command.message as unknown as CustomMessage<object>;
			const component = new CustomMessageComponent(message, session.extensionRunner.getMessageRenderer(message.customType));
			tui.addChild(component);
			record = { kind: "message", component, terminal, tui };
			this.records.set(command.componentId, record);
		} else {
			record.terminal.columns = Math.max(1, command.width);
		}
		record.component.setExpanded(command.expanded);
		return boundedLines(record.component.render(command.width));
	}

	private disposeRecord(id: string): void {
		const record = this.records.get(id);
		if (!record) return;
		this.records.delete(id);
		if (record.kind === "tool") record.component.dispose();
		record.tui.stop();
	}

	private send(message: InteractiveEngineMessage): void {
		this.write(serializeInteractiveEngineMessage(message));
	}
}
