import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { AgentPanelItem } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	REPLY_ENTER_GUARD_MS,
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";
const DOWN = "\x1b[B";

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

/** An extension row source, recording what /tasks asks of it. */
function runSource(items: AgentPanelItem[]) {
	const listeners = new Set<() => void>();
	const calls = {
		opened: [] as string[],
		returns: [] as (() => void)[],
		stopped: [] as string[],
		answered: [] as [string, string][],
		dismissed: [] as string[],
	};
	const source: TaskBoardSource = {
		items: () => items,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		open: (id, options) => {
			calls.opened.push(id);
			if (options?.onReturn) calls.returns.push(options.onReturn);
			return true;
		},
		stop: async (id) => {
			calls.stopped.push(id);
			return { ok: true };
		},
		answer: async (id, text) => {
			calls.answered.push([id, text]);
			return { ok: true };
		},
		dismiss: (id) => calls.dismissed.push(id),
	};
	return {
		source,
		calls,
		emit: () => {
			for (const listener of listeners) listener();
		},
	};
}

const waitingRun: AgentPanelItem = {
	id: "run:ralph",
	kind: "agent",
	state: "input",
	name: "ralph",
	task: "stage plan",
	question: "Approve this plan?",
	choices: ["Yes", "No, revise", "Stop the run"],
	elapsedMs: 180_000,
	progress: { done: 1, total: 5 },
};
const failedRun: AgentPanelItem = {
	id: "run:review",
	kind: "agent",
	state: "failed",
	name: "review-pr",
	task: "stage verify",
	reason: "gate failed: 2 jobs",
	elapsedMs: 240_000,
};

async function harness(items: AgentPanelItem[] = []) {
	const fixture = taskFixture();
	let closed = 0;
	const inspector = new TaskInspector(
		ownerTaskViewSource(fixture.store),
		() => {},
		() => {
			closed++;
		},
	);
	const runs = runSource(items);
	inspector.setBoardSource(runs.source);
	const text = (width = 100, rows = 24) =>
		inspector
			.renderViewport(width, rows)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");
	return {
		fixture,
		inspector,
		runs,
		text,
		closed: () => closed,
		async dispose() {
			inspector.dispose();
			await fixture.dispose();
		},
	};
}

test("/tasks groups native tasks and extension rows as Needs input, Working and Done, with counts (#5224)", async () => {
	const h = await harness([waitingRun, failedRun]);
	try {
		await h.fixture.start("Spawn lock fix");
		const text = h.text();
		const lines = text.split("\n");
		assert.match(lines[0] ?? "", /^▔+$/, "the sheet's top edge");
		assert.equal(lines[1], " Tasks  1 needs input · 1 working · 1 done");
		const groups = ["   Needs input", "   Working", "   Done"].map((title) => lines.indexOf(title));
		assert.ok(
			groups.every((index) => index > 0),
			text,
		);
		assert.deepEqual(
			[...groups].sort((a, b) => a - b),
			groups,
			"Needs input, then Working, then Done",
		);
		assert.match(text, /◆ ralph +Approve this plan\? +waiting 3m$/m);
		assert.match(text, /∀ worker +Spawn lock fix/, "a working row shows Atomic's ∀");
		assert.match(text, /✗ review-pr +stage verify · gate failed: 2 jobs +failed · 4m$/m);
		assert.match(
			lines.at(-1) ?? "",
			/^ {2}↑↓ select · space peek · enter\/→ open · x stop · \/ filter · esc\/← close · \? keys$/,
		);
	} finally {
		await h.dispose();
	}
});

test("Space peeks at a waiting run's question; a number picks a choice and Enter sends it (#5224)", async () => {
	const h = await harness([waitingRun]);
	try {
		h.inspector.handleInput(SPACE);
		let text = h.text();
		assert.match(text, /╭─ ralph ─/);
		assert.match(text, /│ Approve this plan\?/);
		assert.match(text, /│ 1 Yes/);
		assert.match(text, /│ 3 Stop the run/);
		assert.match(text, /│ ❯/, "a reply input");
		assert.equal(text.split("\n").at(-1)?.trim(), "↑↓ select · 1-3 choose · enter send · esc/← close");
		h.inspector.handleInput("2");
		assert.match(h.text(), /│ ❯ No, revise/);
		h.inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(h.runs.calls.answered, [["run:ralph", "No, revise"]]);
		text = h.text();
		assert.doesNotMatch(text, /╭─ ralph/, "the card closes once the answer is sent");
		assert.match(text, /Sent to ralph/);
	} finally {
		await h.dispose();
	}
});

