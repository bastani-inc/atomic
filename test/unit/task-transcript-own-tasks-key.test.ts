import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

test("shell output hints and help omit unavailable tool expansion and interruption (#5224)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const command = taskRecord("shell-hints", "command");
	command.output = { ...command.output, byteCount: "15" };
	const source = {
		...ownerTaskViewSource(fixture.store),
		tasks: [command],
		backgroundTasks: [command],
		ownerTasks: [command],
		ownerBackgroundTasks: [command],
		taskRecord: (id: string) => (id === command.ref.taskId ? command : undefined),
		readTaskOutput: async () => ({ ok: true as const, value: { text: "retained output", omitted: false } }),
	};
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	try {
		inspector.openChat(command.ref.taskId);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const plain = () => stripVTControlCharacters(inspector.renderViewport(160, 30).join("\n"));
		assert.match(plain(), /retained output/);
		assert.doesNotMatch(plain().split("\n").at(-1)!, /ctrl\+o|interrupt/);
		inspector.handleInput("?");
		assert.doesNotMatch(plain(), /expand tool output|interrupt the agent|send the prompt|show or hide thinking/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("Down in a subagent chat's empty prompt opens its own tasks without leaving the chat (#5224)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const parent = taskRecord("attached");
	parent.agentName = "worker";
	const child = taskRecord("own-shell", "command");
	child.parentTaskId = parent.ref.taskId;
	child.title = "Own background shell";
	let closed = 0;
	const source = {
		...ownerTaskViewSource(fixture.store),
		tasks: [parent],
		backgroundTasks: [parent],
		ownerTasks: [parent, child],
		ownerBackgroundTasks: [parent, child],
		taskRecord: (id: string) => [parent, child].find((task) => task.ref.taskId === id),
		taskReadOnlyReason: () => undefined,
		readTaskTranscript: () => ({ ok: true as const, value: { messages: [] } }),
		followTaskTranscript: () => undefined,
	};
	const environment = taskTranscriptEnvironment({ keybindings: keys });
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {
			closed++;
		},
		undefined,
		() => environment,
	);
	const paint = () => stripVTControlCharacters(inspector.renderViewport(160, 30).join("\n"));
	try {
		// Enter on the subagent's row of /tasks opens its chat (a host without the single screen).
		inspector.open(parent.ref.taskId);
		inspector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.match(paint(), /↓ agents/);
		inspector.handleInput("\x1b[B");
		assert.equal(closed, 0);
		assert.match(paint(), /Tasks[\s\S]*Own background shell/);
		assert.equal(
			paint()
				.split("\n")
				.filter((line) => /↑↓ select|pgup\/pgdn scroll/.test(line)).length,
			1,
			"the nested sheet owns the only live-key hint",
		);
		inspector.handleInput("\x1b[D");
		assert.equal(closed, 0);
		assert.doesNotMatch(paint(), /Tasks {2}1 working/);
		assert.match(paint(), /← tasks/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});
