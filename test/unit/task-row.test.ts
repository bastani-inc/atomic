import assert from "node:assert/strict";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId, TaskRecord, TaskResult } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import {
	renderTaskFooter,
	TaskList,
	taskListSections,
} from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import { TaskRow, taskShortId } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
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
		assert.match(plain(lines), /∀ worker:/);
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

// RFC #2884: complete projections are not limited to the mounted viewport.
test("groups retain all tasks, one expansion hint and separate inspector type order", async () => {
	const fixture = taskFixture();
	try {
		for (let i = 0; i < 6; i++) await fixture.start("identical");
		const tasks = fixture.store.tasks.map((task) => ({ ...task, launchGroupId: "parallel" }));
		const text = plain(new TaskList(tasks).render(80));
		assert.match(text, /worker · 6 running/);
		assert.equal((text.match(/∀ worker:/g) ?? []).length, 6);
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
		assert.equal(plain(renderTaskFooter(tasks, 80)), "Tasks  6 local agents running · /tasks");
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

test("task footer colors current work and hides settled results without deleting them", () => {
	for (const mode of ["dark", "light"] as const) {
		initTheme(mode);
		const task = taskRecord("footer-theme");
		const assertColor = (color: "accent" | "warning") => {
			const rows = renderTaskFooter([task], 80);
			assert.equal(rows[0], theme.fg(color, plain(rows)));
			assert.notEqual(rows[0], theme.fg("dim", plain(rows)));
		};
		assertColor("accent");
		task.execution = { kind: "settled", result: { kind: "completed", output: task.output } };
		assert.deepEqual(renderTaskFooter([task], 80), []);
		task.execution = { kind: "settled", result: { kind: "failed", code: "Test", message: "Failure" } };
		assert.deepEqual(renderTaskFooter([task], 80), []);
		assert.match(plain(new TaskRow(task).render(80)), /failed/);
		task.execution = { kind: "settled", result: { kind: "cancelled", cause: "user" } };
		assert.deepEqual(renderTaskFooter([task], 80), []);
		task.execution = { kind: "cancelling", cause: "user" };
		assertColor("warning");
	}
});

test("task footer summarizes only active background tasks, not retained failures", () => {
	const agent = taskRecord("agent");
	const shell = { ...taskRecord("shell"), kind: "command" as const };
	assert.equal(plain(renderTaskFooter([agent], 100)), "Tasks  1 local agent running · /tasks");
	assert.equal(plain(renderTaskFooter([agent, agent], 100)), "Tasks  2 local agents running · /tasks");
	assert.equal(plain(renderTaskFooter([shell], 100)), "Tasks  1 shell running · /tasks");
	assert.equal(plain(renderTaskFooter([shell, shell], 100)), "Tasks  2 shells running · /tasks");
	assert.equal(plain(renderTaskFooter([agent, shell], 100)), "Tasks  2 background tasks running · /tasks");
	const failure = taskRecord("failure");
	failure.execution = { kind: "settled", result: { kind: "failed", code: "fixture", message: "Failed" } };
	const rows = renderTaskFooter([agent, shell, failure], 60);
	assert.equal(plain(rows), "Tasks  2 background tasks running · /tasks");
	assert.equal(rows[0], theme.fg("accent", plain(rows)));
	assert.deepEqual(renderTaskFooter([failure], 60), []);
});