test("Esc closes a peek without leaving /tasks, and typed reply text is answered as typed (#5224)", async () => {
	const h = await harness([waitingRun]);
	try {
		h.inspector.handleInput(SPACE);
		h.inspector.renderPicker(100, 30);
		for (const ch of "go ahead") h.inspector.handleInput(ch);
		h.inspector.handleInput(ESC);
		assert.doesNotMatch(h.text(), /╭─ ralph/);
		assert.equal(h.closed(), 0, "Esc closed the card, not /tasks");
		h.inspector.handleInput(SPACE);
		assert.match(h.text(), /│ ❯ go ahead/, "a closed card keeps its typed reply");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(h.runs.calls.answered, [["run:ralph", "go ahead"]]);
	} finally {
		await h.dispose();
	}
});

test("Enter on an extension row opens it through its source and closes /tasks; x x stops it; x dismisses a finished one (#5224)", async () => {
	const running: AgentPanelItem = {
		id: "run:build",
		kind: "agent",
		state: "running",
		name: "build",
		task: "stage compile",
	};
	const h = await harness([running, failedRun]);
	try {
		h.inspector.handleInput("x");
		assert.match(h.text(), /Press x again within 3s to stop build/);
		assert.deepEqual(h.runs.calls.stopped, []);
		h.inspector.handleInput("x");
		await flush();
		assert.deepEqual(h.runs.calls.stopped, ["run:build"]);
		h.inspector.handleInput(DOWN);
		assert.match(h.text(), /x dismiss/, "a finished row's x dismisses it");
		h.inspector.handleInput("x");
		assert.deepEqual(h.runs.calls.dismissed, ["run:review"]);
		assert.doesNotMatch(h.text(), /review-pr/);
		h.inspector.handleInput(ENTER);
		assert.deepEqual(h.runs.calls.opened, ["run:build"]);
		assert.equal(h.closed(), 1, "opening a run's graph leaves /tasks");
	} finally {
		await h.dispose();
	}
});

test("/ filters rows by name or task, Enter keeps the filter, Esc clears it (#5224)", async () => {
	const h = await harness([waitingRun, failedRun]);
	try {
		await h.fixture.start("Spawn lock fix");
		h.inspector.handleInput("/");
		assert.match(h.text().split("\n").at(-1) ?? "", /type filter · enter done · esc clear/);
		for (const ch of "spawn") h.inspector.handleInput(ch);
		let text = h.text();
		assert.match(text, /Spawn lock fix/);
		assert.doesNotMatch(text, /ralph|review-pr/);
		h.inspector.handleInput(ENTER);
		text = h.text();
		assert.match(text, / ⌕ spawn/, "the filter stays shown after Enter");
		assert.doesNotMatch(text, /ralph/);
		h.inspector.handleInput("/");
		h.inspector.handleInput(ESC);
		text = h.text();
		assert.match(text, /ralph/);
		assert.match(text, /review-pr/);
		h.inspector.handleInput("/");
		for (const ch of "zzz") h.inspector.handleInput(ch);
		assert.match(h.text(), /Nothing matches "zzz"\./);
	} finally {
		await h.dispose();
	}
});

test("a source's change repaints /tasks, and its rows render at 80 and 160 columns (#5224)", async () => {
	const items: AgentPanelItem[] = [waitingRun];
	const h = await harness(items);
	try {
		items.push(failedRun);
		h.runs.emit();
		for (const width of [80, 160]) {
			const lines = h.text(width).split("\n");
			assert.ok(
				lines.every((line) => line.length <= width),
				`no line is wider than ${width}`,
			);
			assert.match(lines.join("\n"), /review-pr/);
		}
	} finally {
		await h.dispose();
	}
});

test("a finished run with no current stage reads its progress, the filter box has no prompt mark, and a sent notice clears on the next key (#5224)", async () => {
	const finished: AgentPanelItem = {
		id: "run:done",
		kind: "agent",
		state: "done",
		name: "approve-demo",
		task: "",
		progress: { done: 1, total: 1 },
		elapsedMs: 10_000,
	};
	const h = await harness([waitingRun, finished]);
	try {
		assert.match(h.text(), /✓ approve-demo +1\/1 +done · 10s/);
		assert.doesNotMatch(h.text(), /approve-demo +·/, "no separator before an empty task");
		h.inspector.handleInput(SPACE);
		h.text();
		h.inspector.handleInput("1");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /Sent to ralph/);
		h.inspector.handleInput("/");
		assert.doesNotMatch(h.text(), /Sent to ralph/, "the notice lasts until the next key");
		for (const ch of "demo") h.inspector.handleInput(ch);
		assert.match(h.text(), /^ ⌕ demo/m, "the filter box shows only the typed text");
	} finally {
		await h.dispose();
	}
});

