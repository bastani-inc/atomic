import assert from "node:assert/strict";
import { setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId, TaskRecord, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	TaskDetail,
	taskDetailSummary,
} from "../../packages/coding-agent/src/modes/interactive/components/task-detail.js";
import {
	renderTaskFooter,
	TaskList,
	taskListSections,
} from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import {
	TaskRow,
	taskDuration,
	taskMetricsText,
	taskShortId,
	taskStatusAppearance,
} from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

initTheme();
setKeybindings(new KeybindingsManager());
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

// RFC #2884: compact rendering preserves identities and raw text, including zero metrics.
test("compact rows show states, zero counts and display-only truncation", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start("\n first raw line \n second", "");
		const task = fixture.store.tasks[0];
		assert.match(task.title, /first raw line/);
		const rawTitle = "same description ".repeat(20);
		const sample = { ...task, title: rawTitle, metrics: { toolCount: 0 } };
		const lines = new TaskRow(sample, { duplicate: true }).render(40);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
		assert.equal(sample.title, rawTitle);
		assert.match(plain(lines), /◯ worker:/);
		assert.match(plain(lines), /0 tool uses/);
		for (const kind of ["completed", "failed", "cancelled"] as const) {
			const result =
				kind === "completed"
					? { kind, output: task.output }
					: kind === "failed"
						? { kind, code: "failure", message: "failure" }
						: { kind, cause: "user" as const };
			const text = plain(new TaskRow({ ...task, execution: { kind: "settled", result } }).render(80));
			assert.match(text, new RegExp(kind === "cancelled" ? "killed \\(non-resumable\\)" : kind));
			assert.doesNotMatch(text, /background|foreground/);
		}
		assert.match(plain(new TaskRow({ ...task, execution: { kind: "queued" } }).render(80)), /queued/);
		assert.match(
			plain(
				new TaskRow({
					...task,
					attention: {
						kind: "input-needed",
						requestId: "q",
						prompt: "",
						route: { sessionId: "s", promptId: "q" },
					},
				}).render(80),
			),
			/input-needed/,
		);
		assert.doesNotMatch(plain(new TaskRow(task).render(80)), /tool uses|tokens|elapsed/);
		const expanded = plain(new TaskRow(task, { expanded: true }).render(80));
		assert.match(expanded, /Activity[\s\S]*\/tasks to inspect transcript/);
		assert.doesNotMatch(expanded, /Transcript unavailable/);
	} finally {
		await fixture.dispose();
	}
});

test("a quit or paused agent row shows it paused and awaiting resume, not stopped or killed", () => {
	for (const cause of ["quit", "pause"] as const) {
		const paused: TaskRecord = {
			...taskRecord(`paused-${cause}`),
			execution: { kind: "settled", result: { kind: "cancelled", cause } },
		};
		const row = plain(new TaskRow(paused).render(80));
		assert.match(row, /‖ worker|‖ agent/);
		assert.match(row, /paused · awaiting resume/);
		assert.doesNotMatch(row, /cancelled|killed|stopped/i);
		assert.deepEqual(taskStatusAppearance(paused), {
			label: "Paused · awaiting resume",
			icon: "‖",
			color: "warning",
		});
	}
});

