import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";

const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const HOME = "\x1b[H";
const WHEEL_UP = "\x1b[<64;10;5M";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
});

const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");

function waitingItem(id: string, choices: string[]): AgentPanelItem {
	return {
		id,
		kind: "workflow",
		state: "input",
		name: id.replace(/^run:/, ""),
		task: "stage plan",
		question: "Select an action",
		choices,
		elapsedMs: 1000,
	};
}

test("initial selection stays on the first arrived task before first paint and Home on detail reaches newer tasks (#4521, #5224)", async () => {
	const fixture = taskFixture();
	try {
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
		);
		await fixture.start("Older job");
		await fixture.start("Newer job");
		const firstId = fixture.store.tasks[0]?.ref.taskId;
		const secondId = fixture.store.tasks[1]?.ref.taskId;
		assert.equal(inspector.navigation.selectedTaskId, firstId);

		inspector.handleInput(WHEEL_UP);
		assert.equal(inspector.navigation.selectedTaskId, secondId);
		inspector.handleInput(SPACE);
		await flush();
		assert.equal(inspector.navigation.focus.kind, "detail");

		await fixture.start("Newest job");
		const thirdId = fixture.store.tasks[2]?.ref.taskId;
		inspector.handleInput(HOME);
		assert.equal(inspector.navigation.selectedTaskId, thirdId);
		inspector.dispose();
	} finally {
		await fixture.dispose();
	}
});