test("/tasks opens on its first row, a waiting run above a working subagent, and the panel's clock and /tasks agree (#5224)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("Spawn lock fix");
		const runs = runSource([waitingRun]);
		const { taskClocksFor } = await import("../../packages/coding-agent/src/core/tasks/live-elapsed.js");
		const taskId = fixture.store.tasks[0]?.ref.taskId ?? "";
		const seenEarlier = taskClocksFor(fixture.store).elapsedMs(taskId, 0, true, Date.now() - 60_000);
		assert.equal(seenEarlier, 0);
		const inspector = new TaskInspector(
			ownerTaskViewSource(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource(runs.source);
		const text = inspector
			.renderViewport(100, 24)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");
		assert.match(text, /❯ ◆ ralph/, "the waiting run, the first row, is selected");
		assert.match(text, /∀ worker +Spawn lock fix +1m$/m, "/tasks counts from when another view first saw the task");
		inspector.dispose();
	} finally {
		await fixture.dispose();
	}
});

test("/tasks formats only visible rows when navigating a large board (#5224)", async () => {
	let taskReads = 0;
	const items: AgentPanelItem[] = Array.from({ length: 1_000 }, (_, index) => ({
		id: `run:${index}`,
		kind: "agent",
		state: "running",
		name: `run-${index}`,
		get task() {
			taskReads++;
			return `stage ${index}`;
		},
	}));
	const h = await harness(items);
	try {
		const viewportRows = 12;
		taskReads = 0;
		assert.match(h.text(100, viewportRows), /❯ ∀ run-0/);
		h.inspector.handleInput("\x1b[F");
		const last = h.text(100, viewportRows);
		assert.match(last, /❯ ∀ run-999/);
		assert.ok(last.split("\n").length <= viewportRows);
		assert.ok(taskReads <= viewportRows * 2, `two paints read ${taskReads} task descriptions`);
	} finally {
		await h.dispose();
	}
});

test("/tasks reads a live board source once per paint, not again for each navigation key (#5224)", async () => {
	const h = await harness([waitingRun, failedRun]);
	let reads = 0;
	let elapsedMs = 180_000;
	h.runs.source.items = () => {
		reads++;
		return [{ ...waitingRun, elapsedMs }, failedRun];
	};
	try {
		h.inspector.handleInput(DOWN);
		assert.match(h.text(), /❯ ✗ review-pr/);
		assert.ok(reads <= 1, `one key and paint read the source ${reads} times`);
		reads = 0;
		elapsedMs = 240_000;
		assert.match(h.text(), /waiting 4m$/m, "a repaint reads the source's live clock without a store event");
		assert.ok(reads <= 1);
	} finally {
		await h.dispose();
	}
});

