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
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	AGENT_PANEL_IDLE_ROWS,
	AgentPanelModel,
} from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { renderTaskFooter } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
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
		taskValue(
			fixture.runners[0].context.reportActivity({
				reportId: "metrics",
				change: { kind: "metrics", elapsedMs: 2000 },
			}),
		);
		fixture.store.drain();
		now += 60_000;
		assert.match(text(inspector), /1m 0s|1m 2s/);
		taskValue(await fixture.supervisor.cancelTask(task, "user"));
		fixture.store.drain();
		assert.equal(fixture.store.tasks[0].execution.kind, "cancelling");
		text(inspector);
		rows = model.rows(taskPanelItems(source, new Set()));
		fixture.runners[0].result.resolve({ kind: "cancelled", cause: "user" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		fixture.store.drain();
		assert.match(text(inspector), /stopped · 1m (0|2)s/);
		assert.ok((rows[0]?.elapsedMs ?? 0) >= 60_000, `panel elapsed ${rows[0]?.elapsedMs}`);
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

test("unrelated root and pooled worker tasks with the same id keep independent clocks (#5224)", async () => {
	initTheme("dark");
	let now = 300_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	const pooled = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
	const rootInspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	const pooledInspector = new TaskInspector(
		pooled,
		() => {},
		() => {},
	);
	const model = new AgentPanelModel(() => now);
	try {
		await fixture.start("Root task");
		const sharedId = fixture.store.tasks[0]!.ref.taskId;
		text(rootInspector);
		now += 600_000;
		assert.match(text(rootInspector), /10m 0s/);
		const workerTask = {
			...taskRecord(sharedId),
			title: "Worker task",
			metrics: { elapsedMs: 5000 },
		};
		pooled.apply({
			tasks: [workerTask],
			background: [sharedId],
			settlement: [],
			activity: [],
			stdin: [],
			statuses: [],
		});
		assert.match(text(pooledInspector), /5s/);
		assert.doesNotMatch(text(pooledInspector), /10m/);

		const secondPool = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
		secondPool.apply({
			tasks: [{ ...taskRecord(sharedId), title: "Long worker", metrics: { elapsedMs: 3_600_000 } }],
			background: [sharedId],
			settlement: [],
			activity: [],
			stdin: [],
			statuses: [],
		});
		const secondInspector = new TaskInspector(
			secondPool,
			() => {},
			() => {},
		);
		text(secondInspector);
		secondInspector.dispose();
		const rootRows = model.rows(taskPanelItems(ownerTaskViewSource(fixture.store), new Set()));
		assert.equal(rootRows[0]?.elapsedMs, 600_000);
	} finally {
		rootInspector.dispose();
		pooledInspector.dispose();
		await fixture.dispose();
		clock.mockRestore();
	}
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
		const settledRows = model.rows(taskPanelItems(source, new Set()));
		assert.ok((settledRows[0]?.elapsedMs ?? 0) >= 60_000, `settled panel elapsed: ${settledRows[0]?.elapsedMs}`);
		assert.match(text(inspector), /done · 1m (0|2)s/);
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
	assert.equal(model.rows([{ ...base, state: "running" }])[0]?.elapsedMs, 0);
	now += 10_000;
	assert.equal(model.rows([{ ...base, state: "running" }])[0]?.elapsedMs, 10_000);
	assert.equal(model.rows([{ ...base, state: "paused" }])[0]?.elapsedMs, 10_000);
	now += 10_000;
	assert.equal(model.rows([{ ...base, state: "running" }])[0]?.elapsedMs, 20_000);
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
		assert.match(text(inspector), /waiting 1m (0|2)s/);
		const clocks = taskClocksFor(ownerTaskViewSource(fixture.store));
		const footer1 = stripVTControlCharacters(renderTaskFooter(fixture.store.backgroundTasks, 100, clocks).join("\n"));
		assert.match(footer1.split("\n")[0] ?? "", /◆.*Needs answer.*needs input · 1m/);
		now += 60_000;
		const footer2 = stripVTControlCharacters(renderTaskFooter(fixture.store.backgroundTasks, 100, clocks).join("\n"));
		assert.match(footer2.split("\n")[0] ?? "", /◆.*Needs answer.*needs input · 2m/);
		assert.match(text(inspector), /waiting 2m (0|2)s/);
		assert.deepEqual(renderTaskFooter([], 100, clocks), []);
		assert.match(text(inspector), /waiting 2m (0|2)s/);
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
		assert.equal(unmanagedTasksReads, 1);
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

test("two stage chat hosts with the same pooled task id keep independent footer clocks and unbound records do not tick (#5224)", () => {
	initTheme("dark");
	let now = 700_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const sharedId = taskRecord("task-1-0-0").ref.taskId;
	const poolA = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
	const poolB = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
	poolA.apply({
		tasks: [{ ...taskRecord(sharedId), title: "Worker A", metrics: { elapsedMs: 3_600_000 } }],
		background: [sharedId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	poolB.apply({
		tasks: [{ ...taskRecord(sharedId), title: "Worker B", metrics: { elapsedMs: 5000 } }],
		background: [sharedId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	const hostA = new ChatSessionHost(stageHostOptions({ getTaskSource: () => poolA }));
	const hostB = new ChatSessionHost(stageHostOptions({ getTaskSource: () => poolB }));
	const unboundPool = new PooledStageTaskSource(async () => ({ kind: "detail", detail: {} }));
	unboundPool.apply({
		tasks: [{ ...taskRecord(sharedId), title: "Unbound worker", metrics: { elapsedMs: 2000 } }],
		background: [sharedId],
		settlement: [],
		activity: [],
		stdin: [],
		statuses: [],
	});
	let unboundInspector: TaskInspector | undefined;
	try {
		const frameA1 = stripVTControlCharacters(hostA.renderFooter(120).join("\n"));
		hostA.renderTaskFooter(120);
		assert.match(frameA1, /Worker A.*1h 0m/);

		const frameB1 = stripVTControlCharacters(hostB.renderFooter(120).join("\n"));
		hostB.renderTaskFooter(120);
		assert.match(frameB1, /Worker B.*5s/);
		assert.doesNotMatch(frameB1, /1h/);

		now += 1000;
		const frameB2 = stripVTControlCharacters(hostB.renderFooter(120).join("\n"));
		hostB.renderTaskFooter(120);
		assert.match(frameB2, /Worker B.*6s/);

		const unbound1 = stripVTControlCharacters(renderTaskFooter(unboundPool.backgroundTasks, 100).join("\n"));
		assert.match(unbound1, /Unbound worker.*2s/);
		now += 60_000;
		const unbound2 = stripVTControlCharacters(renderTaskFooter(unboundPool.backgroundTasks, 100).join("\n"));
		assert.match(unbound2, /Unbound worker.*2s/);
		assert.doesNotMatch(unbound2, /1m/);

		unboundInspector = new TaskInspector(
			unboundPool,
			() => {},
			() => {},
		);
		assert.match(text(unboundInspector), /Unbound worker.*2s/);
		const bound1 = stripVTControlCharacters(renderTaskFooter(unboundPool.backgroundTasks, 100).join("\n"));
		assert.match(bound1, /Unbound worker.*2s/);
		now += 10_000;
		const bound2 = stripVTControlCharacters(renderTaskFooter(unboundPool.backgroundTasks, 100).join("\n"));
		assert.match(bound2, /Unbound worker.*12s/);
		assert.match(text(unboundInspector), /Unbound worker.*12s/);
	} finally {
		unboundInspector?.dispose();
		hostA.dispose();
		hostB.dispose();
		clock.mockRestore();
	}
});

test("taskClocksFor syncs an unmanaged source only on initial subscription and renderTaskFooter projects only drawn rows (#5224)", () => {
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
	taskClocksFor(source);
	taskClocksFor(source);
	taskClocksFor(source);
	assert.equal(taskReads, 1);
	notify?.();
	assert.equal(taskReads, 2);
	taskClocksFor(source);
	assert.equal(taskReads, 2);

	const unsubscribedTasks = [taskRecord("plain-1")];
	const unsubscribedSource = { tasks: unsubscribedTasks };
	const unsubscribedClocks = taskClocksFor(unsubscribedSource);
	assert.equal(taskClockOf(unsubscribedTasks[0]!), unsubscribedClocks);
	const addedTask = taskRecord("plain-2");
	unsubscribedTasks.push(addedTask);
	taskClocksFor(unsubscribedSource);
	assert.equal(taskClockOf(addedTask), unsubscribedClocks);

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
