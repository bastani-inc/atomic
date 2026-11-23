import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import {
	renderBoardRow,
	stateGlyph,
	type TaskBoardRow,
} from "../../packages/coding-agent/src/modes/interactive/components/task-board.js";
import { taskDisplayText } from "../../packages/coding-agent/src/modes/interactive/components/task-row.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";

beforeAll(() => {
	initTheme("dark");
});

test("a task that exactly fits its column is shown whole without truncation and fills the row width (#5224)", () => {
	const truncated: string[] = [];
	for (let width = 12; width < 40; width++) {
		const nameColumn = Math.min(14, Math.max(6, Math.floor((width - 6) / 3)));
		const room = width - 4 - nameColumn;
		const task = `${"t".repeat(room - 1)}Z`;
		const line = stripVTControlCharacters(
			renderBoardRow(
				{ id: "i", kind: "item", item: { id: "i", kind: "agent", state: "running", name: "abc", task } },
				false,
				width,
			),
		);
		if (!line.includes("Z") || visibleWidth(line) !== width) {
			truncated.push(`width=${width} room=${room} -> ${JSON.stringify(line)}`);
		}
	}
	assert.deepEqual(truncated, []);

	const wideNoMeta = stripVTControlCharacters(
		renderBoardRow(
			{
				id: "i-wide",
				kind: "item",
				item: { id: "i-wide", kind: "agent", state: "running", name: "abc", task: `${"t".repeat(61)}Z` },
			},
			false,
			80,
		),
	);
	assert.equal(wideNoMeta.endsWith("Z"), true);
	assert.equal(visibleWidth(wideNoMeta), 80);

	const narrowCjk = stripVTControlCharacters(
		renderBoardRow(
			{
				id: "i-narrow",
				kind: "item",
				item: { id: "i-narrow", kind: "agent", state: "queued", name: "\u0300ア", task: "中😀" },
			},
			false,
			10,
		),
	);
	assert.equal(visibleWidth(narrowCjk), 10);

	const pieces = [
		"a",
		"Z",
		" ",
		"中",
		"😀",
		"👩\u200d💻",
		"⚠\ufe0f",
		"e\u0301",
		"\u0300",
		"ｗ",
		"\u200b",
		"ア",
		"-",
		"\t",
	];
	const states = ["input", "running", "queued", "stopping", "done", "failed", "paused", "stopped"] as const;
	const kinds = ["agent", "shell"] as const;
	let seed = 42;
	const rand = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
	const sampleText = (maxLen: number) => {
		const count = Math.floor(rand() * maxLen);
		let out = "";
		for (let i = 0; i < count; i++) out += pieces[Math.floor(rand() * pieces.length)]!;
		return out;
	};
	for (let i = 0; i < 1000; i++) {
		const width = 10 + Math.floor(rand() * 190);
		const state = states[Math.floor(rand() * states.length)]!;
		const kind = kinds[Math.floor(rand() * kinds.length)]!;
		const row: TaskBoardRow = {
			id: `r:${i}`,
			kind: "item",
			item: {
				id: `r:${i}`,
				kind,
				state,
				name: sampleText(20) || "wf",
				task: sampleText(60),
				...(state === "input" ? { question: sampleText(60) || "Q?" } : {}),
				...(rand() < 0.5 ? { elapsedMs: Math.floor(rand() * 9_000_000) } : {}),
				...(rand() < 0.5 ? { tokens: Math.floor(rand() * 2_000_000_000) } : {}),
				...(rand() < 0.3 ? { progress: { done: Math.floor(rand() * 5), total: 5 } } : {}),
				...(state === "failed" && rand() < 0.5 ? { reason: sampleText(40) } : {}),
			},
		};
		const line = renderBoardRow(row, rand() < 0.5, width);
		assert.equal(visibleWidth(line), width, `seed=${i} width=${width}`);
	}
});