test("/tasks names the resume id of a settled subagent that stays resumable, in its expanded row and detail", () => {
	const settled = (result: TaskResult, kind: TaskRecord["kind"] = "agent"): TaskRecord => ({
		...taskRecord("finished-child", kind),
		launchOperationId: "a760c0ec:0:resume:uuid" as TaskRecord["launchOperationId"],
		execution: { kind: "settled", result },
	});
	const output = taskRecord("finished-child").output;
	const shown = (task: TaskRecord) => [
		plain(new TaskRow(task, { expanded: true }).render(120)),
		plain(new TaskDetail(task, { stdinAvailable: false }).render(120)),
	];
	for (const result of [
		{ kind: "completed", output },
		{ kind: "failed", code: "AgentFailed", message: "model refused", output },
		{ kind: "cancelled", cause: "quit" },
	] as const) {
		const [row, detail] = shown(settled(result));
		assert.match(row!, /^ {2}finished-child · owner owner · resume id a760c0ec:0$/m, result.kind);
		assert.match(detail!, /Owner owner · Task finished-child · Resume id a760c0ec:0/, result.kind);
		// Collapsed, the row reads as before.
		assert.doesNotMatch(plain(new TaskRow(settled(result)).render(120)), /resume id/i);
	}
	// A child killed for good, a released one, a running one and a shell show no resume id.
	for (const task of [
		settled({ kind: "cancelled", cause: "user" }),
		settled({ kind: "cancelled", cause: "pause", released: { waitingOn: [] } }),
		{ ...settled({ kind: "cancelled", cause: "user" }), execution: { kind: "running" as const } },
		settled({ kind: "completed", output, exitCode: 0 }, "command"),
	])
		for (const text of shown(task)) assert.doesNotMatch(text, /resume id/i);

	// Once resumed, the child is its latest attempt: only that one names the id, not the attempt it continued.
	const first = {
		...settled({ kind: "completed", output }),
		launchOperationId: "a760c0ec:0" as TaskRecord["launchOperationId"],
	};
	const second: TaskRecord = {
		...taskRecord("second-attempt"),
		launchOperationId: "a760c0ec:0:resume:uuid" as TaskRecord["launchOperationId"],
		launchOrdinal: 1,
	};
	const attempt = (task: TaskRecord, siblings: readonly TaskRecord[]) => [
		plain(new TaskRow(task, { expanded: true, siblings }).render(120)),
		plain(new TaskDetail(task, { stdinAvailable: false, tasks: siblings }).render(120)),
	];
	for (const text of attempt(first, [first, second]))
		assert.doesNotMatch(text, /resume id/i, "while the resumed attempt runs");
	const done: TaskRecord = { ...second, execution: { kind: "settled", result: { kind: "completed", output } } };
	for (const text of attempt(first, [first, done]))
		assert.doesNotMatch(text, /resume id/i, "after the resumed attempt finished");
	for (const text of attempt(done, [first, done])) assert.match(text, /resume id a760c0ec:0/i, "the latest attempt");
});

test("an agent released while it waits shows released and what it waits on in /tasks, not paused (#5031)", () => {
	const released: TaskRecord = {
		...taskRecord("released-child"),
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: "toolu-7", toolName: "bash" }] },
			},
		},
	};
	const row = plain(new TaskRow(released).render(120));
	assert.match(row, /◌ agent: .*\n.*\n {2}waiting on bash \(toolu-7\)/);
	assert.doesNotMatch(row, /◯|paused|awaiting resume|cancelled|killed|stopped/i);
	assert.deepEqual(taskStatusAppearance(released), { label: "Waiting on bash", icon: "◌", color: "dim" });
});

// RFC #2884: complete projections are not limited to the mounted viewport.
test("groups retain all tasks, one expansion hint and separate inspector type order", async () => {
	const fixture = taskFixture();
	try {
		for (let i = 0; i < 6; i++) await fixture.start("identical");
		const tasks = fixture.store.tasks.map((task) => ({ ...task, launchGroupId: "parallel" }));
		const text = plain(new TaskList(tasks).render(80));
		assert.match(text, /worker · 6 running/);
		assert.equal((text.match(/◯ worker:/g) ?? []).length, 6);
		assert.equal((text.match(/expand/g) ?? []).length, 1);
		assert.match(text, /├─/);
		assert.match(text, /└─/);
		assert.equal(new Set(tasks.map((task) => task.ref.taskId)).size, 6);
		const mixed = [tasks[0], { ...tasks[1], kind: "command" as const, agentName: undefined }, tasks[2]];
		assert.match(plain(new TaskList(mixed).render(80)), /Tasks · 3 running/);
		assert.deepEqual(
			taskListSections(mixed).map((section) => section.title),
			["Agents", "Shells"],
		);
		assert.deepEqual(taskListSections(mixed)[0].tasks, [mixed[2], mixed[0]]);
		// Active tasks render as agent-panel rows: four, then the rest folded (#5224).
		assert.equal(renderTaskFooter(tasks, 80).length, 5);
		assert.equal(plain(renderTaskFooter(tasks, 80)).split("\n").at(-1), "  +2 more");
		assert.deepEqual(renderTaskFooter([], 80), []);
	} finally {
		await fixture.dispose();
	}
});

