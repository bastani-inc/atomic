import assert from "node:assert/strict";
import { getKeybindings, matchesKey, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { bindTaskClock, TaskElapsedClocks } from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	AgentPanelFocus,
	AgentPanelModel,
	type AgentPanelRow,
	type AgentPanelStyle,
	renderAgentPanelHint,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import {
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { agentPanelBoardSource } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

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
		kind: "agent",
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
		inspector.handleInput(ENTER);
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
		{ id: "run:working", kind: "agent", state: "running", name: "working", task: "stage run" },
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
		{ id: "run:working", kind: "agent", state: "running", name: "working", task: "stage run" },
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
		inspector.renderPicker(100, 30);
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
		inspector.renderPicker(100, 30);
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
				kind: "agent",
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
				kind: "agent",
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

test("store events on the /tasks list page mark the board stale and call refreshOrder at most once before the next paint (#5224)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("Task one");
		await fixture.start("Task two");
		let itemReads = 0;
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource({
			items: () => {
				itemReads++;
				return [];
			},
			subscribe: () => () => {},
		});
		let refreshCalls = 0;
		const originalRefresh = Reflect.get(inspector, "refreshOrder") as (this: TaskInspector) => void;
		Reflect.set(inspector, "refreshOrder", function (this: TaskInspector) {
			refreshCalls++;
			originalRefresh.call(this);
		});
		itemReads = 0;

		for (let i = 0; i < 20; i++) {
			taskValue(
				fixture.runners[1]!.context.reportActivity({
					reportId: `burst-${i}`,
					change: { kind: "action", tool: "bash", text: `step ${i}` },
				}),
			);
			fixture.store.drain();
		}

		assert.equal(refreshCalls, 0, "store burst on the list page must not eagerly run refreshOrder per event");
		assert.equal(itemReads, 0, "store burst on the list page must not reread boardSource.items per event");

		const frame = plain(inspector.renderViewport(100, 24));
		assert.equal(refreshCalls, 1, "next paint refreshes the stale board once");
		assert.match(frame, /Task two/);
		inspector.handleInput(SPACE);
		assert.match(plain(inspector.renderViewport(100, 24)), /Bash\(step 19\)/);
		inspector.dispose();
	} finally {
		await fixture.dispose();
	}
});

