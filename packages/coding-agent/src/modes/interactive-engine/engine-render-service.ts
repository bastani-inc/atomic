import type { Component, Terminal } from "@earendil-works/pi-tui";
import { TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { runCallback } from "../../core/callback-activity.ts";
import type { CustomMessage } from "../../core/messages.ts";
import { CustomMessageComponent } from "../interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../interactive/components/tool-execution.ts";
import {
	INTERACTIVE_ENGINE_MAX_FRAME_BYTES,
	parseInteractiveEngineCommand,
	serializeInteractiveEngineMessage,
	type InteractiveEngineMessage,
} from "./protocol.ts";

interface RenderRecord {
	component: Component & { dispose?(): void };
	tui: TUI;
}

class RenderTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	constructor(private readonly requestRender: () => void) {}
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

	constructor(private readonly write: (line: string) => void) {}

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
			this.disposeRecord(command.componentId);
			const terminal = new RenderTerminal(() => this.send({ type: "engine_custom_invalidate", componentId: command.componentId }));
			terminal.columns = Math.max(1, command.width);
			const tui = new TUI(terminal);
			let component: RenderRecord["component"];
			if (command.type === "engine_tool_render") {
				const session = this.session;
				if (!session) throw new Error("Renderer session is not bound");
				const tool = new ToolExecutionComponent(
					command.toolName,
					command.toolCallId,
					command.args,
					{ showImages: command.showImages, imageWidthCells: command.imageWidthCells },
					session.getToolDefinition(command.toolName),
					tui,
					session.sessionManager.getCwd(),
				);
				if (command.executionStarted) tool.markExecutionStarted();
				if (command.argsComplete) tool.setArgsComplete();
				tool.setExpanded(command.expanded);
				if (command.result) {
					tool.updateResult(command.result as unknown as Parameters<ToolExecutionComponent["updateResult"]>[0], command.isPartial);
				}
				component = tool;
			} else {
				const session = this.session;
				if (!session) throw new Error("Renderer session is not bound");
				const message = command.message as unknown as CustomMessage<object>;
				const custom = new CustomMessageComponent(message, session.extensionRunner.getMessageRenderer(message.customType));
				custom.setExpanded(command.expanded);
				component = custom;
			}
			tui.addChild(component);
			this.records.set(command.componentId, { component, tui });
			return boundedLines(component.render(command.width));
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

	private disposeRecord(id: string): void {
		const record = this.records.get(id);
		if (!record) return;
		this.records.delete(id);
		record.component.dispose?.();
		record.tui.stop();
	}

	private send(message: InteractiveEngineMessage): void {
		this.write(serializeInteractiveEngineMessage(message));
	}
}