test("sections order tasks by status with running work first and newest first within a status (#3252)", () => {
	const output = taskRecord("output").output;
	const settled = (id: string, result: TaskResult, kind: "agent" | "command" = "agent"): TaskRecord => ({
		...taskRecord(id, kind),
		execution: { kind: "settled", result },
	});
	const completedOld = settled("completed-old", { kind: "completed", output });
	const failed = settled("failed", { kind: "failed", code: "x", message: "x" });
	const runningOld = taskRecord("running-old");
	const queued: TaskRecord = { ...taskRecord("queued"), execution: { kind: "queued" } };
	const cancelled = settled("cancelled", { kind: "cancelled", cause: "user" });
	const stopping: TaskRecord = { ...taskRecord("stopping"), execution: { kind: "cancelling", cause: "user" } };
	const attention: TaskRecord = {
		...taskRecord("attention"),
		attention: { kind: "no-recent-activity" },
	};
	const completedNew = settled("completed-new", { kind: "completed", output });
	const runningNew = taskRecord("running-new");
	const shellDone = settled("shell-done", { kind: "completed", output }, "command");
	const shellRunning = taskRecord("shell-running", "command");
	const tasks = [
		completedOld,
		failed,
		runningOld,
		queued,
		cancelled,
		stopping,
		attention,
		completedNew,
		runningNew,
		shellDone,
		shellRunning,
	];
	const ids = (settlementOrder?: ReadonlyMap<TaskId, bigint>) =>
		taskListSections(tasks, settlementOrder).map((section) => [
			section.title,
			section.tasks.map((task) => task.ref.taskId),
		]);
	assert.deepEqual(ids(), [
		[
			"Agents",
			[
				"attention",
				"running-new",
				"running-old",
				"stopping",
				"queued",
				"failed",
				"cancelled",
				"completed-new",
				"completed-old",
			],
		],
		["Shells", ["shell-running", "shell-done"]],
	]);
	const settledLast = new Map([
		[completedNew.ref.taskId, 0n],
		[completedOld.ref.taskId, 1n],
	]);
	assert.deepEqual(ids(settledLast)[0][1].slice(-2), ["completed-old", "completed-new"]);
});

// RFC #2884: raw and display-colliding descriptions must never identify a task.
test("short labels distinguish shared ID suffixes and descriptions colliding at narrow width", async () => {
	const fixture = taskFixture();
	try {
		await fixture.start();
		const base = fixture.store.tasks[0];
		const tasks = ["first", "second"].map((name) => ({
			...base,
			title: `${"same long description ".repeat(8)}${name}`,
			ref: { ...base.ref, taskId: `${name}-abcdef` as TaskId },
		}));
		assert.notEqual(taskShortId(tasks[0]), taskShortId(tasks[1]));
		const lines = new TaskList(tasks).render(40);
		assert.ok(lines.every((line) => visibleWidth(line) <= 40));
		for (const task of tasks) assert.ok(plain(lines).includes(`[${taskShortId(task)}]`));
		const before = taskShortId(tasks[0]);
		assert.equal(
			taskShortId({
				...tasks[0],
				execution: { kind: "settled", result: { kind: "completed", output: base.output } },
			}),
			before,
		);
	} finally {
		await fixture.dispose();
	}
});