test("/tasks reuses task snapshots while navigating and follows the next store event (#5224)", async () => {
	const fixture = taskFixture();
	await fixture.start("First snapshot");
	const source = ownerTaskViewSource(fixture.store);
	let reads = 0;
	const inspector = new TaskInspector(
		{
			...source,
			get backgroundTasks() {
				reads++;
				return source.backgroundTasks;
			},
		},
		() => {},
		() => {},
	);
	const text = () => inspector.renderViewport(100, 12).map(stripVTControlCharacters).join("\n");
	try {
		reads = 0;
		for (const key of [DOWN, "\x1b[A", "x"]) {
			inspector.handleInput(key);
			assert.match(text(), /First snapshot/);
		}
		assert.equal(reads, 0, "navigation and paint do not reread unchanged task snapshots");
		await fixture.start("Second snapshot");
		assert.match(text(), /2 working/);
		assert.match(text(), /Second snapshot/);
		await fixture.settle(0);
		assert.match(text(), /1 working · 1 done/);
		assert.match(text(), /First snapshot finished · x to acknowledge/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("/tasks sees a dismissal from another inspector without a task store event (#5224)", async () => {
	const fixture = taskFixture();
	await fixture.start("Shared finished task");
	await fixture.settle();
	const source = ownerTaskViewSource(fixture.store);
	const inspectors = Array.from(
		{ length: 2 },
		() =>
			new TaskInspector(
				source,
				() => {},
				() => {},
			),
	);
	const text = () => inspectors[0]!.renderViewport(100, 12).map(stripVTControlCharacters).join("\n");
	try {
		assert.match(text(), /Shared finished task/);
		inspectors[1]!.renderViewport(100, 12);
		inspectors[1]!.handleInput("x");
		assert.doesNotMatch(text(), /Shared finished task/);
		assert.match(text(), /No background work/);
	} finally {
		for (const inspector of inspectors) inspector.dispose();
		await fixture.dispose();
	}
});

test("/tasks fits a short viewport: the selected row first, then its hint line (#5224)", async () => {
	const h = await harness([waitingRun, failedRun]);
	try {
		for (const rows of [1, 2, 3, 5]) {
			const lines = h.inspector.renderViewport(100, rows).map((line) => stripVTControlCharacters(line));
			assert.equal(lines.length, rows, `exactly ${rows} rows`);
			assert.ok(
				lines.some((line) => /❯ ◆ ralph/.test(line)),
				`the selected row shows at ${rows} rows`,
			);
		}
		assert.match(stripVTControlCharacters(h.inspector.renderViewport(100, 2).at(-1) ?? ""), /space peek/);
	} finally {
		await h.dispose();
	}
});

test("a run's graph opened from /tasks comes back to /tasks on that run (#5224)", async () => {
	const running: AgentPanelItem = {
		id: "run:build",
		kind: "agent",
		state: "running",
		name: "build",
		task: "stage compile",
	};
	const h = await harness([running]);
	try {
		const reopened: string[] = [];
		h.inspector.setReopen((id) => reopened.push(id));
		h.inspector.handleInput(ENTER);
		assert.deepEqual(h.runs.calls.opened, ["run:build"]);
		assert.equal(h.runs.calls.returns.length, 1, "the graph is told where back goes");
		h.runs.calls.returns[0]?.();
		assert.deepEqual(reopened, ["run:build"], "back reopens /tasks on the same row");
	} finally {
		await h.dispose();
	}
});

test("a run that finishes between the two presses of x is not dismissed unseen (#5224)", async () => {
	const run: AgentPanelItem = {
		id: "run:build",
		kind: "agent",
		state: "running",
		name: "build",
		task: "stage compile",
	};
	const items = [run];
	const h = await harness(items);
	try {
		h.inspector.handleInput("x");
		items[0] = { ...run, state: "done" };
		h.runs.emit();
		assert.match(h.text(), /build finished · x to acknowledge/);
		h.inspector.handleInput("x");
		assert.deepEqual(h.runs.calls.dismissed, [], "the press meant for stop only acknowledges");
		assert.deepEqual(h.runs.calls.stopped, []);
		assert.match(h.text(), /✓ build/);
		h.inspector.handleInput("x");
		assert.deepEqual(h.runs.calls.dismissed, ["run:build"], "a later press dismisses");
	} finally {
		await h.dispose();
	}
});

test("a peek card keeps its typed reply when closed, and ← at its start closes it keeping the draft (#5224)", async () => {
	const h = await harness([waitingRun]);
	try {
		h.inspector.handleInput(SPACE);
		h.inspector.renderPicker(100, 30);
		for (const ch of "go") h.inspector.handleInput(ch);
		h.inspector.handleInput(ESC);
		assert.doesNotMatch(h.text(), /╭─ ralph/);
		h.inspector.handleInput(SPACE);
		assert.match(h.text(), /│ ❯ go/, "Space brings the draft back");
		h.inspector.handleInput("\x1b[H");
		h.inspector.handleInput("\x1b[D");
		assert.doesNotMatch(h.text(), /╭─ ralph/, "← at the start closes the card");
		h.inspector.handleInput(SPACE);
		assert.match(h.text(), /│ ❯ go/);
		assert.equal(h.closed(), 0);
	} finally {
		await h.dispose();
	}
});

test("Enter while a reply is being sent sends it once and never reaches the list (#5224)", async () => {
	const h = await harness([waitingRun]);
	let release!: () => void;
	h.runs.source.answer = async (id, text) => {
		h.runs.calls.answered.push([id, text]);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		return { ok: true };
	};
	try {
		h.inspector.handleInput(SPACE);
		h.text();
		h.inspector.handleInput("1");
		h.inspector.handleInput(ENTER);
		h.inspector.handleInput(ENTER);
		assert.match(h.text(), /Sending…/, "the card says it is sending");
		release();
		await flush();
		assert.doesNotMatch(h.text(), /╭─ ralph/, "the card closes once sent");
		assert.deepEqual(h.runs.calls.answered, [["run:ralph", "Yes"]], "one answer");
		assert.deepEqual(h.runs.calls.opened, [], "no Enter reached the list and opened the graph");
		assert.equal(h.closed(), 0);
	} finally {
		await h.dispose();
	}
});

test("an Enter just after a reply is sent is swallowed, so a double Enter never opens the run (#5224)", async () => {
	const h = await harness([waitingRun]);
	try {
		h.inspector.handleInput(SPACE);
		h.text();
		h.inspector.handleInput("1");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.doesNotMatch(h.text(), /╭─ ralph/, "the answer was sent and the card closed");
		h.inspector.handleInput(ENTER);
		assert.deepEqual(h.runs.calls.opened, [], "the second Enter of a double press is swallowed");
		assert.equal(h.closed(), 0);
		await new Promise<void>((resolve) => setTimeout(resolve, REPLY_ENTER_GUARD_MS + 50));
		h.inspector.handleInput(ENTER);
		assert.deepEqual(h.runs.calls.opened, ["run:ralph"], "a later Enter opens it");
	} finally {
		await h.dispose();
	}
});
