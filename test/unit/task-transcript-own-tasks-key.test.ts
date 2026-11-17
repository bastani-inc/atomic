import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

test("Down in an attached subagent's empty prompt opens its own tasks without leaving the chat (#5224)", async () => {
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
		tasks: [parent, child],
		backgroundTasks: [parent, child],
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
		inspector.openChat(parent.ref.taskId, "main chat");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.match(paint(), /↓ agents/);
		inspector.handleInput("\x1b[B");
		assert.equal(closed, 0);
		assert.match(paint(), /Tasks[\s\S]*Own background shell/);
		inspector.handleInput("\x1b[D");
		assert.equal(closed, 0);
		assert.doesNotMatch(paint(), /Tasks {2}1 working/);
		assert.match(paint(), /← main chat/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});