test("task footer rows color current work and hide settled results without deleting them (#5224)", () => {
	for (const mode of ["dark", "light"] as const) {
		initTheme(mode);
		const task = taskRecord("footer-theme");
		const glyph = (color: "accent" | "warning", text: string) =>
			assert.ok((renderTaskFooter([task], 80)[0] ?? "").includes(theme.fg(color, text)));
		assert.match(plain(renderTaskFooter([task], 80)), /^ {2}◯ agent/);
		task.execution = { kind: "settled", result: { kind: "completed", output: task.output } };
		assert.deepEqual(renderTaskFooter([task], 80), []);
		task.execution = { kind: "settled", result: { kind: "failed", code: "Test", message: "Failure" } };
		assert.deepEqual(renderTaskFooter([task], 80), []);
		assert.match(plain(new TaskRow(task).render(80)), /failed/);
		task.execution = { kind: "settled", result: { kind: "cancelled", cause: "user" } };
		assert.deepEqual(renderTaskFooter([task], 80), []);
		task.execution = { kind: "cancelling", cause: "user" };
		glyph("warning", "◼");
		assert.match(plain(renderTaskFooter([task], 80)), /stopping$/);
	}
});

test("task footer lists only active background tasks, newest first, not retained failures (#5224)", () => {
	const agent = taskRecord("agent");
	const shell = { ...taskRecord("shell"), kind: "command" as const };
	const rows = (tasks: Parameters<typeof renderTaskFooter>[0], width: number) =>
		plain(renderTaskFooter(tasks, width))
			.split("\n")
			.map((line) => line.replace(/ {2,}/g, "  ").trimEnd());
	assert.deepEqual(rows([agent], 100), ["  ◯ agent  Task agent  running"]);
	// Shells are counted below the rows, as the main chat's hint counts them, not listed.
	assert.deepEqual(rows([agent, shell], 100), ["  ◯ agent  Task agent  running", "  1 shell"]);
	const failure = taskRecord("failure");
	failure.execution = { kind: "settled", result: { kind: "failed", code: "fixture", message: "Failed" } };
	assert.deepEqual(rows([agent, shell, failure], 60), ["  ◯ agent  Task agent  running", "  1 shell"]);
	assert.deepEqual(renderTaskFooter([failure], 60), []);
});

test("taskDuration, taskMetricsText, taskDetailSummary and TaskRow use panel elapsed formatting (3m and 1h 6m, not 3m 12s or 66m 40s) (#5239)", () => {
	assert.equal(taskDuration(192_000), "3m");
	assert.equal(taskDuration(4_000_000), "1h 6m");
	const threeMinTask: TaskRecord = {
		...taskRecord("three-min"),
		execution: { kind: "settled", result: { kind: "completed", output: taskRecord("three-min").output } },
		metrics: { elapsedMs: 192_000, tokenCount: 1200, toolCount: 2 },
	};
	const hourTask: TaskRecord = {
		...taskRecord("hour-six"),
		execution: { kind: "settled", result: { kind: "completed", output: taskRecord("hour-six").output } },
		metrics: { elapsedMs: 4_000_000 },
	};
	assert.equal(taskMetricsText(threeMinTask), "3m · 1.2k tokens · 2 tools");
	assert.match(taskDetailSummary(threeMinTask), /\b3m\b/);
	assert.doesNotMatch(taskDetailSummary(threeMinTask), /3m 12s/);
	assert.equal(taskMetricsText(hourTask), "1h 6m");
	assert.match(taskDetailSummary(hourTask), /\b1h 6m\b/);
	assert.doesNotMatch(taskDetailSummary(hourTask), /66m 40s/);
	assert.match(plain(new TaskRow(threeMinTask).render(80)), /· 3m\b/);
	assert.doesNotMatch(plain(new TaskRow(threeMinTask).render(80)), /3m 12s/);
	assert.match(plain(new TaskRow(hourTask).render(80)), /· 1h 6m\b/);
	assert.doesNotMatch(plain(new TaskRow(hourTask).render(80)), /66m 40s/);
});
