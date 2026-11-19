import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { taskPanelItems } from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import { taskClockOf, taskClocksFor } from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type { ChatBoxSession } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	launchedTaskViewSource,
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	AGENT_PANEL_IDLE_ROWS,
	AgentPanelModel,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

import { taskFixture, taskValue } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

const text = (inspector: TaskInspector) => stripVTControlCharacters(inspector.renderViewport(100, 24).join("\n"));

test("stopping a task keeps the elapsed clock monotone across the panel and task picker (#5224)", async () => {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	let now = 100_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture(undefined, { settleOnAbort: false });
	const source = ownerTaskViewSource(fixture.store);
	const model = new AgentPanelModel(() => now);
	let rows = model.rows(taskPanelItems(source, new Set()));
	const unsubscribe = fixture.store.subscribe(() => {
		rows = model.rows(taskPanelItems(source, new Set()));
	});
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	try {
		const task = await fixture.start("A long task");
		// Another subagent keeps running, so the stopped one stays listed in the panel.
		await fixture.start("Still running");
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "metrics",
				change: { kind: "metrics", elapsedMs: 2000 },
			}),
		);
		fixture.store.drain();
		now += 60_000;
		assert.match(text(inspector), /A long task +1m\b/);
		taskValue(await fixture.supervisor.cancelTask(task, "user"));
		fixture.store.drain();
		assert.equal(fixture.store.tasks[0].execution.kind, "cancelling");
		text(inspector);
		rows = model.rows(taskPanelItems(source, new Set()));
		fixture.runners[0].result.resolve({ kind: "cancelled", cause: "user" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		fixture.store.drain();
		assert.match(text(inspector), /stopped · 1m\b/);
		const stopped = rows.find((row) => row.id === `task:${fixture.store.tasks[0]!.ref.taskId}`);
		assert.ok((stopped?.elapsedMs ?? 0) >= 60_000, `panel elapsed ${stopped?.elapsedMs}`);
	} finally {
		inspector.dispose();
		unsubscribe();
		await fixture.dispose();
		clock.mockRestore();
		setKeybindings(keys);
	}
});

test("a task that settles while the picker is closed does not include the observation gap (#5224)", async () => {
	initTheme("dark");
	let now = 200_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	let inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Completes out of view");
		text(inspector);
		inspector.dispose();
		now += 6000;
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "final-metrics",
				change: { kind: "metrics", elapsedMs: 6000 },
			}),
		);
		fixture.store.drain();
		await fixture.settle();
		now += 600_000;
		inspector = new TaskInspector(
			fixture.store,
			() => {},
			() => {},
		);
		assert.match(text(inspector), /done · 6s/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		clock.mockRestore();
	}
});

test("a settled remote task uses its final report rather than the next observation time (#5224)", async () => {
	const { liveElapsedMs } = await import("../../packages/coding-agent/src/core/tasks/live-elapsed.js");
	const id = "late-remote-clock";
	assert.equal(liveElapsedMs(id, 1000, true, 10_000), 1000);
	assert.equal(liveElapsedMs(id, 1000, true, 13_000), 4000);
	assert.equal(liveElapsedMs(id, 6000, false, 610_000), 6000);
});

test("a second task store settling first does not reset the session store's clock (#5224)", async () => {
	initTheme("dark");
	let now = 400_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	const herdrStore = new OwnerTaskStore(fixture.supervisor, fixture.owner);
	taskValue(herdrStore.connect());
	const source = ownerTaskViewSource(fixture.store);
	const model = new AgentPanelModel(() => now);
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Observed by two stores");
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "metrics",
				change: { kind: "metrics", elapsedMs: 2000 },
			}),
		);
		fixture.store.drain();
		herdrStore.drain();
		now += 60_000;
		assert.ok((model.rows(taskPanelItems(source, new Set()))[0]?.elapsedMs ?? 0) >= 60_000);
		fixture.runners[0].result.resolve({ kind: "completed", output: fixture.store.tasks[0]!.output });
		await new Promise<void>((resolve) => setImmediate(resolve));
		herdrStore.drain();
		const whileStale = model.rows(taskPanelItems(source, new Set()))[0]?.elapsedMs ?? 0;
		assert.ok(whileStale >= 60_000, `stale read before session store drain: ${whileStale}`);
		fixture.store.drain();
		// A finished subagent leaves the panel; the clock the panel and /tasks share keeps the time it reached.
		assert.deepEqual(model.rows(taskPanelItems(source, new Set())), []);
		const task = fixture.store.tasks[0]!;
		const settled = taskClocksFor(source).elapsedMs(task.ref.taskId, task.metrics?.elapsedMs, false, now);
		assert.ok((settled ?? 0) >= 60_000, `settled elapsed: ${settled}`);
		assert.match(text(inspector), /done · 1m\b/);
	} finally {
		inspector.dispose();
		herdrStore.dispose();
		await fixture.dispose();
		clock.mockRestore();
	}
});

