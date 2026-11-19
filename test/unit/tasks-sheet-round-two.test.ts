import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { renderBoardRow } from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import {
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import {
	TaskNavigation,
	type TaskNavigationActions,
} from "../../packages/coding-agent/src/modes/interactive/components/task-navigation.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";
const LEFT = "\x1b[D";
const END = "\x1b[F";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
});

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function plain(lines: readonly string[]): string {
	return lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
}

function withMessages(store: OwnerTaskStore, sendTaskMessage: (id: TaskId, text: string) => Promise<void>) {
	return Object.assign(Object.create(ownerTaskViewSource(store)) as TaskViewSource, { sendTaskMessage });
}

function askQuestion(
	fixture: ReturnType<typeof taskFixture>,
	requestId: string,
	prompt: string,
	runner = fixture.runners[0]!,
): void {
	runner.context.reportActivity({
		reportId: `ask-${requestId}`,
		change: {
			kind: "attention-set",
			attention: { kind: "input-needed", requestId, prompt, route: { sessionId: "child", promptId: requestId } },
		},
	});
	fixture.store.drain();
}

function waitingRun(promptId: string, question: string): AgentPanelItem {
	return { id: "run:ralph", kind: "agent", state: "input", name: "ralph", task: "stage plan", question, promptId };
}

