import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test, vi } from "vitest";
import {
	type AgentPanelItem,
	AgentPanelSourceHub,
} from "../../packages/coding-agent/src/core/tasks/agent-panel-source.js";
import {
	bindTaskClock,
	TaskElapsedClocks,
	taskClockRunning,
	taskClocksFor,
} from "../../packages/coding-agent/src/core/tasks/live-elapsed.js";
import { AgentPanelModel } from "../../packages/coding-agent/src/modes/interactive/components/agent-panel.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { taskMetricsText } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	agentPanelRows,
	bindAgentPanel,
	setAgentPanelVisible,
} from "../../packages/coding-agent/src/modes/rpc/agent-panel-bridge.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

initTheme("dark");

test("cancelling tasks keep one monotone elapsed time across the panel and task views (#5224, #5239)", () => {
	let now = 0;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const panel = new AgentPanelModel(() => now);
	const record = {
		...taskRecord("cancelling-clock"),
		agentName: "worker",
		title: "finish cleanup",
		metrics: { elapsedMs: 5000 },
	};
	const plainRow = {
		id: "task:cancelling-clock",
		kind: "agent" as const,
		state: "running" as const,
		name: "worker",
		task: "finish cleanup",
		elapsedMs: 5000,
	};
	const source = transcriptOnlySource({
		tasks: [record],
		backgroundTasks: [record],
		recentActivity: () => [],
		activityOmitted: () => false,
		stdinAvailable: () => false,
		readTaskTranscript: () => ({ ok: true, value: { messages: [] } }),
		followTaskTranscript: () => undefined,
	});
	const clocks = taskClocksFor(source);
	bindTaskClock(record, clocks);
	const row = bindTaskClock({ ...plainRow }, clocks);
	const observeTaskClocks = (records: readonly (typeof record)[], at: number) => {
		for (const task of records) {
			if (task.execution.kind === "settled") clocks.settle(task.ref.taskId, task.metrics?.elapsedMs, at);
			else clocks.elapsedMs(task.ref.taskId, task.metrics?.elapsedMs, taskClockRunning(task.execution.kind), at);
		}
	};
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
	);
	const transcript = new TaskAgentTranscriptPage(source, record.ref.taskId, taskTranscriptEnvironment(), () => {});
	const renderInspector = () => inspector.renderViewport(100, 20).map(stripVTControlCharacters).join("\n");
	const renderTranscript = () => transcript.render(100, 20).map(stripVTControlCharacters).join("\n");
	try {
		observeTaskClocks([record], now);
		assert.equal(panel.rows([row])[0]?.elapsedMs, 5000);
		now = 60_000;
		observeTaskClocks([record], now);
		assert.equal(panel.rows([row])[0]?.elapsedMs, 65_000);
		assert.equal(taskMetricsText(record), "1m");
		assert.match(renderInspector(), /worker\s+finish cleanup\s+1m\b/);
		assert.match(renderTranscript(), /worker · finish cleanup · 1m/);

		record.execution = { kind: "cancelling", cause: "user" };
		now = 61_000;
		observeTaskClocks([record], now);
		assert.equal(taskMetricsText(record), "1m");
		assert.match(renderInspector(), /worker\s+finish cleanup\s+stopping/);

		for (let second = 62; second <= 70; second++) {
			now = second * 1000;
			assert.match(renderTranscript(), /worker · finish cleanup · 1m/);
		}
		now = 71_000;
		assert.equal(panel.rows([bindTaskClock({ ...row, state: "stopping" as const }, clocks)])[0]?.elapsedMs, 76_000);
		assert.equal(taskMetricsText(record), "1m");
		assert.match(renderInspector(), /stopping/);

		now = 116_000;
		assert.match(renderTranscript(), /worker · finish cleanup · 2m/);
		assert.equal(panel.rows([bindTaskClock({ ...row, state: "stopping" as const }, clocks)])[0]?.elapsedMs, 121_000);

		now = 118_000;
		record.execution = { kind: "settled", result: { kind: "cancelled", cause: "user" } };
		observeTaskClocks([record], now);
		// Another subagent still runs, so the stopped one stays listed.
		const live = { ...plainRow, id: "task:still-running" };
		const stoppedRow = () =>
			panel
				.rows([bindTaskClock({ ...row, state: "stopped" as const }, clocks), live])
				.find((candidate) => candidate.id === row.id);
		assert.equal(stoppedRow()?.elapsedMs, 123_000);
		assert.equal(taskMetricsText(record), "2m");
		now += 100_000;
		assert.equal(stoppedRow()?.elapsedMs, 123_000);
		assert.equal(taskMetricsText(record), "2m");
	} finally {
		transcript.dispose();
		inspector.dispose();
		clock.mockRestore();
	}
});