test("a paused extension agent or shell row keeps its running clock on resume (#5224)", () => {
	let now = 500_000;
	const model = new AgentPanelModel(() => now);
	const base = {
		id: "ext:agent-1",
		kind: "agent" as const,
		name: "helper",
		task: "background check",
	};
	// Another subagent keeps running, so the paused one stays listed.
	const live = { ...base, id: "ext:agent-2", state: "running" as const };
	const elapsedOf = (state: "running" | "paused") =>
		model.rows([{ ...base, state }, live]).find((row) => row.id === base.id)?.elapsedMs;
	assert.equal(elapsedOf("running"), 0);
	now += 10_000;
	assert.equal(elapsedOf("running"), 10_000);
	assert.equal(elapsedOf("paused"), 10_000);
	now += 10_000;
	assert.equal(elapsedOf("running"), 10_000, "time spent paused is not counted");
	now += 10_000;
	assert.equal(elapsedOf("running"), 20_000);

	// Paused with nothing else active, it leaves the panel, and its clock still stops while it is gone.
	assert.deepEqual(model.rows([{ ...base, state: "paused" }]), []);
	now += 10_000;
	assert.equal(model.rows([{ ...base, state: "running" }])[0]?.elapsedMs, 20_000, "time spent paused is not counted");
});

test("renderTaskFooter ranks input-needed tasks first and shares the live task clock (#5224)", async () => {
	initTheme("dark");
	let now = 600_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Needs answer");
		for (let index = 0; index < 5; index++) await fixture.start(`Worker ${index + 1}`);
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "m-0",
				change: { kind: "metrics", elapsedMs: 2000 },
			}),
		);
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "ask-0",
				change: {
					kind: "attention-set",
					attention: {
						kind: "input-needed",
						requestId: "req-1",
						prompt: "Ship this?",
						route: { sessionId: "s", promptId: "req-1" },
					},
				},
			}),
		);
		fixture.store.drain();
		now += 60_000;
		assert.match(text(inspector), /waiting 1m\b/);
		const clocks = taskClocksFor(ownerTaskViewSource(fixture.store));
		const footer1 = stripVTControlCharacters(renderTaskFooter(fixture.store.backgroundTasks, 100, clocks).join("\n"));
		assert.match(footer1.split("\n")[0] ?? "", /◆.*Needs answer.*needs input · 1m/);
		now += 60_000;
		const footer2 = stripVTControlCharacters(renderTaskFooter(fixture.store.backgroundTasks, 100, clocks).join("\n"));
		assert.match(footer2.split("\n")[0] ?? "", /◆.*Needs answer.*needs input · 2m/);
		assert.match(text(inspector), /waiting 2m\b/);
		assert.deepEqual(renderTaskFooter([], 100, clocks), []);
		assert.match(text(inspector), /waiting 2m\b/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		clock.mockRestore();
	}
});

