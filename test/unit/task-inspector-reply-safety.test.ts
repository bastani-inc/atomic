import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type {
	AgentPanelAnswerOptions,
	AgentPanelItem,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import type { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { dismissedTasks } from "../../packages/coding-agent/src/modes/interactive/components/task-dismissal.js";
import {
	type TaskBoardSource,
	TaskInspector,
} from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { coercePrimitivePromptAnswer } from "../../packages/workflows/src/shared/prompt-answer.js";
import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const BACKSPACE = "\x7f";
const WHEEL_DOWN = "\x1b[<65;10;10M";
const WHEEL_UP = "\x1b[<64;10;10M";

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

function viewOf(store: OwnerTaskStore, sendTaskMessage?: (id: string, text: string) => Promise<void>): TaskViewSource {
	const base = ownerTaskViewSource(store);
	if (sendTaskMessage === undefined) return base;
	return Object.assign(Object.create(base) as TaskViewSource, { sendTaskMessage });
}

function waitingItem(id: string, promptId: string, question: string, choices?: readonly string[]): AgentPanelItem {
	return {
		id,
		kind: "workflow",
		state: "input",
		name: id.replace(/^run:/, ""),
		task: question,
		question,
		promptId,
		...(choices === undefined ? {} : { choices }),
		elapsedMs: 1_000,
	};
}

test("a peek-card reply is cleared when its question changes, and only a reply typed for the new question reaches it (#5224)", async () => {
	for (const mode of ["enter-retry", "esc-space-retry"] as const) {
		const fixture = taskFixture();
		let current: AgentPanelItem = waitingItem("run:deploy", "p1", "Release name?");
		const listeners = new Set<() => void>();
		const answered: Array<{ id: string; text: string; promptId?: string }> = [];
		const rejected: Array<{ id: string; text: string; promptId?: string }> = [];
		const source: TaskBoardSource = {
			items: () => [current],
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			answer: async (id, text, options?: AgentPanelAnswerOptions) => {
				if (current.state !== "input" || options?.promptId !== current.promptId) {
					rejected.push({ id, text, promptId: options?.promptId });
					return { ok: false, reason: "The pending prompt changed before the answer was sent." };
				}
				answered.push({ id, text, promptId: options?.promptId });
				current = { ...current, state: "running", question: undefined, promptId: undefined };
				for (const listener of listeners) listener();
				return { ok: true };
			},
		};
		const inspector = new TaskInspector(
			viewOf(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource(source);
		const paint = () => plain(inspector.renderPicker(120, 24));
		try {
			paint();
			inspector.handleInput(SPACE);
			assert.match(paint(), /│ Release name\?/);
			for (const ch of "v2") inspector.handleInput(ch);

			current = waitingItem("run:deploy", "p2", "Release notes?");
			for (const listener of listeners) listener();
			const changedFrame = paint();
			assert.match(changedFrame, /│ Release notes\?/);
			assert.doesNotMatch(changedFrame, /❯ v2/);
			assert.match(changedFrame, /The question changed; your reply was cleared\./);

			inspector.handleInput(ENTER);
			await flush();
			assert.deepEqual(rejected, []);
			assert.deepEqual(answered, []);

			if (mode === "esc-space-retry") {
				inspector.handleInput(ESC);
				paint();
				inspector.handleInput(SPACE);
				assert.doesNotMatch(paint(), /❯ v2/);
			}
			for (const ch of "notes") inspector.handleInput(ch);
			inspector.handleInput(ENTER);
			await flush();
			assert.deepEqual(answered, [{ id: "run:deploy", text: "notes", promptId: "p2" }]);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}
});

test("peek-card digit shortcuts resolve exact raw choices when display labels sanitize or collide, and clear on edit (#5224)", async () => {
	const variants = [
		{ choices: ["Use  two spaces", "Other"], pick: 1, expected: "Use  two spaces" },
		{ choices: [`${"a".repeat(299)}Z`, "short"], pick: 1, expected: `${"a".repeat(299)}Z` },
		{ choices: ["👩‍💻 developer", "🧑 person"], pick: 1, expected: "👩‍💻 developer" },
		{ choices: ["⚠️ Abort", "✅ Continue"], pick: 1, expected: "⚠️ Abort" },
		{ choices: ["col\tA", "col B"], pick: 1, expected: "col\tA" },
		{ choices: ["Keep  data", "Keep data"], pick: 1, expected: "Keep  data" },
		{ choices: ["2", "1"], pick: 1, expected: "2" },
	];
	for (const variant of variants) {
		const fixture = taskFixture();
		const item = waitingItem("run:gate", "p1", "Which option?", variant.choices);
		const resolved: unknown[] = [];
		const source: TaskBoardSource = {
			items: () => [item],
			subscribe: () => () => {},
			answer: async (_id, text) => {
				const coerced = coercePrimitivePromptAnswer({ kind: "select", choices: variant.choices } as never, text);
				if (!coerced.ok) return { ok: false, reason: "Invalid select answer" };
				resolved.push(coerced.value);
				return { ok: true };
			},
		};
		const inspector = new TaskInspector(
			viewOf(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource(source);
		try {
			inspector.renderPicker(120, 24);
			inspector.handleInput(SPACE);
			inspector.renderPicker(120, 24);
			inspector.handleInput(String(variant.pick));
			inspector.renderPicker(120, 24);
			inspector.handleInput(ENTER);
			await flush();
			assert.deepEqual(resolved, [variant.expected]);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}
});

test("a digit carries its exact choice index, and a reply refused for a changed prompt is cleared rather than retargeted (#5224)", async () => {
	const fixture = taskFixture();
	let current = waitingItem("run:choice", "p1", "Choose the action", ["Keep", "Drop"]);
	let changed = () => {};
	const calls: { text: string; promptId: string | undefined; choiceIndex: number | undefined }[] = [];
	const inspector = new TaskInspector(
		viewOf(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => [current],
		subscribe(listener) {
			changed = listener;
			return () => {};
		},
		answer: async (_id, text, options) => {
			calls.push({ text, promptId: options?.promptId, choiceIndex: options?.choiceIndex });
			return options?.promptId === current.promptId
				? { ok: true }
				: { ok: false, reason: "The pending prompt changed before the answer was sent." };
		},
	});
	const paint = () => plain(inspector.renderViewport(120, 24));
	try {
		paint();
		inspector.handleInput(SPACE);
		paint();
		inspector.handleInput("1");
		current = waitingItem("run:choice", "p2", "Choose the new action", ["Drop", "Keep"]);
		changed();
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(calls, [{ text: "Keep", promptId: "p1", choiceIndex: 0 }]);
		assert.doesNotMatch(paint(), /❯ Keep/);
		inspector.handleInput(ENTER);
		await flush();
		assert.equal(calls.length, 1, "the refused reply is not sent again to the new prompt");
		inspector.handleInput("2");
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(calls[1], { text: "Keep", promptId: "p2", choiceIndex: 1 });
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("peek card draws up to 9 choices in a tall viewport and accepts digits 8 and 9 (#5224)", async () => {
	const fixture = taskFixture();
	const choices = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"];
	const item = waitingItem("run:nine", "p1", "Pick one:", choices);
	const resolved: unknown[] = [];
	const source: TaskBoardSource = {
		items: () => [item],
		subscribe: () => () => {},
		answer: async (_id, text) => {
			const coerced = coercePrimitivePromptAnswer({ kind: "select", choices } as never, text);
			if (!coerced.ok) return { ok: false, reason: "Invalid choice" };
			resolved.push(coerced.value);
			return { ok: true };
		},
	};
	const inspector = new TaskInspector(
		viewOf(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource(source);
	try {
		inspector.renderViewport(100, 24);
		inspector.handleInput(SPACE);
		const frame = plain(inspector.renderViewport(100, 24));
		assert.match(frame, /│ 8 theta\b/);
		assert.match(frame, /│ 9 iota\b/);
		assert.match(frame, /1-9 choose/);
		inspector.handleInput("8");
		assert.match(plain(inspector.renderViewport(100, 24)), /│ ❯ theta\b/);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(resolved, ["theta"]);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("typeahead and 2-row short viewports cannot bind or answer a question or choice that was never drawn (#5224)", async () => {
	const fixture = taskFixture();
	const rows = Array.from({ length: 12 }, (_, index) =>
		waitingItem(`run:w${String(index).padStart(2, "0")}`, `p${index}`, `Question number ${index}?`, [
			"Alpha",
			"Beta",
		]),
	);
	const answered: Array<[string, string, string | undefined]> = [];
	const inspector = new TaskInspector(
		viewOf(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => rows,
		subscribe: () => () => {},
		answer: async (id, text, options) => {
			answered.push([id, text, options?.promptId]);
			return { ok: true };
		},
	});
	try {
		const first = plain(inspector.renderPicker(100, 10));
		assert.doesNotMatch(first, /Question number 11\?/);
		for (let i = 0; i < rows.length - 1; i++) inspector.handleInput(DOWN);
		for (const ch of " yes") inspector.handleInput(ch);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(answered, []);

		const shortFrame = plain(inspector.renderPicker(100, 2));
		assert.match(shortFrame, /Question number 11\?/);
		assert.doesNotMatch(shortFrame, /1-2 choose/);
		inspector.handleInput("1");
		for (const ch of "yes") inspector.handleInput(ch);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(answered, [["run:w11", "1yes", "p11"]]);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}

	{
		const fixture = taskFixture();
		let current: AgentPanelItem = waitingItem("run:deploy", "p1", "Release name?", ["Use v1", "Use v2", "Skip"]);
		const listeners = new Set<() => void>();
		const seenAnswers: Array<[string, string | undefined, string | undefined]> = [];
		const inspector = new TaskInspector(
			viewOf(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource({
			items: () => [current],
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			answer: async (_id, text, options) => {
				if (current.state !== "input" || options?.promptId !== current.promptId) {
					return { ok: false, reason: "The pending prompt changed before the answer was sent." };
				}
				seenAnswers.push([text, options?.promptId, current.question]);
				return { ok: true };
			},
		});
		try {
			const frame = () => plain(inspector.renderViewport(80, 3));
			frame();
			inspector.handleInput(SPACE);
			frame();
			current = waitingItem("run:deploy", "p2", "Delete the production database?", ["Use v1", "Use v2", "Skip"]);
			for (const listener of listeners) listener();
			for (const ch of "yes") inspector.handleInput(ch);
			inspector.handleInput(ENTER);
			await flush();
			assert.deepEqual(seenAnswers, []);
			const afterChange = frame();
			assert.match(afterChange, /Delete the production database\?/);
			assert.doesNotMatch(afterChange, /1-3 choose/);
			assert.match(plain(inspector.renderViewport(80, 24)), /The question changed; your reply was cleared\./);
			inspector.handleInput(ENTER);
			await flush();
			inspector.handleInput(ENTER);
			await flush();
			assert.deepEqual(seenAnswers, [], "a reply typed before the question changed never reaches the new one");
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}
});

test("confirming x with peek open, single x after unseen finish, and confirming x after armed row vanishes stay safe (#5224)", async () => {
	{
		const fixture = taskFixture();
		let item: AgentPanelItem = {
			id: "run:ralph",
			kind: "workflow",
			state: "running",
			name: "ralph",
			task: "stage build",
			elapsedMs: 1_000,
		};
		const listeners = new Set<() => void>();
		const stopped: string[] = [];
		const dismissed: string[] = [];
		const inspector = new TaskInspector(
			viewOf(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource({
			items: () => [item],
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			stop: async (id) => {
				stopped.push(id);
				return { ok: true };
			},
			dismiss: (id) => dismissed.push(id),
		});
		try {
			inspector.renderViewport(100, 24);
			inspector.handleInput(SPACE);
			inspector.renderViewport(100, 24);
			inspector.handleInput("x");
			inspector.renderViewport(100, 24);
			item = { ...item, state: "done", endedAt: Date.now() };
			for (const listener of listeners) listener();
			inspector.handleInput("x");
			await flush();
			assert.deepEqual(stopped, []);
			assert.deepEqual(dismissed, []);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}

	{
		const fixture = taskFixture();
		await fixture.start("Native job");
		const nativeId = fixture.store.tasks[0]!.ref.taskId;
		let item: AgentPanelItem = {
			id: "run:build",
			kind: "workflow",
			state: "running",
			name: "build",
			task: "stage build",
			elapsedMs: 1_000,
		};
		const listeners = new Set<() => void>();
		const dismissed: string[] = [];
		const source = viewOf(fixture.store);
		const inspector = new TaskInspector(
			source,
			() => {},
			() => {},
		);
		inspector.setBoardSource({
			items: () => [item],
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dismiss: (id) => dismissed.push(id),
		});
		try {
			assert.match(plain(inspector.renderViewport(100, 24)), /x stop/);
			await fixture.settle(0);
			inspector.handleInput("x");
			assert.equal(dismissedTasks(source).has(nativeId), false);

			inspector.renderViewport(100, 24);
			if (inspector.navigation.selectedId !== "run:build") inspector.handleInput(UP);
			assert.equal(inspector.navigation.selectedId, "run:build");
			inspector.renderViewport(100, 24);
			item = { ...item, state: "done", endedAt: Date.now() };
			for (const listener of listeners) listener();
			inspector.handleInput("x");
			assert.deepEqual(dismissed, []);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}

	{
		const fixture = taskFixture();
		let items: AgentPanelItem[] = [
			{ id: "run:a", kind: "workflow", state: "running", name: "a", task: "stage a", elapsedMs: 1_000 },
			{ id: "run:b", kind: "workflow", state: "done", name: "b", task: "stage b", elapsedMs: 1_000, endedAt: 1_000 },
		];
		const listeners = new Set<() => void>();
		const dismissed: string[] = [];
		const inspector = new TaskInspector(
			viewOf(fixture.store),
			() => {},
			() => {},
		);
		inspector.setBoardSource({
			items: () => items,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dismiss: (id) => dismissed.push(id),
		});
		try {
			inspector.renderViewport(100, 24);
			inspector.handleInput("x");
			assert.match(plain(inspector.renderViewport(100, 24)), /Press x again within 3s to stop a/);
			items = [items[1]!];
			for (const listener of listeners) listener();
			inspector.handleInput("x");
			assert.deepEqual(dismissed, []);
		} finally {
			inspector.dispose();
			await fixture.dispose();
		}
	}
});

test("mouse-wheel selection changes preserve peek-card drafts and never leave a restored draft without a target (#5224)", async () => {
	const fixture = taskFixture();
	const items: AgentPanelItem[] = [
		waitingItem("run:alpha", "p0", "Question for alpha?"),
		waitingItem("run:beta", "p1", "Question for beta?"),
	];
	const answers: Array<{ id: string; text: string; options?: AgentPanelAnswerOptions }> = [];
	const inspector = new TaskInspector(
		viewOf(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => items,
		subscribe: () => () => {},
		answer: async (id, text, options) => {
			answers.push({ id, text, options });
			return { ok: true };
		},
	});
	const paint = () => plain(inspector.renderPicker(100, 30));
	try {
		paint();
		inspector.handleInput(SPACE);
		paint();
		for (const ch of "hello") inspector.handleInput(ch);
		assert.match(paint(), /❯ hello/);
		inspector.handleInput(WHEEL_DOWN);
		paint();
		inspector.handleInput(SPACE);
		paint();
		inspector.handleInput(ESC);
		paint();
		inspector.handleInput(WHEEL_UP);
		paint();
		inspector.handleInput(SPACE);
		const reopened = paint();
		assert.match(reopened, /Question for alpha\?/);
		assert.match(reopened, /❯ hello/);

		for (let i = 0; i < 5; i++) inspector.handleInput(BACKSPACE);
		paint();
		inspector.handleInput(WHEEL_DOWN);
		paint();
		inspector.handleInput(SPACE);
		paint();
		inspector.handleInput(ESC);
		paint();
		inspector.handleInput(UP);
		paint();
		inspector.handleInput(SPACE);
		paint();
		for (const ch of "ship") inspector.handleInput(ch);
		assert.match(paint(), /❯ ship/);
		inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(answers, [
			{ id: "run:alpha", text: "ship", options: { promptId: "p0", question: "Question for alpha?" } },
		]);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("/tasks renders single-line rows, updated close hint, and compact Space peek card with steer reply on native tasks (#5224)", async () => {
	const fixture = taskFixture();
	await fixture.start("#5220 spawn lock");
	taskValue(
		fixture.runners[0]!.context.reportActivity({
			reportId: "m1",
			change: { kind: "model", model: "openai-codex/gpt-6-astra", thinking: "medium" },
		}),
	);
	taskValue(
		fixture.runners[0]!.context.reportActivity({
			reportId: "a1",
			change: { kind: "action", tool: "bash", text: "git status" },
		}),
	);
	fixture.store.drain();

	const steered: Array<[string, string]> = [];
	const inspector = new TaskInspector(
		viewOf(fixture.store, async (id, text) => {
			steered.push([id, text]);
		}),
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => [waitingItem("run:ralph", "p1", "approve the plan?", ["Yes", "No, revise", "Stop the run"])],
		subscribe: () => () => {},
		answer: async () => ({ ok: true }),
	});
	try {
		inspector.handleInput(DOWN);
		for (const width of [80, 160]) {
			const lines = inspector.renderViewport(width, 24).map((line) => stripVTControlCharacters(line).trimEnd());
			const expectedHint = "↑↓ select · space peek · enter/→ open · x stop · / filter · esc/← close · ? keys";
			assert.equal(lines.at(-1)?.trim(), expectedHint);
			const selectedIdx = lines.findIndex((line) => line.startsWith(" ❯ "));
			assert.ok(selectedIdx > 0);
			assert.doesNotMatch(lines[selectedIdx + 1] ?? "", /gpt-6-astra|git status/);
		}

		inspector.handleInput(SPACE);
		const peeked = plain(inspector.renderViewport(120, 24));
		assert.match(peeked, /╭─ worker ─/);
		assert.match(peeked, /gpt-6-astra.*Bash\(git status\)/);
		assert.match(peeked, /│ ❯/);
		assert.equal(peeked.split("\n").at(-1)?.trim(), "↑↓ select · enter/→ open · esc/← close");

		for (const ch of "check lockfile") inspector.handleInput(ch);
		inspector.handleInput(ENTER);
		await flush();
		assert.equal(steered.length, 1);
		assert.equal(steered[0]?.[1], "check lockfile");
		const afterSend = plain(inspector.renderViewport(120, 24));
		assert.doesNotMatch(afterSend, /╭─ worker ─/);
		assert.match(afterSend, /Sent to worker/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("a shell peek names its command and status instead of showing an isolated elapsed time (#5224)", async () => {
	const fixture = taskFixture();
	const task = taskRecord("shell-peek", "command");
	task.title = "sleep 600";
	task.metrics = { elapsedMs: 18_000 };
	const inspector = new TaskInspector(
		{ ...viewOf(fixture.store), tasks: [task], backgroundTasks: [task] },
		() => {},
		() => {},
	);
	try {
		inspector.renderViewport(100, 24);
		inspector.handleInput(SPACE);
		const frame = plain(inspector.renderViewport(100, 24));
		assert.match(frame, /╭─ shell ─[\s\S]*│ sleep 600/);
		assert.match(frame, /│ Running · 18s/);
		assert.equal(inspector.fullscreen, false);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("inline reply hints follow selection, editable digits and the sending lock (#5224)", async () => {
	const fixture = taskFixture();
	let finish = () => {};
	const held = new Promise<{ ok: false; reason: string }>((resolve) => {
		finish = () => resolve({ ok: false, reason: "offline" });
	});
	const inspector = new TaskInspector(
		viewOf(fixture.store),
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => [waitingItem("run:keys", "p", "Continue?", ["Yes", "No"])],
		subscribe: () => () => {},
		answer: () => held,
	});
	const paint = () => plain(inspector.renderViewport(120, 24));
	const hint = () => paint().split("\n").at(-1)?.trim();
	try {
		paint();
		inspector.handleInput(SPACE);
		assert.equal(hint(), "↑↓ select · 1-2 choose · enter send · esc/← close");
		inspector.handleInput("1");
		assert.equal(hint(), "↑↓ select · enter send · esc close");
		inspector.handleInput("2");
		assert.match(paint(), /❯ Yes2/);
		inspector.handleInput(ENTER);
		assert.match(paint(), /Sending…/);
		assert.equal(hint(), "esc/← close");
		inspector.handleInput(DOWN);
		inspector.handleInput("x");
		assert.match(paint(), /Sending…/);
		finish();
		await flush();
		assert.equal(hint(), "↑↓ select · enter send · esc close");
	} finally {
		finish();
		await flush();
		inspector.dispose();
		await fixture.dispose();
	}
});

test("an empty native message card advertises its open action and filter arrows stay live (#5224)", async () => {
	const fixture = taskFixture();
	await fixture.start("Review cleanup");
	const inspector = new TaskInspector(
		viewOf(fixture.store),
		() => {},
		() => {},
	);
	const paint = () => plain(inspector.renderViewport(120, 24));
	try {
		paint();
		inspector.handleInput(SPACE);
		assert.equal(paint().split("\n").at(-1)?.trim(), "↑↓ select · enter/→ open · esc/← close");
		inspector.handleInput("\x1b[C");
		assert.equal(inspector.fullscreen, true);
		inspector.handleInput(ESC);
		paint();
		inspector.handleInput("/");
		assert.equal(paint().split("\n").at(-1)?.trim(), "↑↓ select · type filter · enter done · esc clear");
		inspector.handleInput(DOWN);
		assert.doesNotMatch(paint(), /⌕/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("metrics-only store updates reuse sorted sections and key-to-paint reads boardSource.items at most once (#5224)", async () => {
	const fixture = taskFixture();
	await fixture.start("Task alpha");
	await fixture.start("Task beta");
	let itemReads = 0;
	let backgroundReads = 0;
	const base = viewOf(fixture.store);
	const source = Object.create(base) as TaskViewSource;
	Object.defineProperty(source, "backgroundTasks", {
		get() {
			backgroundReads++;
			return base.backgroundTasks;
		},
	});
	const listeners = new Set<() => void>();
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	inspector.setBoardSource({
		items: () => {
			itemReads++;
			return [
				{ id: "run:one", kind: "workflow", state: "running", name: "one", task: "stage 1", elapsedMs: 1_000 },
				{ id: "run:two", kind: "workflow", state: "running", name: "two", task: "stage 2", elapsedMs: 2_000 },
			];
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	try {
		inspector.renderPicker(100, 12);
		backgroundReads = 0;

		taskValue(
			fixture.runners[0]!.context.reportActivity({
				reportId: "act-1",
				change: { kind: "action", tool: "read", text: "README.md" },
			}),
		);
		fixture.store.drain();

		itemReads = 0;
		inspector.handleInput(DOWN);
		inspector.renderPicker(100, 12);
		assert.equal(itemReads, 1, "key + paint after a store update reads boardSource.items once, not twice");
		assert.equal(
			backgroundReads,
			0,
			"an activity-only event updates records by id without rebuilding sorted sections",
		);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});
