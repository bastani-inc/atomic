/**
 * The `/workflow connect` picker and the `/workflow status` list order runs the
 * way `/tasks` does: status rank first, newest first within a status.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { selectRunsForPicker } from "../../packages/workflows/src/tui/session-picker.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";

const NOW = 10_000_000;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function makeRun(over: Partial<RunSnapshot> & Pick<RunSnapshot, "id">): RunSnapshot {
	return {
		name: "demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1000,
		...over,
	};
}

function ended(id: string, status: RunSnapshot["status"], startedAt: number, endedAt: number): RunSnapshot {
	return makeRun({ id, status, startedAt, endedAt, durationMs: endedAt - startedAt });
}

function withPrompt(run: RunSnapshot): RunSnapshot {
	return {
		...run,
		pendingPrompt: { id: `${run.id}-prompt`, kind: "confirm", message: "Continue?", createdAt: run.startedAt },
	};
}

function pickerOrder(runs: readonly RunSnapshot[]): string[] {
	return selectRunsForPicker(runs, "", true, NOW).map((row) => row.run.id);
}

function statusListOrder(runs: readonly RunSnapshot[], opts: Parameters<typeof renderStatusList>[1] = {}): string[] {
	const plain = renderStatusList(runs, { width: 200, now: NOW, ...opts }).replace(ANSI_RE, "");
	return runs
		.map((run) => ({ id: run.id, at: plain.indexOf(run.id) }))
		.filter((entry) => entry.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map((entry) => entry.id);
}

const surfaces: ReadonlyArray<readonly [string, (runs: readonly RunSnapshot[]) => string[]]> = [
	["picker", pickerOrder],
	["status list", (runs) => statusListOrder(runs)],
];

for (const [surface, order] of surfaces) {
	test(`${surface} ranks active runs: input or blocked, running, paused, then pending, newest first (#3824)`, () => {
		const runs = [
			makeRun({ id: "a-pending", status: "pending", startedAt: 900 }),
			makeRun({ id: "b-paused", status: "paused", startedAt: 940 }),
			makeRun({ id: "c-run-old", status: "running", startedAt: 950 }),
			withPrompt(makeRun({ id: "d-awaiting", status: "running", startedAt: 100 })),
			makeRun({ id: "e-quit", status: "paused", exitReason: "quit", startedAt: 945 }),
			makeRun({ id: "f-run-new", status: "running", startedAt: 960 }),
			makeRun({ id: "g-blocked", status: "blocked", startedAt: 200 }),
		];
		assert.deepEqual(order(runs), [
			"g-blocked",
			"d-awaiting",
			"f-run-new",
			"c-run-old",
			"e-quit",
			"b-paused",
			"a-pending",
		]);
	});

	test(`${surface} ranks a quit run with a stale prompt as paused, not awaiting input (#3824)`, () => {
		const runs = [
			withPrompt(makeRun({ id: "a-quit", status: "paused", exitReason: "quit", startedAt: 500 })),
			makeRun({ id: "b-running", status: "running", startedAt: 100 }),
		];
		assert.deepEqual(order(runs), ["b-running", "a-quit"]);
	});

	test(`${surface} ranks terminal runs: blocked, failed or killed, cancelled, skipped, completed (#3824)`, () => {
		const runs = [
			ended("a-completed", "completed", 10, 990),
			ended("b-skipped", "skipped", 10, 980),
			ended("c-cancelled", "cancelled", 10, 970),
			ended("d-killed", "killed", 10, 950),
			ended("e-failed", "failed", 10, 960),
			ended("f-blocked", "blocked", 10, 940),
		];
		assert.deepEqual(order(runs), ["f-blocked", "e-failed", "d-killed", "c-cancelled", "b-skipped", "a-completed"]);
	});

	test(`${surface} orders same-status terminal runs by latest end time (#3824)`, () => {
		const runs = [
			ended("a-failed-early-end", "failed", 900, 920),
			ended("b-failed-late-end", "failed", 100, 980),
			ended("c-failed-mid-end", "failed", 500, 950),
		];
		assert.deepEqual(order(runs), ["b-failed-late-end", "c-failed-mid-end", "a-failed-early-end"]);
	});

	test(`${surface} keeps active runs ahead of terminal runs regardless of status (#3824)`, () => {
		const runs = [
			ended("a-failed", "failed", 10, 990),
			makeRun({ id: "b-pending", status: "pending", startedAt: 20 }),
			ended("c-completed", "completed", 10, 995),
		];
		assert.deepEqual(order(runs), ["b-pending", "a-failed", "c-completed"]);
	});

	test(`${surface} keeps input order for runs that tie on status and time (#3824)`, () => {
		const runs = [
			makeRun({ id: "a-first", startedAt: 500 }),
			makeRun({ id: "b-second", startedAt: 500 }),
			makeRun({ id: "c-third", startedAt: 500 }),
		];
		assert.deepEqual(order(runs), ["a-first", "b-second", "c-third"]);
	});
}

function hiddenChildFixture(): { runs: RunSnapshot[]; visible: RunSnapshot[]; parent: RunSnapshot } {
	const older = makeRun({ id: "a-older", status: "running", startedAt: 100 });
	const parent = makeRun({ id: "b-parent", status: "running", startedAt: 200 });
	const newer = makeRun({ id: "c-newer", status: "running", startedAt: 300 });
	const child = withPrompt(
		makeRun({ id: "d-child", status: "running", startedAt: 250, parentRunId: parent.id, rootRunId: parent.id }),
	);
	const visible = [older, newer, parent];
	return { runs: [...visible, child], visible, parent };
}

test("picker ranks a run awaiting input through a hidden child first (#3824)", () => {
	const { runs } = hiddenChildFixture();
	assert.deepEqual(pickerOrder(runs), ["b-parent", "c-newer", "a-older"]);
});

test("status list ranks a run awaiting input through a hidden child first (#3824)", () => {
	const { runs, visible } = hiddenChildFixture();
	assert.deepEqual(statusListOrder(visible, { allRuns: runs }), ["b-parent", "c-newer", "a-older"]);
});

test("status list ranks by persisted indicator statuses without the full run collection (#3824)", () => {
	const { visible, parent } = hiddenChildFixture();
	assert.deepEqual(statusListOrder(visible, { indicatorStatuses: { [parent.id]: "awaiting_input" } }), [
		"b-parent",
		"c-newer",
		"a-older",
	]);
});