test("reconcile keeps unchanged task references and prototype-wrapped views share managed store clocks without scanning (#5224)", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("Unchanged task");
		await fixture.start("Active task");
		const unchangedBefore = fixture.store.tasks[0];
		const source = ownerTaskViewSource(fixture.store);
		let wrapperTaskReads = 0;
		let wrapperBackgroundReads = 0;
		const chatWrapper = Object.create(source, {
			tasks: {
				get() {
					wrapperTaskReads++;
					return source.tasks;
				},
			},
			backgroundTasks: {
				get() {
					wrapperBackgroundReads++;
					return source.backgroundTasks;
				},
			},
		}) as typeof source;
		assert.equal(taskClocksFor(chatWrapper), taskClocksFor(fixture.store));
		assert.equal(wrapperTaskReads, 0);
		assert.equal(wrapperBackgroundReads, 0);
		taskValue(
			fixture.runners[1]!.context.reportActivity({
				reportId: "act-1",
				change: { kind: "action", tool: "bash", text: "step 1" },
			}),
		);
		fixture.store.drain();
		assert.equal(fixture.store.tasks[0], unchangedBefore);
		assert.equal(wrapperTaskReads, 0);
		assert.equal(wrapperBackgroundReads, 0);

		let unmanagedTasksReads = 0;
		let unmanagedBackgroundReads = 0;
		const unmanaged = {
			get tasks() {
				unmanagedTasksReads++;
				return [];
			},
			get backgroundTasks() {
				unmanagedBackgroundReads++;
				return [];
			},
		};
		taskClocksFor(unmanaged);
		assert.equal(unmanagedTasksReads, 0);
		assert.equal(unmanagedBackgroundReads, 0);
	} finally {
		await fixture.dispose();
	}
});

const identity = (value: string): string => value;

function stageHostOptions(overrides: Partial<ChatSessionHostOpts> = {}): ChatSessionHostOpts {
	const model = { provider: "faux", id: "stage-model", reasoning: false, contextWindow: 1000 };
	const session = {
		state: { model, thinkingLevel: "off" },
		model,
		sessionManager: SessionManager.inMemory("/work"),
		getContextUsage: () => undefined,
		modelRuntime: { isUsingOAuth: () => false },
		isStreaming: false,
	} as unknown as ChatBoxSession;
	return {
		style: {
			dim: identity,
			text: identity,
			textMuted: identity,
			accent: identity,
			accentBold: identity,
			rule: (_hex, line) => line,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		},
		editorTheme: {
			borderColor: identity,
			selectList: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		},
		footerData: {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map<string, string>(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		},
		getChatBoxSession: () => session,
		...overrides,
	};
}

test("painting a sibling chat cannot bring back a stopped child in either footer (#5567)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const parentA = taskRecord("A").ref.taskId;
	const parentB = taskRecord("B").ref.taskId;
	const stopped = {
		...taskRecord("retired-child"),
		parentTaskId: parentA,
		execution: { kind: "settled", result: { kind: "cancelled", cause: "user" } },
	} as const;
	const tasks = [stopped, { ...taskRecord("sibling-child"), parentTaskId: parentB }];
	const root: TaskViewSource = {
		...ownerTaskViewSource(fixture.store),
		tasks,
		backgroundTasks: tasks,
		ownerTasks: tasks,
		ownerBackgroundTasks: tasks,
		taskRecord: (id) => tasks.find((task) => task.ref.taskId === id),
		panelRevision: () => tasks.length,
	};
	const host = (id: typeof parentA) =>
		new ChatSessionHost(stageHostOptions({ getTaskSource: () => launchedTaskViewSource(root, id) }));
	const a = host(parentA);
	const b = host(parentB);
	try {
		assert.deepEqual(a.renderTaskFooter(120), []);
		assert.match(stripVTControlCharacters(b.renderFooter(120).join("\n")), /sibling-child/);
		tasks.push({ ...taskRecord("new-child"), parentTaskId: parentA });
		for (const lines of [a.renderFooter(120), a.renderTaskFooter(120)]) {
			const painted = stripVTControlCharacters(lines.join("\n"));
			assert.match(painted, /new-child/);
			assert.doesNotMatch(painted, /retired-child/);
		}
	} finally {
		a.dispose();
		b.dispose();
		await fixture.dispose();
	}
});

test("unmanaged source updates inspect only previously clocked task slots after warmup (#5224)", () => {
	initTheme("dark");
	let reads = 0;
	let notify = () => {};
	const records = Array.from({ length: 1_000 }, (_, index) => {
		const task = taskRecord(`source-task-${index}`);
		return Object.defineProperty({ ...task }, "ref", {
			get() {
				reads++;
				return task.ref;
			},
		});
	});
	const source = {
		tasks: records,
		subscribe(listener: () => void) {
			notify = listener;
			return () => {};
		},
	};
	const clocks = taskClocksFor(source);
	renderTaskFooter(records, 100, clocks);
	notify();
	reads = 0;
	for (let index = 0; index < 10; index++) notify();
	assert.ok(reads <= AGENT_PANEL_IDLE_ROWS * 10, `source changes read ${reads} task identities for four clocks`);
});