test("taskDisplayText preserves ZWJ and VS16 inside emoji sequences while removing unsafe controls (#5224)", () => {
	assert.equal(taskDisplayText("👩\u200d💻 dev"), "👩\u200d💻 dev");
	assert.equal(taskDisplayText("⚠\ufe0f Abort"), "⚠\ufe0f Abort");
	assert.equal(taskDisplayText("🏳\ufe0f\u200d🌈 flag"), "🏳\ufe0f\u200d🌈 flag");
	assert.equal(taskDisplayText("a\u200db\ufe0fc\u200bd\u202ee"), "abcde");
	assert.equal(taskDisplayText("a\u2028b\u2029c"), "a b c");
});

test("paused rows remain distinct from stopped rows (#5224)", () => {
	const row = (state: "paused" | "stopped"): TaskBoardRow => ({
		id: "run:release",
		kind: "item",
		item: { id: "run:release", kind: "agent", state, name: "release", task: "Build", elapsedMs: 5_000 },
	});
	const paused = stripVTControlCharacters(renderBoardRow(row("paused"), true, 80));
	const stopped = stripVTControlCharacters(renderBoardRow(row("stopped"), true, 80));
	assert.match(paused, /∀ ‖ release.*paused · 5s$/);
	assert.match(stopped, /∀ ◯ release.*stopped · 5s$/);
});

test("settled resumable subagents display stopped consistently with their panel rows (#5224)", () => {
	for (const cause of ["pause", "quit"] as const) {
		const task = taskRecord(`resumable-${cause}`);
		task.execution = { kind: "settled", result: { kind: "cancelled", cause, output: task.output } };
		const text = stripVTControlCharacters(renderBoardRow({ id: task.ref.taskId, kind: "task", task }, true, 160));
		assert.match(text, /∀ ◯.*stopped/);
		assert.doesNotMatch(text, /‖|paused/);
	}
});

test("task rows omit invalid metrics and progress instead of displaying non-finite or negative numbers (#5224)", () => {
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5_000, 1e20]) {
		const line = stripVTControlCharacters(
			renderBoardRow(
				{
					id: "run:invalid",
					kind: "item",
					item: {
						id: "run:invalid",
						kind: "agent",
						state: "running",
						name: "release",
						task: "Build",
						elapsedMs: value,
						tokens: value,
						progress: { done: value, total: value },
					},
				},
				true,
				160,
			),
		);
		assert.equal(line.trimEnd(), "∀ ◯ release       Build", `invalid value ${value}`);
	}
});

test("a failed extension row shows its failure reason only once (#5224)", () => {
	const row: TaskBoardRow = {
		id: "run:failed",
		kind: "item",
		item: {
			id: "run:failed",
			kind: "agent",
			state: "failed",
			name: "release",
			task: "Build failed",
			reason: "Build failed",
		},
	};
	const text = stripVTControlCharacters(renderBoardRow(row, true, 160));
	assert.equal(text.match(/Build failed/g)?.length, 1);
});

test("running shell rows render with ⧗ in /tasks while agents render with an open circle (#5224)", () => {
	assert.deepEqual(stateGlyph("running", "shell"), { glyph: "⧗", color: "accent" });
	assert.deepEqual(stateGlyph("running", "command"), { glyph: "⧗", color: "accent" });
	assert.deepEqual(stateGlyph("running", "agent"), { glyph: "◯", color: "muted" });
	assert.deepEqual(stateGlyph("running"), { glyph: "◯", color: "muted" });

	const shellTask = taskRecord("shell-1", "command");
	shellTask.title = "azure-ci run 5222";
	const shellTaskRow: TaskBoardRow = { id: shellTask.ref.taskId, kind: "task", task: shellTask };
	assert.match(stripVTControlCharacters(renderBoardRow(shellTaskRow, false, 80)), /^ {2}⧗ shell +azure-ci run 5222/);

	const shellItemRow: TaskBoardRow = {
		id: "ext:shell-1",
		kind: "item",
		item: { id: "ext:shell-1", kind: "shell", state: "running", name: "shell", task: "sleep 60", elapsedMs: 9_000 },
	};
	assert.match(stripVTControlCharacters(renderBoardRow(shellItemRow, false, 80)), /^ {2}⧗ shell +sleep 60 +9s$/);
});