test("a subagent waiting for input shows its question on its /tasks row (#5224)", async () => {
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		await fixture.start("Spawn lock fix");
		askQuestion(fixture, "q-1", "Which branch should I rebase onto?");
		const row = plain(inspector.renderPicker(100, 24))
			.split("\n")
			.find((line) => line.includes("◆"));
		assert.match(row ?? "", /◆ worker +Which branch should I rebase onto\? +waiting/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("a subagent waiting for input is answered in its own chat, opened by Space or Enter, never by a message sent from /tasks (#5224)", async () => {
	for (const key of [SPACE, ENTER]) {
		const fixture = taskFixture();
		const sent: Array<[string, string]> = [];
		const inspector = new TaskInspector(
			withMessages(fixture.store, async (id, text) => {
				sent.push([id, text]);
			}),
			() => {},
			() => {},
			undefined,
			() => taskTranscriptEnvironment(),
		);
		try {
			await fixture.start("Spawn lock fix");
			askQuestion(fixture, "q-1", "Which branch should I rebase onto?");
			const list = plain(inspector.renderPicker(100, 24)).split("\n");
			assert.equal(
				list.at(-1)?.trim(),
				"↑↓ select · space/enter/→ answer · x stop · / filter · esc/← close · ? keys",
				"Space is not offered as a peek for a question",
			);
			for (const char of "main") inspector.handleInput(char);
			inspector.handleInput(key);
			await flush();
			assert.deepEqual(sent, []);
			assert.equal(inspector.navigation.focus.kind, "detail");
			assert.match(plain(inspector.renderViewport(100, 24)).split("\n").at(-1) ?? "", /← tasks/, "its chat is open");
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}
});

test("without a chat in this host, a question row says so instead of claiming an answer (#5224)", async () => {
	const fixture = taskFixture();
	const sent: string[] = [];
	const inspector = new TaskInspector(
		withMessages(fixture.store, async (_id, text) => {
			sent.push(text);
		}),
		() => {},
		() => {},
	);
	try {
		await fixture.start("Spawn lock fix");
		askQuestion(fixture, "q-1", "Which branch should I rebase onto?");
		inspector.renderPicker(100, 24);
		inspector.handleInput(SPACE);
		await flush();
		const page = plain(inspector.renderViewport(100, 24));
		assert.match(page, /Which branch should I rebase onto\?/);
		assert.match(page, /Transcript inspection is unavailable in this host\./);
		assert.match(page, /esc\/← back to list/);
		assert.deepEqual(sent, []);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("a message typed to a working subagent is not sent once the subagent starts asking a question (#5224)", async () => {
	for (const repaint of [true, false]) {
		const fixture = taskFixture();
		const sent: string[] = [];
		const inspector = new TaskInspector(
			withMessages(fixture.store, async (_id, text) => {
				sent.push(text);
			}),
			() => {},
			() => {},
		);
		try {
			await fixture.start("Spawn lock fix");
			inspector.renderPicker(100, 24);
			inspector.handleInput(SPACE);
			inspector.renderPicker(100, 24);
			for (const char of "yes") inspector.handleInput(char);
			askQuestion(fixture, "q-1", "Delete the production database?");
			if (repaint) assert.match(plain(inspector.renderPicker(100, 24)), /your reply was cleared/);
			inspector.handleInput(ENTER);
			await flush();
			assert.deepEqual(sent, [], repaint ? "after a repaint" : "before a repaint");
			if (!repaint) assert.match(plain(inspector.renderPicker(100, 24)), /your reply was cleared/);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}
});

test("after a refused extension reply, a second Enter does not send the old draft to the newer question (#5224)", async () => {
	const fixture = taskFixture();
	let item = waitingRun("p1", "Approve this plan?");
	const listeners = new Set<() => void>();
	const accepted: Array<[string, string | undefined]> = [];
	const source: TaskBoardSource = {
		items: () => [item],
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		answer: async (_id, text, options) => {
			if (options?.promptId !== item.promptId)
				return { ok: false, reason: "The pending prompt changed before the answer was sent." };
			accepted.push([text, options?.promptId]);
			return { ok: true };
		},
	};
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource(source);
	try {
		inspector.renderPicker(100, 24);
		inspector.handleInput(SPACE);
		inspector.renderPicker(100, 24);
		for (const char of "yes") inspector.handleInput(char);
		item = waitingRun("p2", "Delete the production database?");
		for (const listener of [...listeners]) listener();
		inspector.handleInput(ENTER);
		await flush();
		const refused = plain(inspector.renderPicker(100, 24));
		assert.doesNotMatch(refused, /│ ❯ yes/, "the draft for the old question is cleared");
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(accepted, []);
		for (const char of "no") inspector.handleInput(char);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(accepted, [["no", "p2"]], "a reply typed for the new question reaches it");
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("/tasks rows show elapsed time as the agent panel does (#5224)", () => {
	const row = (state: AgentPanelItem["state"], elapsedMs: number) =>
		stripVTControlCharacters(
			renderBoardRow(
				{
					id: "run:a",
					kind: "item",
					item: { id: "run:a", kind: "agent", state, name: "ralph", task: "plan", elapsedMs },
				},
				false,
				100,
			),
		);
	assert.match(row("running", 192_000), / 3m$/);
	assert.match(row("input", 180_000), / waiting 3m$/);
	assert.match(row("running", 4_000_000), / 1h 6m$/);
	assert.match(row("failed", 240_000), / failed · 4m$/);
});

test("a /tasks row keeps its state and elapsed time at 40 columns (#5224)", () => {
	const line = stripVTControlCharacters(
		renderBoardRow(
			{
				id: "run:a",
				kind: "item",
				item: { id: "run:a", kind: "agent", state: "input", name: "ralph", task: "plan", elapsedMs: 180_000 },
			},
			false,
			39,
		),
	);
	assert.match(line, /waiting 3m$/);
});

function navigation(overrides: Partial<TaskNavigationActions> = {}) {
	return new TaskNavigation(new KeybindingsManager(), {
		inspect() {},
		openChat() {},
		transcript() {},
		armStop() {},
		cancel() {},
		dismiss() {},
		input() {},
		stdinAvailable: () => false,
		openQuestion() {},
		...overrides,
	});
}

test("a removed selected row passes the selection forward, then backward, then clears it (#5224)", () => {
	const rows = ["done0", "done1", "done2", "done3", "done4", "done5"].map((id) => taskRecord(id));
	const nav = navigation();
	const ids = (list: typeof rows) => list.map((task) => task.ref.taskId);
	nav.update(rows, ids(rows));
	nav.open(rows[2]!.ref.taskId);
	let remaining = rows.filter((_, index) => index !== 2);
	nav.update(remaining, ids(remaining));
	assert.equal(nav.selectedTaskId, "done3", "the next row takes the selection");
	remaining = rows.filter((_, index) => index < 2);
	nav.update(remaining, ids(remaining));
	assert.equal(nav.selectedTaskId, "done1", "with nothing after it, the row before takes it");
	nav.update([], []);
	assert.equal(nav.selectedTaskId, undefined);
});

test("x on a finished /tasks row the reader has not yet seen does not dismiss it (#5224)", async () => {
	const running = taskRecord("running");
	const finished = taskRecord("finished");
	finished.execution = { kind: "settled", result: { kind: "failed", code: "fixture", message: "done" } };
	const dismissed: string[] = [];
	const nav = navigation({ dismiss: (task) => dismissed.push(task.ref.taskId) });
	nav.update([running, finished], [running.ref.taskId, finished.ref.taskId]);
	nav.open();
	nav.paint([running]);
	nav.handleInput(END, "tasks");
	nav.handleInput("x", "tasks");
	await flush();
	assert.deepEqual(dismissed, [], "End then x in one frame keeps the unseen row");
	nav.paint([finished]);
	nav.handleInput("x", "tasks");
	await flush();
	assert.deepEqual(dismissed, [finished.ref.taskId]);
});

test("with a peek card open and no reply box, the /tasks hint says Space closes it (#5224)", async () => {
	const shell = taskRecord("shell-1", "command");
	shell.title = "azure-ci run 5222";
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		{ ...ownerTaskViewSource(fixture.store), tasks: [shell], backgroundTasks: [shell] },
		() => {},
		() => {},
	);
	try {
		inspector.renderPicker(100, 24);
		inspector.handleInput(SPACE);
		const hint = plain(inspector.renderPicker(100, 24)).split("\n").at(-1) ?? "";
		assert.equal(hint.trim(), "↑↓ select · enter/→ open · x stop · / filter · space/esc/← close · ? keys");
		assert.doesNotMatch(hint, /space peek/);
		inspector.handleInput(SPACE);
		assert.doesNotMatch(plain(inspector.renderPicker(100, 24)), /╭─ shell/, "Space closes it");
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("Esc and ← leave the /tasks sheet while an answer is still sending (#5224)", async () => {
	for (const key of [ESC, LEFT]) {
		const fixture = taskFixture();
		let closed = 0;
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {
				closed++;
			},
		);
		inspector.setBoardSource({
			items: () => [waitingRun("p1", "Approve this plan?")],
			subscribe: () => () => {},
			answer: () => new Promise(() => {}),
		});
		try {
			inspector.renderPicker(100, 24);
			inspector.handleInput(SPACE);
			inspector.renderPicker(100, 24);
			for (const char of "yes") inspector.handleInput(char);
			inspector.handleInput(ENTER);
			await flush();
			const sending = plain(inspector.renderPicker(100, 24));
			assert.match(sending, /Sending…/);
			assert.match(sending.split("\n").at(-1) ?? "", /esc\/← close/);
			inspector.handleInput(key);
			assert.equal(closed, 1);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}
});

test("a working subagent's peek card names its current tool call as the chat does, not as raw arguments (#5224)", async () => {
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		await fixture.start("Spawn lock fix");
		fixture.runners[0]!.context.reportActivity({
			reportId: "tool",
			change: {
				kind: "action",
				tool: "bash",
				text: JSON.stringify({ command: "sleep 300 >/dev/null 2>&1", timeout: 400 }),
			},
		});
		fixture.store.drain();
		inspector.renderPicker(100, 24);
		inspector.handleInput(SPACE);
		const card = plain(inspector.renderPicker(100, 24));
		assert.match(card, /│ .*Bash\(sleep 300/);
		assert.doesNotMatch(card, /\{"command"/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("a shell's input page is a /tasks bottom sheet, not a full-screen frame (#5224)", async () => {
	const shell = taskRecord("shell-1", "command");
	shell.title = "azure-ci run 5222";
	const fixture = taskFixture();
	const owner = ownerTaskViewSource(fixture.store);
	const inspector = new TaskInspector(
		{
			...owner,
			tasks: [shell],
			backgroundTasks: [shell],
			stdinAvailable: () => true,
			writeTaskInput: async (_id: TaskId, value: string) => ({
				ok: true as const,
				value: { acceptedBytes: value.length },
			}),
			readTaskOutput: async () => ({ ok: true as const, value: { text: "", omitted: false } }),
		},
		() => {},
		() => {},
	);
	try {
		inspector.renderPicker(100, 24);
		await inspector.navigation.activate("input");
		assert.equal(inspector.fullscreen, false, "the input stays in the sheet");
		const page = plain(inspector.renderPicker(100, 24));
		const lines = page.split("\n");
		assert.match(lines[0] ?? "", /^▔+$/, "the sheet's top edge");
		assert.match(lines[1] ?? "", /^ Input to azure-ci run 5222/);
		assert.doesNotMatch(page, /Background tasks|╭─|active · /);
		assert.match(lines.at(-1) ?? "", /^ {2}enter send · ← back to list$/);
		for (const char of "hello shell") inspector.handleInput(char);
		inspector.handleInput(ENTER);
		for (const char of " extra") inspector.handleInput(char);
		await flush();
		const acknowledged = plain(inspector.renderPicker(100, 24));
		assert.match(acknowledged, /Sent 11 bytes/);
		assert.match(acknowledged, /hello shell extra/, "acknowledging the earlier send keeps a newer draft");
		inspector.handleInput("\x1b[H");
		inspector.handleInput("\x1b[D");
		assert.equal(inspector.navigation.focus.kind, "tasks");
		assert.doesNotMatch(plain(inspector.renderPicker(100, 24)), /Sent 11 bytes/);
		await inspector.navigation.activate("input");
		assert.match(
			stripTerminalSequences(plain(inspector.renderPicker(100, 24))),
			/hello shell extra/,
			"returning restores the unsent draft",
		);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("the /tasks hint keeps its way out and help key, with one separator style, at 40 and 60 columns (#5224)", async () => {
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => [{ id: "run:a", kind: "agent", state: "done", name: "release", task: "ship", elapsedMs: 60_000 }],
		subscribe: () => () => {},
	});
	try {
		for (const width of [40, 60]) {
			const lines = plain(inspector.renderPicker(width, 24)).split("\n");
			const hint = lines.at(-1) ?? "";
			assert.match(hint, /esc\/← close · \? keys$/, `${width} columns`);
			assert.doesNotMatch(hint, /\S·\S/, "no squeezed separators");
			assert.match(lines.find((line) => line.includes("release")) ?? "", /done · 1m$/);
		}
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("an interrupted subagent shows as stopped in /tasks and its elapsed time stops (#5224)", async () => {
	let now = 1_800_000_000_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		await fixture.start("Spawn lock fix");
		fixture.runners[0]!.context.reportActivity({ reportId: "m", change: { kind: "metrics", elapsedMs: 60_000 } });
		fixture.store.drain();
		const row = () =>
			plain(inspector.renderPicker(100, 24))
				.split("\n")
				.find((line) => line.includes("Spawn lock fix")) ?? "";
		assert.match(row(), /∀ worker +Spawn lock fix +1m$/);
		fixture.store.setTurnInterrupted(fixture.store.tasks[0]!.ref.taskId, true);
		assert.match(row(), /◼ worker +Spawn lock fix +stopped · 1m$/);
		assert.match(plain(inspector.renderPicker(100, 24)), /Done\n.*Spawn lock fix/);
		now += 180_000;
		assert.match(row(), /stopped · 1m$/, "the interrupted turn's time does not keep counting");
	} finally {
		clock.mockRestore();
		inspector.dispose();
		await fixture.dispose();
	}
});

test("an interrupted subagent's /tasks detail page reads stopped, not running (#5224)", async () => {
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {},
	);
	try {
		await fixture.start("Spawn lock fix");
		fixture.store.setTurnInterrupted(fixture.store.tasks[0]!.ref.taskId, true);
		inspector.renderPicker(100, 24);
		inspector.handleInput(SPACE);
		inspector.renderPicker(100, 24);
		inspector.handleInput(ENTER);
		await flush();
		const detail = plain(inspector.renderViewport(100, 24));
		assert.match(detail, /◼ Stopped · send to resume/);
		assert.doesNotMatch(detail, /Running/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});
