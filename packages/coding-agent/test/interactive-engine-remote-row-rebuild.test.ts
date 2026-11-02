import assert from "node:assert/strict";
import { test } from "vitest";
import { createCustomMessage } from "../src/core/messages.js";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.js";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import type { InteractiveEngineCommand, InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.js";
import {
	RemoteCustomMessageComponent,
	RemoteToolExecutionComponent,
} from "../src/modes/interactive-engine/remote-renderer.js";

/** An engine that answers only when the test says so, as a busy engine does. */
function slowEngine() {
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const commands: InteractiveEngineCommand[] = [];
	const runtime = {
		onEngineMessage(listener: (message: InteractiveEngineMessage) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand(command: InteractiveEngineCommand) {
			commands.push(command);
		},
	} as unknown as IsolatedInteractiveRuntime;
	return {
		runtime,
		commands,
		listeners,
		/**
		 * Answers the render requests sent so far (those `only` selects) with a frame naming its tool call, and its
		 * expansion when expanded.
		 */
		answer(only: (command: InteractiveEngineCommand) => boolean = () => true) {
			const answered = commands.filter(only);
			commands.splice(0, commands.length, ...commands.filter((command) => !only(command)));
			for (const command of answered) {
				if (command.type !== "engine_tool_render" && command.type !== "engine_message_render") continue;
				const message: InteractiveEngineMessage = {
					type: "engine_custom_frame",
					componentId: command.componentId,
					requestId: command.requestId,
					lines: [
						command.type === "engine_tool_render"
							? `card ${command.toolCallId}${command.expanded ? " with full output" : ""}`
							: `notice ${String(command.message.customType)}`,
					],
				};
				for (const listener of [...listeners]) listener(message);
			}
		},
	};
}

function toolRow(
	runtime: IsolatedInteractiveRuntime,
	toolCallId: string,
	details?: { readonly restored: boolean },
): RemoteToolExecutionComponent {
	const row = new RemoteToolExecutionComponent("bash", toolCallId, { command: "ls" }, {}, runtime, () => {});
	row.updateResult({ content: [{ type: "text", text: "done" }], details, isError: false }, false);
	return row;
}

function rebuild(
	chat: StartupChatContainer,
	runtime: IsolatedInteractiveRuntime,
	ids: readonly string[],
	details?: { readonly restored: boolean },
): void {
	chat.clear();
	for (const id of ids) chat.addChild(toolRow(runtime, id, details));
}

test("a rebuilt chat repaints rows the engine already rendered instead of showing a loading placeholder", () => {
	const engine = slowEngine();
	const chat = new StartupChatContainer();
	chat.releaseStartupOutput();
	const ids = ["call_1", "call_2", "call_3"];
	rebuild(chat, engine.runtime, ids);
	chat.render(80);
	engine.answer();
	assert.deepEqual(chat.render(80), ["card call_1", "card call_2", "card call_3"]);

	// Compaction or a reload rebuilds every row from the saved session, which need not match the live result exactly,
	// while the engine is still busy.
	rebuild(chat, engine.runtime, ids, { restored: true });

	assert.deepEqual(chat.render(80), ["card call_1", "card call_2", "card call_3"]);
	assert.ok(
		engine.commands.some((command) => command.type === "engine_tool_render"),
		"the rebuilt rows still ask the engine for fresh frames",
	);
});

test("a rebuilt extension message row repaints its last frame though its saved timestamp differs", () => {
	const engine = slowEngine();
	const chat = new StartupChatContainer();
	chat.releaseStartupOutput();
	chat.addChild(
		new RemoteCustomMessageComponent(
			createCustomMessage("run-card", "Run started", true, { runId: "run-1" }, "2026-11-02T00:00:00.000Z"),
			engine.runtime,
			() => {},
		),
	);
	chat.render(80);
	engine.answer();
	assert.deepEqual(chat.render(80), ["notice run-card"]);

	chat.clear();
	chat.addChild(
		new RemoteCustomMessageComponent(
			createCustomMessage("run-card", "Run started", true, { runId: "run-1" }, "2026-11-02T00:00:00.040Z"),
			engine.runtime,
			() => {},
		),
	);

	assert.deepEqual(chat.render(80), ["notice run-card"]);
});

test("a cleared chat releases the engine renderers of the rows it drops", () => {
	const engine = slowEngine();
	const chat = new StartupChatContainer();
	chat.releaseStartupOutput();
	rebuild(chat, engine.runtime, ["call_a", "call_b"]);
	chat.render(80);
	const rendered = new Set(
		engine.commands.flatMap((command) => (command.type === "engine_tool_render" ? [command.componentId] : [])),
	);
	engine.commands.length = 0;

	chat.clear();

	const disposed = new Set(
		engine.commands.flatMap((command) => (command.type === "engine_render_dispose" ? [command.componentId] : [])),
	);
	assert.deepEqual(disposed, rendered);
});

test("engine messages reach chat rows through one subscription however many rows there are", () => {
	const engine = slowEngine();
	const chat = new StartupChatContainer();
	chat.releaseStartupOutput();
	const ids = Array.from({ length: 200 }, (_, index) => `call_${index}`);
	rebuild(chat, engine.runtime, ids);
	rebuild(chat, engine.runtime, ids);
	chat.render(80);

	assert.equal(engine.listeners.size, 1);
	engine.answer();
	assert.deepEqual(
		chat.render(80),
		ids.map((id) => `card ${id}`),
	);
});

test("a row collapsed while its expanded frame is in flight is not repainted expanded after a rebuild", () => {
	const engine = slowEngine();
	const chat = new StartupChatContainer();
	chat.releaseStartupOutput();
	const row = toolRow(engine.runtime, "call_folded");
	chat.addChild(row);
	row.setExpanded(true);
	chat.render(80);
	row.setExpanded(false);
	chat.render(80);
	// Only the expanded request is answered before the chat is rebuilt.
	engine.answer((command) => command.type === "engine_tool_render" && command.expanded);

	rebuild(chat, engine.runtime, ["call_folded"]);

	const repainted = chat.render(80);
	assert.ok(
		!repainted.some((line) => line.includes("with full output")),
		`the collapsed row was repainted with its expanded frame: ${JSON.stringify(repainted)}`,
	);
});
