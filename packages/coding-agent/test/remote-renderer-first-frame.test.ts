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

test("a call that settles while its row is not drawn tells the engine at once, so the engine stops drawing it as running", async () => {
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
	const partial = (command: InteractiveEngineCommand | undefined) =>
		command?.type === "engine_tool_render" ? command.isPartial : undefined;
	const tool = new RemoteToolExecutionComponent("bash", "hidden-tool", { command: "sleep 1" }, {}, runtime, () => {});
	tool.render(80);
	assert.equal(partial(commands.at(-1)), true);
	// The screen stops drawing the row (its chat is hidden); the call finishes there.
	commands.length = 0;
	tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	await Promise.resolve();
	assert.deepEqual(
		commands.map((command) => [command.type, partial(command)]),
		[["engine_tool_render", false]],
	);
	// Drawn again, the row asks for nothing new: the engine has its last state.
	tool.render(80);
	assert.equal(commands.length, 1);

	// A call never drawn asks for nothing when it settles.
	const unseen = new RemoteToolExecutionComponent("bash", "unseen-tool", { command: "ls" }, {}, runtime, () => {});
	commands.length = 0;
	unseen.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	await Promise.resolve();
	assert.deepEqual(commands, []);

	// What settles the call in the same turn, such as the row becoming its group's head, is in the one request.
	const lead = new RemoteToolExecutionComponent("read", "lead-tool", { path: "a.txt" }, {}, runtime, () => {});
	lead.render(80);
	commands.length = 0;
	lead.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
	lead.setGroupRole({ kind: "head", clauses: [{ family: "read", count: 2 }] });
	await Promise.resolve();
	assert.equal(commands.length, 1);
	const request = commands[0];
	assert.ok(request?.type === "engine_tool_render" && request.groupRole?.kind === "head", JSON.stringify(request));
	lead.render(80);
	assert.equal(commands.length, 1, "the next paint asks for nothing more");
});

test("a call that settles while a click on its hidden row is being compared tells the engine once the comparison ends", async () => {
	for (const end of ["answered", "cancelled"] as const) {
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
		const tool = new RemoteToolExecutionComponent(
			"bash",
			`click-${end}`,
			{ command: "sleep 1" },
			{},
			runtime,
			() => {},
		);
		tool.render(80);
		const click = new AbortController();
		tool.expandByClick(true, () => {}, 80, click.signal);
		const compare = commands.at(-1);
		assert.equal(compare?.type, "engine_tool_render");
		// The call finishes and the row stops being drawn while the comparison is under way.
		commands.length = 0;
		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		await Promise.resolve();
		assert.deepEqual(commands, [], `${end}: the comparison keeps the request line`);
		if (end === "answered" && compare?.type === "engine_tool_render") {
			const message: InteractiveEngineMessage = {
				type: "engine_custom_frame",
				componentId: compare.componentId,
				requestId: compare.requestId,
				lines: ["frame"],
				expansionChangesRows: false,
			};
			for (const listener of [...listeners]) listener(message);
		} else click.abort();
		await Promise.resolve();
		assert.deepEqual(
			commands.map((command) => [
				command.type,
				command.type === "engine_tool_render" ? command.isPartial : undefined,
			]),
			[["engine_tool_render", false]],
			end,
		);
	}
});
