import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

/** Alt+W as a terminal sends it: Esc, then the key. */
const ALT_W = "\x1bw";
const LEFT = "\x1b[D";
const HOME = "\x1b[H";
const PAGE_UP = "\x1b[5~";

let keys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(keys));

function waitingAgent(id: string, ordinal: number): TaskRecord {
	return {
		...taskRecord(id),
		launchOrdinal: ordinal,
		agentName: id,
		title: `${id} builds`,
		wasBackground: true,
		observation: { kind: "none", reason: "task-settled" },
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: `wait-${id}`, toolName: "bash" }] },
			},
		},
	};
}

function shellOf(agent: string): TaskRecord {
	return { ...taskRecord(`${agent}-shell`, "command"), title: `${agent} build`, parentTaskId: agent as TaskId };
}

/** A session's tasks that a test changes, telling the inspector as the owner store does. */
function liveSource(initial: TaskRecord[]) {
	let tasks = initial;
	const listeners = new Set<() => void>();
	const transcript = Array.from({ length: 40 }, (_, index) => ({
		role: "user" as const,
		content: `transcript message ${index}`,
		timestamp: index + 1,
	}));
	const source: TaskViewSource = transcriptOnlySource({
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		recentActivity: () => [],
		activityOmitted: () => false,
		stdinAvailable: () => false,
		taskDetailText: () => ({}),
		extensionStatuses: () => new Map(),
		watchExtensionStatuses: () => () => {},
		readTaskOutput: async (id) => ({ ok: true, value: { text: `output of ${id}`, omitted: false } }),
		readTaskTranscript: () => ({ ok: true, value: { messages: transcript } }),
		followTaskTranscript: () => undefined,
		sendTaskMessage: async () => {},
		taskStopped: () => false,
	});
	// The task lists are read live, as the owner store's are, so an update is seen on the next read.
	const own = () => tasks.filter((task) => task.parentTaskId === undefined);
	Object.defineProperties(source, {
		tasks: { get: own },
		backgroundTasks: { get: own },
		ownerTasks: { get: () => tasks },
		ownerBackgroundTasks: { get: () => tasks },
	});
	return {
		source,
		update(next: TaskRecord[]) {
			tasks = next;
			for (const listener of listeners) listener();
		},
	};
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 5));
}

function inspectorOver(source: TaskViewSource) {
	// The chat's real editor, so its cursor moves as a reader's does.
	const environment = taskTranscriptEnvironment({
		tui: { requestRender() {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI,
		keybindings: getKeybindings(),
	});
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
		undefined,
		() => environment,
	);
	// Text as shown, without the editor's cursor markers, which `stripVTControlCharacters` keeps.
	const screen = (width = 100, rows = 24) =>
		inspector
			.renderViewport(width, rows)
			.map((line) => stripVTControlCharacters(line).replace(/\x1b_[^\x07]*\x07/g, ""))
			.join("\n");
	return { inspector, screen };
}

test("alt+w after a list update that moved the selection opens no other subagent's shell", async () => {
	const a = waitingAgent("alpha", 0);
	const b = waitingAgent("beta", 1);
	const live = liveSource([a, b, shellOf("alpha"), shellOf("beta")]);
	const { inspector, screen } = inspectorOver(live.source);
	try {
		inspector.open(a.ref.taskId);
		assert.match(screen(), /❯ ◌ alpha/, "alpha is painted as selected");
		// alpha leaves the list before the next paint; beta, also waiting, remains.
		live.update([b, shellOf("beta")]);
		inspector.handleInput(ALT_W);
		await settle();
		const shown = screen();
		assert.doesNotMatch(shown, /^ {2}shell$/m, `no shell opened: ${shown}`);
		assert.doesNotMatch(shown, /output of beta-shell/, shown);
		inspector.handleInput(ALT_W);
		await settle();
		assert.match(screen(), /output of beta-shell/, "a second alt+w, on the painted beta row, opens its shell");
	} finally {
		inspector.dispose();
	}
});

test("back from a waiting subagent's shell restores its chat's scroll, draft and cursor", async () => {
	const a = waitingAgent("alpha", 0);
	const live = liveSource([a, shellOf("alpha")]);
	const { inspector, screen } = inspectorOver(live.source);
	try {
		inspector.open(a.ref.taskId);
		inspector.handleInput("\r");
		await settle();
		screen();
		inspector.handleInput(PAGE_UP);
		for (const char of "draft") inspector.handleInput(char);
		inspector.handleInput(HOME);
		const before = screen();
		assert.doesNotMatch(before, /transcript message 39/, `scrolled above the end: ${before}`);
		inspector.handleInput(ALT_W);
		await settle();
		assert.match(screen(), /output of alpha-shell/);
		inspector.handleInput(LEFT);
		await settle();
		assert.equal(screen(), before, "the chat comes back as it was left");
		inspector.handleInput("X");
		assert.match(screen(), /Xdraft/, "the cursor is where it was left");
	} finally {
		inspector.dispose();
	}
});

test("back from a waiting subagent's shell restores the /tasks peek and the detail page", async () => {
	const a = waitingAgent("alpha", 0);
	const live = liveSource([a, shellOf("alpha")]);
	const { inspector, screen } = inspectorOver(live.source);
	try {
		inspector.open(a.ref.taskId);
		inspector.handleInput(" ");
		const peeked = screen();
		inspector.handleInput(ALT_W);
		await settle();
		assert.match(screen(), /output of alpha-shell/);
		inspector.handleInput(LEFT);
		await settle();
		assert.equal(screen(), peeked, "the peek is open again");

		inspector.handleInput(" ");
		// The task's detail page, as the list's inspect action opens it, with its second action chosen.
		inspector.navigation.handleInput(" ", "tasks");
		await settle();
		inspector.handleInput("\x1b[B");
		const detail = screen();
		assert.equal(inspector.navigation.focus.kind, "detail");
		inspector.handleInput(ALT_W);
		await settle();
		assert.match(screen(), /output of alpha-shell/);
		inspector.handleInput(LEFT);
		await settle();
		assert.equal(screen(), detail, "the detail page comes back with its action");
	} finally {
		inspector.dispose();
	}
});