test("running extension rows published while the panel is hidden keep accurate elapsed time across a hidden update (#5224, #5239)", async () => {
	let now = 0;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const hub = new AgentPanelSourceHub();
	let notifyPublished = () => {};
	let publishedItems: AgentPanelItem[] = [
		{
			id: "ext:publish-time",
			kind: "agent",
			state: "running",
			name: "indexer",
			task: "scan",
			elapsedMs: 0,
		},
	];
	hub.register({
		items: () => publishedItems,
		subscribe: (listener) => {
			notifyPublished = listener;
			return () => {};
		},
	});
	const session = { extensionRunner: { getAgentPanelSourceHub: () => hub } };
	const dispose = bindAgentPanel(session, {
		setWidget() {},
		requestRender() {},
	} as never);
	try {
		assert.deepEqual(
			agentPanelRows(session).map((row) => `${row.id}:${row.elapsedMs}`),
			["ext:publish-time:0"],
		);
		now = 10_000;
		setAgentPanelVisible(session, false);
		now = 60_000;
		publishedItems = [
			{
				id: "ext:publish-time",
				kind: "agent",
				state: "running",
				name: "indexer",
				task: "scan",
				elapsedMs: 60_000,
			},
		];
		notifyPublished();
		await Promise.resolve();
		now = 120_000;
		setAgentPanelVisible(session, true);
		assert.deepEqual(
			agentPanelRows(session).map((row) => `${row.id}:${row.elapsedMs}`),
			["ext:publish-time:120000"],
		);
	} finally {
		dispose();
		hub.dispose();
		clock.mockRestore();
	}
});

test("dropping a running extension row does not retain its clock when the id is reused (#5224, #5239)", () => {
	let now = 0;
	const panel = new AgentPanelModel(() => now);
	assert.equal(
		panel.rows([{ id: "ext:job-0", kind: "agent", state: "running", name: "job", task: "first", elapsedMs: 0 }])[0]
			?.elapsedMs,
		0,
	);
	now = 50_000;
	assert.equal(panel.rows([]).length, 0);
	now = 650_000;
	assert.equal(
		panel.rows([{ id: "ext:job-0", kind: "agent", state: "running", name: "job", task: "second", elapsedMs: 0 }])[0]
			?.elapsedMs,
		0,
	);
});

test("new task clocks never evict a still-running task's elapsed time (#5224, #5239)", () => {
	const clocks = new TaskElapsedClocks();
	assert.equal(clocks.elapsedMs("retained-running-clock", 0, true, 0), 0);
	assert.equal(clocks.elapsedMs("retained-running-clock", 0, true, 100_000), 100_000);
	for (let index = 0; index < 2050; index++) clocks.elapsedMs(`new-clock-${index}`, 0, true, 100_000);
	assert.equal(clocks.elapsedMs("retained-running-clock", 0, true, 100_000), 100_000);
	for (let index = 0; index < 2050; index++) clocks.elapsedMs(`new-clock-${index}`, 0, false, 100_000);
	assert.equal(clocks.elapsedMs("retained-running-clock", 0, true, 101_000), 101_000);
});

test("the task store records settlement time even when no panel is visible (#5224, #5239)", async () => {
	let now = 100_000;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	const fixture = taskFixture();
	try {
		await fixture.start();
		const task = fixture.store.tasks[0]!;
		const clocks = taskClocksFor(fixture.store);
		assert.equal(clocks.elapsedMs(task.ref.taskId, 0, true, now), 0);
		now += 60_000;
		await fixture.settle();
		assert.equal(fixture.store.tasks[0]?.execution.kind, "settled");
		now += 600_000;
		assert.equal(clocks.elapsedMs(task.ref.taskId, 0, false, now), 60_000);
	} finally {
		await fixture.dispose();
		clock.mockRestore();
	}
});

test("a task's stop is recorded when it happens, so a view that first looks much later reads its real time (#5224)", () => {
	const clocks = new TaskElapsedClocks();
	clocks.elapsedMs("observed-stop", 1000, true, 0);
	clocks.settle("observed-stop", 1000, 60_000);
	assert.equal(
		clocks.elapsedMs("observed-stop", 1000, false, 660_000),
		61_000,
		"not the 11 minutes until the view looked",
	);
});