test("a delayed unmanaged settlement freezes the last display or final report without adding the observation gap (#5224)", () => {
	let now = 100_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const running = taskRecord("late-settlement");
	let records = [running];
	let notify = () => {};
	const source = {
		get tasks() {
			return records;
		},
		subscribe(listener: () => void) {
			notify = listener;
			return () => {};
		},
	};
	try {
		const clocks = taskClocksFor(source);
		assert.equal(clocks.elapsedMs(running.ref.taskId, 1_000, true), 1_000);
		now += 5_000;
		assert.equal(clocks.elapsedMs(running.ref.taskId, 1_000, true), 6_000);
		now += 600_000;
		records = [
			{
				...running,
				metrics: { elapsedMs: 7_000 },
				execution: { kind: "settled", result: { kind: "completed", output: running.output } },
			},
		];
		notify();
		assert.equal(clocks.elapsedMs(running.ref.taskId, 7_000, false), 7_000);
	} finally {
		clock.mockRestore();
	}
});

test("reordering many clocked tasks resolves moved slots in one scan and evicts missing clocks (#5224)", () => {
	let reads = 0;
	let notify = () => {};
	const records = Array.from({ length: 1_000 }, (_, index) => {
		const task = taskRecord(`moving-${index}`);
		return Object.defineProperty({ ...task }, "ref", {
			get() {
				reads++;
				return task.ref;
			},
		});
	});
	const source = {
		tasks: records,
		subscribe(listener: () => void) {
			notify = listener;
			return () => {};
		},
	};
	const clocks = taskClocksFor(source);
	for (let index = 0; index < records.length; index++) clocks.elapsedMs(`moving-${index}`, index * 1_000, true);
	notify();
	records.reverse();
	reads = 0;
	notify();
	assert.ok(reads <= records.length * 3, `reordering read ${reads} identities`);
	records.splice(500);
	notify();
	assert.equal(clocks.has("moving-0"), false);
	assert.equal(clocks.has("moving-999"), true);
});

test("taskClocksFor syncs only retained clocks on source updates and renderTaskFooter projects only drawn rows (#5224)", () => {
	initTheme("dark");
	let notify: (() => void) | undefined;
	let taskReads = 0;
	const records = [taskRecord("t-1"), taskRecord("t-2")];
	const source = {
		get tasks() {
			taskReads++;
			return records;
		},
		subscribe(listener: () => void) {
			notify = listener;
			return () => {
				notify = undefined;
			};
		},
	};
	const sourceClocks = taskClocksFor(source);
	taskClocksFor(source);
	taskClocksFor(source);
	assert.equal(taskReads, 0);
	notify?.();
	assert.equal(taskReads, 0);
	renderTaskFooter(records, 100, sourceClocks);
	notify?.();
	assert.equal(taskReads, 1);
	taskClocksFor(source);
	assert.equal(taskReads, 1);

	const unsubscribedTasks = [taskRecord("plain-1")];
	const unsubscribedSource = { tasks: unsubscribedTasks };
	const unsubscribedClocks = taskClocksFor(unsubscribedSource);
	assert.equal(taskClockOf(unsubscribedTasks[0]!), undefined);
	const addedTask = taskRecord("plain-2");
	unsubscribedTasks.push(addedTask);
	assert.equal(taskClocksFor(unsubscribedSource), unsubscribedClocks);
	assert.equal(taskClockOf(addedTask), undefined);

	const projectedIds = new Set<string>();
	const manyTasks = Array.from({ length: 20 }, (_, index) => {
		const base = taskRecord(`footer-task-${index}`);
		const metrics = { elapsedMs: (index + 1) * 1000 };
		return Object.defineProperty({ ...base, title: `Task ${index}` }, "metrics", {
			enumerable: true,
			get() {
				projectedIds.add(base.ref.taskId);
				return metrics;
			},
		});
	});
	const lines = renderTaskFooter(manyTasks, 100).map((line) => stripVTControlCharacters(line));
	assert.equal(projectedIds.size, AGENT_PANEL_IDLE_ROWS);
	assert.equal(lines.length, AGENT_PANEL_IDLE_ROWS + 1);
	assert.match(lines.at(-1) ?? "", /\+16 more/);
});