test("digit for a drawn and offered choice inserts the choice after clearing a notice in a 7-row picker (#5224)", async () => {
	const fixture = taskFixture();
	const items: AgentPanelItem[] = [
		waitingItem("run:question", ["A", "B", "C", "D", "E"]),
		{ id: "run:working", kind: "workflow", state: "running", name: "working", task: "stage run" },
	];
	let releaseStop!: () => void;
	const source: TaskBoardSource = {
		items: () => items,
		subscribe: () => () => {},
		answer: async () => ({ ok: true }),
		stop: () =>
			new Promise((resolve) => {
				releaseStop = () => resolve({ ok: false, reason: "offline" });
			}),
	};
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		inspector.handleInput(DOWN);
		inspector.handleInput("x");
		inspector.handleInput("x");
		inspector.handleInput(UP);
		inspector.handleInput(SPACE);
		releaseStop();
		await flush();

		const frame = plain(inspector.renderPicker(100, 7));
		assert.match(frame, /│ 1 A\b/);
		assert.match(frame, /1-1 choose/);

		inspector.handleInput("1");
		const afterDigit = plain(inspector.renderPicker(100, 7));
		assert.match(afterDigit, /│ ❯ A\b/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("stopNotice is evaluated once per renderBoard so an expiring confirm window keeps card choices and hint aligned (#5224)", async () => {
	const fixture = taskFixture();
	const items: AgentPanelItem[] = [
		waitingItem("run:question", ["A", "B", "C", "D", "E"]),
		{ id: "run:working", kind: "workflow", state: "running", name: "working", task: "stage run" },
	];
	const source: TaskBoardSource = {
		items: () => items,
		subscribe: () => () => {},
		answer: async () => ({ ok: true }),
		stop: async () => ({ ok: true }),
	};
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		inspector.navigation.stopConfirm.press("run:working" as never);

		let calls = 0;
		const originalPending = inspector.navigation.stopConfirm.pending.bind(inspector.navigation.stopConfirm);
		inspector.navigation.stopConfirm.pending = () => {
			calls++;
			return calls === 1 ? originalPending() : undefined;
		};

		const frame = plain(inspector.renderPicker(100, 40));
		assert.equal(calls, 1, "stopNotice pending state should be read once per renderBoard");
		assert.match(frame, /│ 3 C\b/);
		assert.doesNotMatch(frame, /│ 4 D\b/);
		assert.match(frame, /1-3 choose/);

		inspector.handleInput("4");
		const afterFour = plain(inspector.renderPicker(100, 40));
		assert.doesNotMatch(afterFour, /│ ❯ D\b/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("in a 1-row or 2-row picker, a replying card shows the reply and Sending lines instead of only the bottom border (#5224)", async () => {
	const fixture = taskFixture();
	let releaseSend!: () => void;
	const source: TaskBoardSource = {
		items: () => [waitingItem("run:ralph", ["Yes", "No"])],
		subscribe: () => () => {},
		answer: () =>
			new Promise((resolve) => {
				releaseSend = () => resolve({ ok: true });
			}),
	};
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		for (const ch of "Ship") inspector.handleInput(ch);

		for (const rows of [1, 2]) {
			const rendered = plain(inspector.renderPicker(100, rows));
			assert.match(rendered, /│ ❯ Ship\b/, `reply line visible at ${rows} rows`);
			assert.doesNotMatch(rendered, /╰─+╯/, `bottom border does not displace reply line at ${rows} rows`);
		}

		inspector.handleInput(ENTER);
		for (const rows of [1, 2]) {
			const rendered = plain(inspector.renderPicker(100, rows));
			assert.match(rendered, /│ Sending…/, `Sending line visible at ${rows} rows`);
		}
		releaseSend();
		await flush();
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("a typed answer is restored as a draft when its row leaves and returns during an in-flight send that fails (#5224)", async () => {
	const fixture = taskFixture();
	const ralph = waitingItem("run:ralph", ["Yes", "No"]);
	let currentItems: AgentPanelItem[] = [ralph];
	const listeners = new Set<() => void>();
	let resolveSend!: (res: { ok: false; reason: string }) => void;
	const source: TaskBoardSource = {
		items: () => currentItems,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		answer: () =>
			new Promise((resolve) => {
				resolveSend = resolve;
			}),
	};
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		for (const ch of "Ship it") inspector.handleInput(ch);
		inspector.handleInput(ENTER);

		currentItems = [];
		emit();
		inspector.renderViewport(100, 24);
		currentItems = [ralph];
		emit();
		inspector.renderViewport(100, 24);

		resolveSend({ ok: false, reason: "offline" });
		await flush();

		const noticeFrame = plain(inspector.renderViewport(100, 24));
		assert.match(noticeFrame, /Could not send the answer: offline/);

		inspector.handleInput(SPACE);
		const reopened = plain(inspector.renderViewport(100, 24));
		assert.match(reopened, /│ ❯ Ship it\b/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("a waiting item without an answerable question does not offer a reply box in /tasks (#5224)", async () => {
	const fixture = taskFixture();
	const source: TaskBoardSource = {
		items: () => [
			{
				id: "run:custom",
				kind: "workflow",
				state: "input",
				name: "custom-ui",
				task: "stage form",
			},
		],
		subscribe: () => () => {},
		answer: async () => ({ ok: true }),
	};
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		const frame = plain(inspector.renderViewport(100, 24));
		assert.match(frame, /╭─ custom-ui ─/);
		assert.doesNotMatch(frame, /│ ❯/);
		assert.doesNotMatch(frame, /enter send/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("an extension open that throws keeps /tasks open, shows a failure notice, and reports the error (#5224)", async () => {
	const fixture = taskFixture();
	const hub = new AgentPanelSourceHub();
	const errors: unknown[] = [];
	hub.register({
		items: () => [
			{
				id: "run:broken",
				kind: "workflow",
				state: "running",
				name: "broken-run",
				task: "stage build",
			},
		],
		subscribe: () => () => {},
		open: () => {
			throw new Error("overlay failed");
		},
	});
	const session = {
		extensionRunner: {
			getAgentPanelSourceHub: () => hub,
			emitError: (err: unknown) => errors.push(err),
		},
	};
	let closed = 0;
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {
			closed++;
		},
	);
	try {
		inspector.setBoardSource(agentPanelBoardSource(session));
		inspector.handleInput(ENTER);
		assert.equal(closed, 0, "inspector stays open when source.open fails");
		const frame = plain(inspector.renderViewport(100, 24));
		assert.match(frame, /Could not open broken-run/);
		assert.equal(errors.length, 1, "extension error reported through emitError");
	} finally {
		inspector.dispose();
		hub.dispose();
		await fixture.dispose();
	}
});

test("failure notices and shell input title sanitize terminal control sequences (#5224)", async () => {
	const fixture = taskFixture();
	const source: TaskBoardSource = {
		items: () => [waitingItem("run:ralph", ["Yes"])],
		subscribe: () => () => {},
		answer: async () => ({ ok: false, reason: "bad\x1b[2J\x1b]2;pwn\x07reason\u202e" }),
		stop: async () => ({ ok: false, reason: "stop\x1b[2J\x1b]2;pwn\x07err\u202e" }),
	};
	const viewSource = ownerTaskViewSource(fixture.store);
	const customSource = Object.assign(Object.create(viewSource) as typeof viewSource, {
		stdinAvailable: () => true,
	});
	const inspector = new TaskInspector(
		customSource,
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		inspector.renderViewport(100, 24);
		inspector.handleInput("1");
		inspector.handleInput(ENTER);
		await flush();
		const answerFrame = inspector.renderViewport(100, 24).join("\n");
		assert.ok(!answerFrame.includes("\x1b[2J"));
		assert.ok(!answerFrame.includes("\x1b]2;"));
		assert.ok(!answerFrame.includes("\u202e"));

		inspector.handleInput(ESC);
		inspector.handleInput("x");
		inspector.handleInput("x");
		await flush();
		const stopFrame = inspector.renderViewport(100, 24).join("\n");
		assert.ok(!stopFrame.includes("\x1b[2J"));
		assert.ok(!stopFrame.includes("\x1b]2;"));
		assert.ok(!stopFrame.includes("\u202e"));

		await fixture.start("shell\x1b[2J\x1b]2;title\x07\u202ecmd");
		inspector.handleInput(DOWN);
		await inspector.navigation.activate("input");
		const stdinFrame = inspector.renderViewport(100, 24).join("\n");
		assert.ok(!stdinFrame.includes("\x1b[2J"));
		assert.ok(!stdinFrame.includes("\x1b]2;"));
		assert.ok(!stdinFrame.includes("\u202e"));
		assert.match(stripVTControlCharacters(stdinFrame), /Input to shell/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});