test("finished-while-armed notice clears in AgentPanelFocus and /tasks when the row runs again under the same id (#5224)", async () => {
	const panelStyle: AgentPanelStyle = {
		dim: (text) => text,
		text: (text) => text,
		muted: (text) => text,
		border: (text) => text,
		bold: (text) => text,
		accent: (text) => text,
		success: (text) => text,
		error: (text) => text,
		warning: (text) => text,
	};
	const keys = new KeybindingsManager();
	const panelCalls: string[] = [];
	const focus = new AgentPanelFocus(keys, {
		open: (row) => panelCalls.push(`open ${row.id}`),
		stop: (row) => panelCalls.push(`stop ${row.id}`),
		dismiss: (row) => panelCalls.push(`dismiss ${row.id}`),
		close: () => panelCalls.push("close"),
	});
	const runningRow: AgentPanelRow = {
		id: "run:deploy",
		kind: "agent",
		state: "running",
		name: "deploy",
		task: "stage build",
	};
	focus.update([runningRow]);
	focus.enter();
	const pressPanel = (data: string) => focus.handleInput(data, (input, key) => matchesKey(input, key as "up"));
	pressPanel("x");
	focus.update([{ ...runningRow, state: "stopped" }]);
	assert.match(
		stripVTControlCharacters(renderAgentPanelHint(focus, 120, panelStyle, keys)),
		/deploy finished · x to acknowledge/,
	);

	focus.update([runningRow]);
	assert.equal(focus.finishedWhileArmed, undefined);
	assert.doesNotMatch(stripVTControlCharacters(renderAgentPanelHint(focus, 120, panelStyle, keys)), /finished · x to/);
	pressPanel("x");
	assert.deepEqual(panelCalls, [], "first x on a restarted row arms stop rather than stopping");
	assert.match(
		stripVTControlCharacters(renderAgentPanelHint(focus, 120, panelStyle, keys)),
		/Press x again within 3s to stop deploy/,
	);

	const fixture = taskFixture();
	const listeners = new Set<() => void>();
	const stopped: string[] = [];
	let currentItems: AgentPanelItem[] = [runningRow];
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		inspector.setBoardSource({
			items: () => currentItems,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			stop: async (id) => {
				stopped.push(id);
				return { ok: true };
			},
		});
		const emit = () => {
			for (const listener of listeners) listener();
		};
		inspector.handleInput("x");
		currentItems = [{ ...runningRow, state: "stopped" }];
		emit();
		assert.match(plain(inspector.renderViewport(100, 24)), /deploy finished · x to acknowledge/);

		currentItems = [runningRow];
		emit();
		const restartedFrame = plain(inspector.renderViewport(100, 24));
		assert.doesNotMatch(restartedFrame, /deploy finished · x to/);

		inspector.handleInput("x");
		assert.deepEqual(stopped, []);
		assert.match(plain(inspector.renderViewport(100, 24)), /Press x again within 3s to stop deploy/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("answer and stop failures after /tasks is disposed report through the host environment notify (#5224)", async () => {
	const fixture = taskFixture();
	try {
		const notices: string[] = [];
		const env = () => ({ notify: (msg: string) => notices.push(msg) }) as never;
		let settleReply!: (res: { ok: false; reason: string }) => void;
		let throwReply!: (err: Error) => void;
		let settleStop!: (res: { ok: false; reason: string }) => void;
		let throwStop!: (err: Error) => void;
		let replyAttempt = 0;
		let stopAttempt = 0;
		const items: AgentPanelItem[] = [
			waitingItem("run:ralph", ["Yes"]),
			{ id: "run:build", kind: "agent", state: "running", name: "build", task: "stage 1" },
		];
		const source: TaskBoardSource = {
			items: () => items,
			subscribe: () => () => {},
			answer: () =>
				new Promise((resolve, reject) => {
					replyAttempt++;
					if (replyAttempt === 1) settleReply = resolve;
					else throwReply = reject;
				}),
			stop: () =>
				new Promise((resolve, reject) => {
					stopAttempt++;
					if (stopAttempt === 1) settleStop = resolve;
					else throwStop = reject;
				}),
		};
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			env,
		);
		inspector.setBoardSource(source);
		inspector.handleInput(SPACE);
		inspector.renderPicker(100, 30);
		for (const ch of "yes") inspector.handleInput(ch);
		inspector.handleInput(ENTER);
		inspector.dispose();

		settleReply({ ok: false, reason: "channel closed" });
		await flush();
		assert.deepEqual(notices, ["Could not send the answer: channel closed"]);

		const throwReplyInspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			env,
		);
		throwReplyInspector.setBoardSource(source);
		throwReplyInspector.handleInput(SPACE);
		throwReplyInspector.renderPicker(100, 30);
		for (const ch of "yes") throwReplyInspector.handleInput(ch);
		throwReplyInspector.handleInput(ENTER);
		throwReplyInspector.dispose();

		throwReply(new Error("answer socket lost"));
		await flush();
		assert.deepEqual(notices, [
			"Could not send the answer: channel closed",
			"Could not send the answer: answer socket lost",
		]);

		const stopInspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			env,
		);
		stopInspector.setBoardSource(source);
		stopInspector.handleInput(DOWN);
		stopInspector.handleInput("x");
		stopInspector.handleInput("x");
		stopInspector.dispose();

		settleStop({ ok: false, reason: "runner busy" });
		await flush();
		assert.deepEqual(notices, [
			"Could not send the answer: channel closed",
			"Could not send the answer: answer socket lost",
			"Could not stop build: runner busy",
		]);

		const throwStopInspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
			undefined,
			env,
		);
		throwStopInspector.setBoardSource(source);
		throwStopInspector.handleInput(DOWN);
		throwStopInspector.handleInput("x");
		throwStopInspector.handleInput("x");
		throwStopInspector.dispose();

		throwStop(new Error("stop socket lost"));
		await flush();
		assert.deepEqual(notices, [
			"Could not send the answer: channel closed",
			"Could not send the answer: answer socket lost",
			"Could not stop build: runner busy",
			"Could not stop build: stop socket lost",
		]);

		await fixture.start("Background shell");
		let settleTaskCancel!: (res: { ok: false; error: { code: "conflict"; message: string } }) => void;
		const baseView = ownerTaskViewSource(fixture.store);
		const customStore = Object.assign(Object.create(baseView) as typeof baseView, {
			cancelTask: () =>
				new Promise<{ ok: false; error: { code: "conflict"; message: string } }>((resolve) => {
					settleTaskCancel = resolve;
				}),
		});
		const taskCancelInspector = new TaskInspector(
			customStore,
			() => {},
			() => {},
			undefined,
			env,
		);
		taskCancelInspector.handleInput("x");
		taskCancelInspector.handleInput("x");
		taskCancelInspector.dispose();

		settleTaskCancel({ ok: false, error: { code: "conflict", message: "already stopping" } });
		await flush();
		assert.deepEqual(notices, [
			"Could not send the answer: channel closed",
			"Could not send the answer: answer socket lost",
			"Could not stop build: runner busy",
			"Could not stop build: stop socket lost",
			"Could not stop the task: already stopping",
		]);
	} finally {
		await fixture.dispose();
	}
});

test("extension agent and shell items share live elapsed clocks between AgentPanelModel and /tasks (#5224)", async () => {
	let now = 10_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	try {
		const clocks = new TaskElapsedClocks();
		const makeItem = (): AgentPanelItem =>
			bindTaskClock(
				{
					id: "ext:agent-1",
					kind: "agent",
					state: "running",
					name: "helper",
					task: "index repository",
					elapsedMs: 1_000,
				},
				clocks,
			);
		const model = new AgentPanelModel(() => now);
		assert.equal(model.rows([makeItem()])[0]?.elapsedMs, 1_000);

		now += 60_000;
		assert.equal(model.rows([makeItem()])[0]?.elapsedMs, 61_000);

		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource({
			items: () => [makeItem()],
			subscribe: () => () => {},
		});
		const frame = plain(inspector.renderViewport(100, 24));
		assert.match(frame, /∀ helper +index repository +1m\b/);
		const directRow = stripVTControlCharacters(
			renderBoardRow({ id: "ext:agent-1", kind: "item", item: makeItem() }, false, 100),
		);
		assert.match(directRow, /index repository +1m$/);
		inspector.dispose();
	} finally {
		vi.restoreAllMocks();
		await fixture.dispose();
	}
});
