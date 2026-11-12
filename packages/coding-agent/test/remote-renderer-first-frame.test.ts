import assert from "node:assert/strict";
import { test } from "vitest";
import { createCustomMessage } from "../src/core/messages.js";
import type { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import type { InteractiveEngineCommand, InteractiveEngineMessage } from "../src/modes/interactive-engine/protocol.js";
import {
	RemoteCustomMessageComponent,
	RemoteToolExecutionComponent,
} from "../src/modes/interactive-engine/remote-renderer.js";

function engineThatHasNotAnswered() {
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
	const answer = (lines: string[]) => {
		for (const command of commands.splice(0)) {
			if (command.type !== "engine_tool_render" && command.type !== "engine_message_render") continue;
			const message: InteractiveEngineMessage = {
				type: "engine_custom_frame",
				componentId: command.componentId,
				requestId: command.requestId,
				lines,
			};
			for (const listener of [...listeners]) listener(message);
		}
	};
	return { runtime, answer };
}

test("an engine-rendered row draws nothing until its first frame arrives, not a loading line", () => {
	const { runtime, answer } = engineThatHasNotAnswered();
	const tool = new RemoteToolExecutionComponent("bash", "first-frame-tool", { command: "ls" }, {}, runtime, () => {});
	const notice = new RemoteCustomMessageComponent(
		createCustomMessage("first-frame-notice", "hello", true, undefined, new Date(0).toISOString()),
		runtime,
		() => {},
	);
	for (const row of [tool, notice]) {
		assert.deepEqual(row.render(80), []);
	}
	answer(["rendered"]);
	assert.deepEqual(tool.render(80), ["rendered"]);
	assert.deepEqual(notice.render(80), ["rendered"]);
});
