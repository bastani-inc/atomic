import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { transcriptOnlySource } from "../helpers/task-transcript-environment.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";

// RFC #2884: real owner tasks remain inspectable and cancellation needs target confirmation.
test("inspector keeps selected live task reachable in a short viewport and confirms cancellation", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	let closed = false;
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {
			closed = true;
		},
	);
	try {
		assert.match(inspector.render(48).join("\n"), /No background work/);
		await fixture.start("first");
		await fixture.start("second");
		inspector.handleInput("\x1b[A");
		inspector.handleInput("\r");
		inspector.handleInput("\x1b[B");
		inspector.handleInput("\x1b[B");
		assert.match(stripVTControlCharacters(inspector.renderViewport(48, 4).join("\n")), /› Cancel task/);
		assert.match(
			stripVTControlCharacters(inspector.renderViewport(48, 4).join("\n")),
			/esc\/← back to list · \? keys$/,
		);
		// Cancelling asks for a second press within three seconds instead of a y/n page (#5224).
		inspector.handleInput("\r");
		assert.match(stripVTControlCharacters(inspector.render(80).join("\n")), /Press x again within 3s to stop/);
		assert.equal(fixture.store.tasks[1].execution.kind, "running");
		inspector.handleInput("\x1b");
		inspector.handleInput("\x1b");
		assert.equal(closed, true);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("narrow inspector keeps the selected input-needed task visible", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		for (let i = 0; i < 8; i++) await fixture.start(`task-${i}`);
		fixture.runners[7].context.reportActivity({
			reportId: "question",
			change: {
				kind: "attention-set",
				attention: {
					kind: "input-needed",
					requestId: "q",
					prompt: "Continue?",
					route: { sessionId: "fixture", promptId: "q" },
				},
			},
		});
		fixture.store.drain();
		inspector.open(fixture.store.tasks[7].ref.taskId);
		for (const width of [20, 21, 48]) {
			const text = stripVTControlCharacters(inspector.renderViewport(width, 8).join("\n"));
			assert.match(text, /∀ ◆ .*Cont/);
			assert.doesNotMatch(text, /task-0/);
		}
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("inspector lists running tasks first and keeps selection when a task settles and moves (#3252)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	const order = () =>
		stripVTControlCharacters(inspector.render(80).join("\n"))
			.split("\n")
			.flatMap((line) => line.match(/task-\d/)?.[0] ?? []);
	try {
		for (let i = 0; i < 3; i++) await fixture.start(`task-${i}`);
		assert.deepEqual(order(), ["task-2", "task-1", "task-0"]);
		inspector.open(fixture.store.tasks[2].ref.taskId);
		await fixture.settle(2);
		await fixture.settle(0);
		assert.deepEqual(
			[...fixture.store.settlementOrder.keys()],
			[fixture.store.tasks[2].ref.taskId, fixture.store.tasks[0].ref.taskId],
		);
		assert.deepEqual(order(), ["task-1", "task-0", "task-2"]);
		assert.equal(inspector.navigation.selectedTaskId, fixture.store.tasks[2].ref.taskId);
		inspector.handleInput("\x1b[A");
		assert.equal(inspector.navigation.selectedTaskId, fixture.store.tasks[0].ref.taskId);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("inspector orders tasks settled within one drain by settlement, not launch (#3252)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	const order = () =>
		stripVTControlCharacters(inspector.render(80).join("\n"))
			.split("\n")
			.flatMap((line) => line.match(/task-\d/)?.[0] ?? []);
	try {
		for (let i = 0; i < 3; i++) await fixture.start(`task-${i}`);
		for (const index of [2, 0])
			fixture.runners[index].result.resolve({ kind: "completed", output: fixture.store.tasks[index].output });
		await new Promise<void>((resolve) => setImmediate(resolve));
		fixture.store.drain();
		assert.deepEqual(order(), ["task-1", "task-0", "task-2"]);
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("peek card and detail page show 3m and 1h 6m beside board rows instead of 3m 12s or 66m 40s (#5239)", () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const threeMin = {
		...taskRecord("three-min", "command"),
		title: "build-step",
		execution: {
			kind: "settled" as const,
			result: { kind: "completed" as const, output: taskRecord("x").output, exitCode: 0 },
		},
		metrics: { elapsedMs: 192_000 },
	};
	const hourSix = {
		...taskRecord("hour-six", "agent"),
		agentName: "worker",
		title: "long-audit",
		execution: { kind: "settled" as const, result: { kind: "completed" as const, output: taskRecord("y").output } },
		metrics: { elapsedMs: 4_000_000 },
	};
	const source = transcriptOnlySource({
		tasks: [threeMin, hourSix],
		backgroundTasks: [threeMin, hourSix],
		recentActivity: () => [],
		activityOmitted: () => false,
		stdinAvailable: () => false,
		taskDetailText: () => ({}),
		readTaskOutput: async () => ({ ok: true, value: { text: "", omitted: false } }),
	});
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	try {
		inspector.open(hourSix.ref.taskId);
		inspector.handleInput(" ");
		const hourPeek = stripVTControlCharacters(inspector.renderViewport(100, 16).join("\n"));
		assert.match(hourPeek, /\b1h 6m\b/);
		assert.doesNotMatch(hourPeek, /66m 40s/);
		inspector.handleInput(" ");

		inspector.open(threeMin.ref.taskId);
		inspector.handleInput(" ");
		const threeMinPeek = stripVTControlCharacters(inspector.renderViewport(100, 16).join("\n"));
		assert.match(threeMinPeek, /\b3m\b/);
		assert.doesNotMatch(threeMinPeek, /3m 12s/);
		inspector.handleInput("\r");
		const detailText = stripVTControlCharacters(inspector.renderViewport(100, 16).join("\n"));
		assert.match(detailText, /\b3m\b/);
		assert.doesNotMatch(detailText, /3m 12s/);
	} finally {
		inspector.dispose();
		setKeybindings(previous);
	}
});

test("shell input sheet keeps its task title when the task leaves the list while open (#5239)", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager({ "app.tasks.input": "i" }));
	const shellTask = {
		...taskRecord("shell-target", "command"),
		title: "deploy-watcher",
		metrics: { elapsedMs: 192_000 },
	};
	const otherShell = {
		...taskRecord("shell-other", "command"),
		title: "other-job",
	};
	let currentTasks = [shellTask, otherShell];
	const listeners = new Set<() => void>();
	const writtenTargets: Array<{ id: string; value: string }> = [];
	const base = transcriptOnlySource({
		tasks: currentTasks,
		backgroundTasks: currentTasks,
		recentActivity: () => [],
		activityOmitted: () => false,
		stdinAvailable: (id) => id === shellTask.ref.taskId,
		writeTaskInput: async (id, value) => {
			writtenTargets.push({ id, value });
			return { ok: true, value: { acceptedBytes: value.length } };
		},
	});
	const source = Object.defineProperties(
		{
			...base,
			subscribe(listener: () => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		{
			tasks: { get: () => currentTasks },
			backgroundTasks: { get: () => currentTasks },
		},
	);
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	try {
		inspector.open(shellTask.ref.taskId);
		inspector.handleInput("i");
		assert.equal(inspector.navigation.focus.kind, "stdin");
		const before = stripVTControlCharacters(inspector.renderViewport(80, 10).join("\n"));
		assert.match(before, /Input to deploy-watcher/);

		currentTasks = [otherShell];
		for (const listener of listeners) listener();
		const withSurvivor = stripVTControlCharacters(inspector.renderViewport(80, 10).join("\n"));
		assert.match(withSurvivor, /Input to deploy-watcher/);
		assert.doesNotMatch(withSurvivor, /Input to other-job/);
		for (const ch of "ping") inspector.handleInput(ch);
		inspector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(writtenTargets, [{ id: shellTask.ref.taskId, value: "ping" }]);

		currentTasks = [];
		for (const listener of listeners) listener();
		const whenEmpty = stripVTControlCharacters(inspector.renderViewport(80, 10).join("\n"));
		assert.match(whenEmpty, /Input to deploy-watcher/);
		assert.doesNotMatch(whenEmpty, /Input to\s*$/m);
	} finally {
		inspector.dispose();
		setKeybindings(previous);
	}
});
