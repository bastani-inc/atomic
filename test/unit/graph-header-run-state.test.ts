/**
 * Run-level state on the `/workflow` graph page and every other surface that
 * shows a run's state (#4643): the graph header and its compact widget trailer,
 * the status/session list, the connect picker and the stage switcher.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";
import { runStateColor, runStateIndicator } from "../../packages/workflows/src/tui/run-state-indicator.js";
import { createSessionPickerState, renderSessionPicker } from "../../packages/workflows/src/tui/session-picker.js";
import { statusColor, statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { renderSwitcher } from "../../packages/workflows/src/tui/switcher.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { assertVisibleWidths, defaultTheme, makePendingPrompt, makeStage, makeStore } from "./overlay-graph-helpers.js";

const theme = defaultTheme;
const NOW = 1_800_000_000_000;
const RUN_ID = "4643a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5b";
const REASON = "waiting for review approval";
const WIDE = 120;
const NARROW = 40;
const RUN_STATE_LABELS = ["↑ blocked", "❚❚ paused", "○ quit", "● resumed"] as const;

function stage(id: string, status: StageSnapshot["status"]): StageSnapshot {
	return { ...makeStage(id), status };
}

function run(over: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: RUN_ID,
		name: "blocked-demo",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [stage("prepare", "completed")],
		startedAt: NOW - 60_000,
		...over,
	};
}

const blockedExit = run({
	status: "blocked",
	exited: true,
	exitReason: REASON,
	endedAt: NOW - 1_000,
	durationMs: 59_000,
	resumable: false,
});
const blockedExitWithoutReason = run({ status: "blocked", exited: true, endedAt: NOW - 1_000, resumable: false });
const budgetStop = run({
	status: "running",
	endedAt: NOW - 1_000,
	blockedAt: NOW - 1_000,
	error: "atomic-workflows: duration budget exceeded (61000ms / 60000ms) at prepare",
	failureMessage: "atomic-workflows: duration budget exceeded (61000ms / 60000ms) at prepare",
	failureRecoverability: "recoverable",
	failureDisposition: "active_blocked",
	resumable: true,
	result: { status: "budget_exceeded" },
	budgetState: { systemOwnedStop: true },
});
const paused = run({ status: "paused", pausedAt: NOW - 1_000, resumable: true });
const quit = run({ status: "paused", pausedAt: NOW - 1_000, quitAt: NOW - 1_000, exitReason: "quit", resumable: true });
const resumedAfterPause = run({
	stages: [stage("prepare", "completed"), stage("finish", "running")],
	resumedAt: NOW - 1_000,
	resumeSource: "run_control",
	resumeActor: "user",
});
const resumedFromBlock = run({
	stages: [stage("prepare", "completed"), stage("finish", "running")],
	resumeSource: "run_control",
	resumeActor: "user",
	resumedFromRunId: RUN_ID,
});
const running = run({ stages: [stage("prepare", "completed"), stage("finish", "running")] });

interface Fixture {
	readonly run: RunSnapshot;
	readonly label?: (typeof RUN_STATE_LABELS)[number];
	readonly color?: string;
}

const FIXTURES: Readonly<Record<string, Fixture>> = {
	"ctx.exit blocked with a reason": { run: blockedExit, label: "↑ blocked", color: statusColor("blocked", theme) },
	"ctx.exit blocked without a reason": {
		run: blockedExitWithoutReason,
		label: "↑ blocked",
		color: statusColor("blocked", theme),
	},
	"resumable budget_exceeded stop": { run: budgetStop, label: "↑ blocked", color: statusColor("blocked", theme) },
	paused: { run: paused, label: "❚❚ paused", color: statusColor("paused", theme) },
	quit: { run: quit, label: "○ quit", color: statusColor("paused", theme) },
	"resumed after a pause": { run: resumedAfterPause },
	"resumed from a stop": { run: resumedFromBlock },
	running: { run: running },
};

/** The ANSI foreground the ORCHESTRATOR pill's top-left corner is drawn in. */
function pillBorder(lines: readonly string[]): string | undefined {
	return /(\x1b\[38;2;\d+;\d+;\d+m)╭/.exec(lines[0] ?? "")?.[1];
}

function plain(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function headerMid(target: RunSnapshot, width: number): string {
	const lines = renderHeader(target, { width, theme });
	assert.equal(lines.length, 3);
	assertVisibleWidths(lines, width);
	return plain(lines[1]!);
}

function graphView(target: RunSnapshot, mode: "widget" | "overlay"): GraphView {
	return new GraphView({
		piKeybindings: makeFakeKeybindings(),
		mode,
		runId: target.id,
		store: makeStore({ runs: [target], notices: [], version: 1 }),
		graphTheme: theme,
	});
}

function widgetTrailer(target: RunSnapshot, width = WIDE): string {
	const view = graphView(target, "widget");
	try {
		const lines = view.render(width);
		assert.equal(lines.length, 4);
		return lines[3]!;
	} finally {
		view.dispose();
	}
}

function switcherTitle(target: RunSnapshot): string | undefined {
	const view = graphView(target, "overlay");
	try {
		view.handleInput("/");
		const lines = view.render(WIDE).map(plain);
		const stagesRow = lines.findIndex((line) => line.includes("STAGES"));
		assert.ok(stagesRow > 0, "the switcher is open");
		const top = lines[stagesRow - 1]!;
		return RUN_STATE_LABELS.find((label) => top.includes(`╭─ ${label} ─`));
	} finally {
		view.dispose();
	}
}

function statusListRow(target: RunSnapshot): string {
	const out = renderStatusList([target], { theme, width: 100, now: NOW });
	const row = out.split("\n").find((line) => plain(line).includes(target.name));
	assert.ok(row !== undefined, "the status card names the run");
	return row;
}

const OTHER_RUN = run({ id: "other-run-id", name: "other-workflow" });

/** Render the picker with another run selected, so the target row keeps its own colours. */
function pickerRows(target: RunSnapshot): { readonly idRow: string; readonly nameRow: string } {
	const lines = renderSessionPicker({
		width: 100,
		theme,
		rows: [
			{ run: OTHER_RUN, bucket: "active" },
			{ run: target, bucket: target.endedAt === undefined ? "active" : "terminal" },
		],
		state: createSessionPickerState(),
		allRuns: [OTHER_RUN, target],
		now: NOW,
	});
	const idRow = lines.find((line) => plain(line).includes(target.id));
	const nameRow = lines.find((line) => plain(line).startsWith(`│   ${target.name.slice(0, 12)}`));
	assert.ok(idRow !== undefined && nameRow !== undefined, "the picker lists the run");
	return { idRow, nameRow };
}

test("renderHeader adds a ↑ N blocked-stage badge in the stage badge order (#4643)", () => {
	const target = run({
		stages: [
			stage("done", "completed"),
			stage("work", "running"),
			stage("hold", "paused"),
			stage("gate-a", "blocked"),
			stage("gate-b", "blocked"),
			stage("released", "suspended"),
			stage("next", "pending"),
			stage("broken", "failed"),
		],
	});
	const lines = renderHeader(target, { width: WIDE, theme });
	assertVisibleWidths(lines, WIDE);
	assert.match(plain(lines[1]!), /✓ 1 {2}● 1 {2}❚❚ 1 {2}↑ 2 {2}◷ 1 {2}○ 1 {2}✗ 1 {2}$/);
	assert.ok(lines[1]!.includes(`${hexToAnsi(statusColor("blocked", theme))}${statusIcon("blocked")} 2`));
	assert.doesNotMatch(headerMid(run(), WIDE), /↑/);
});

for (const width of [WIDE, NARROW]) {
	test(`renderHeader shows a ctx.exit blocked run with its pill colour and ↑ blocked badge at ${width} columns (#4643)`, () => {
		const lines = renderHeader(blockedExit, { width, theme });
		assertVisibleWidths(lines, width);
		assert.equal(pillBorder(lines), hexToAnsi(statusColor("blocked", theme)));
		assert.ok(lines[1]!.includes(`${hexToAnsi(statusColor("blocked", theme))}↑ blocked:`));
		assert.match(plain(lines[1]!), /✓ 1 {2}$/);
	});

	test(`renderHeader shows a blocked run without a reason as ↑ blocked at ${width} columns (#4643)`, () => {
		for (const target of [blockedExitWithoutReason, budgetStop, run({ status: "blocked", exitReason: "  " })]) {
			const lines = renderHeader(target, { width, theme });
			assertVisibleWidths(lines, width);
			assert.equal(pillBorder(lines), hexToAnsi(statusColor("blocked", theme)));
			assert.match(plain(lines[1]!), /↑ blocked {2}✓ 1 {2}$/);
		}
	});

	test(`renderHeader shows a resumed live run like any running run, with no resumed label, at ${width} columns`, () => {
		for (const target of [resumedAfterPause, resumedFromBlock]) {
			const lines = renderHeader(target, { width, theme });
			assertVisibleWidths(lines, width);
			assert.doesNotMatch(plain(lines[1]!), /resumed/);
			assert.match(plain(lines[1]!), /✓ 1 {2}● 1 {2}$/);
		}
	});

	test(`renderHeader shows a paused run as ❚❚ paused and a quit run as ○ quit at ${width} columns (#4643)`, () => {
		for (const [target, label] of [
			[paused, "❚❚ paused"],
			[quit, "○ quit"],
		] as const) {
			const lines = renderHeader(target, { width, theme });
			assertVisibleWidths(lines, width);
			assert.equal(pillBorder(lines), hexToAnsi(statusColor("paused", theme)));
			assert.ok(lines[1]!.includes(`${hexToAnsi(statusColor("paused", theme))}${label}`));
			assert.match(plain(lines[1]!), new RegExp(`${label} {2}✓ 1 {2}$`));
			assert.doesNotMatch(plain(lines[1]!), /↑ blocked|● resumed/);
		}
	});

	test(`renderHeader keeps a running run's accent pill and adds no run-level badge at ${width} columns (#4643)`, () => {
		const lines = renderHeader(running, { width, theme });
		assertVisibleWidths(lines, width);
		assert.equal(pillBorder(lines), hexToAnsi(theme.accent));
		assert.match(plain(lines[1]!), /ORCHESTRATOR │ {2}blocked-de\S* *✓ 1 {2}● 1 {2}$/);
	});
}

test("renderHeader shows the whole exit reason and run name when they fit (#4643)", () => {
	assert.match(
		headerMid(blockedExit, WIDE),
		/ORCHESTRATOR │ {2}blocked-demo +↑ blocked: waiting for review approval {2}✓ 1 {2}$/,
	);
});

test("renderHeader truncates the exit reason to the 40-column minimum (#4643)", () => {
	assert.match(headerMid(blockedExit, NARROW), /↑ blocked: w… {2}✓ 1 {2}$/);
});

test("renderHeader keeps the run name beside a long exit reason and ends the reason with … (#4643)", () => {
	const target = run({ ...blockedExit, exitReason: `${"needs a maintainer decision ".repeat(12)}end` });
	const mid = headerMid(target, WIDE);
	assert.match(mid, /ORCHESTRATOR │ {2}blocked-demo {2}↑ blocked: needs a maintainer decision .*… {2}✓ 1 {2}$/);
	assert.doesNotMatch(mid, /end {2}✓/);
});

test("renderHeader drops a reason that has no room for one character at the 40-column minimum (#4643)", () => {
	const twoBadges = run({ ...blockedExit, stages: [stage("a", "completed"), stage("b", "failed")] });
	assert.match(headerMid(twoBadges, NARROW), /↑ blocked {2}✓ 1 {2}✗ 1 {2}$/);
	const tenDone = run({
		...blockedExit,
		stages: Array.from({ length: 10 }, (_, index) => stage(`s${index}`, "completed")),
	});
	assert.match(headerMid({ ...tenDone, exitReason: "x" }, NARROW), /↑ blocked: x {2}✓ 10 {2}$/);
	assert.match(headerMid({ ...tenDone, exitReason: "xy" }, NARROW), /↑ blocked {2}✓ 10 {2}$/);
});

test("renderHeader shows a multi-line exit reason on one line without terminal controls (#4643)", () => {
	const target = run({ ...blockedExit, exitReason: "line one\nline two\x1b[31m" });
	const lines = renderHeader(target, { width: WIDE, theme });
	assertVisibleWidths(lines, WIDE);
	assert.ok(lines[1]!.includes("↑ blocked: line one line two\\x1b[31m"));
	assert.equal(lines.join("").includes("\n"), false);
});

test("renderHeader never labels a run resumed, whatever its state", () => {
	const completed = run({ ...resumedFromBlock, status: "completed", endedAt: NOW - 1_000 });
	assert.doesNotMatch(headerMid(completed, WIDE), /resumed/);
	assert.equal(pillBorder(renderHeader(completed, { width: WIDE, theme })), hexToAnsi(theme.success));
	assert.doesNotMatch(headerMid({ ...resumedFromBlock, endedAt: NOW - 1_000 }, WIDE), /resumed/);
	assert.match(headerMid({ ...resumedFromBlock, status: "paused" }, WIDE), /❚❚ paused/);
	const blockedAgain = run({ ...budgetStop, resumeSource: "run_control", resumedFromRunId: RUN_ID });
	assert.match(headerMid(blockedAgain, WIDE), /↑ blocked {2}✓ 1/);
	assert.doesNotMatch(headerMid(blockedAgain, WIDE), /resumed/);
	assert.doesNotMatch(headerMid({ ...running, resumeSource: "run_control" }, WIDE), /resumed/);
	assert.doesNotMatch(headerMid({ ...running, resumedFromRunId: RUN_ID }, WIDE), /resumed/);
	assert.doesNotMatch(headerMid({ ...running, resumeSource: "prompt_answer" }, WIDE), /resumed/);
	assert.doesNotMatch(
		headerMid({ ...running, resumedAt: NOW - 1_000, resumeSource: "prompt_answer" }, WIDE),
		/resumed/,
	);
	for (const status of ["failed", "killed", "cancelled", "pending"] as const) {
		assert.equal(runStateIndicator({ ...resumedFromBlock, status, resumedAt: NOW - 1_000 }), undefined, status);
	}
});

test("runStateIndicator classifies run-level states with the status glyphs (#4643)", () => {
	assert.deepEqual(runStateIndicator(blockedExit), { kind: "blocked", glyph: "↑", text: "↑ blocked", reason: REASON });
	assert.deepEqual(runStateIndicator(budgetStop), { kind: "blocked", glyph: "↑", text: "↑ blocked" });
	assert.deepEqual(runStateIndicator(paused), { kind: "paused", glyph: "❚❚", text: "❚❚ paused" });
	assert.deepEqual(runStateIndicator(quit), { kind: "quit", glyph: "○", text: "○ quit" });
	assert.equal(runStateIndicator(resumedFromBlock), undefined);
	assert.equal(runStateIndicator(resumedAfterPause), undefined);
	assert.equal(runStateIndicator(running), undefined);
	assert.equal(runStateIndicator(run({ status: "paused", exitReason: "quit", endedAt: NOW }))?.kind, "paused");
	assert.equal(runStateIndicator(run({ status: "running", exitReason: "quit" })), undefined);
	assert.equal(
		runStateIndicator(run({ status: "completed", endedAt: NOW, result: { status: "needs_human" } }))?.kind,
		"blocked",
	);
	for (const [kind, status] of [
		["blocked", "blocked"],
		["paused", "paused"],
		["quit", "paused"],
	] as const) {
		assert.equal(runStateColor({ kind, glyph: "", text: "" }, theme), statusColor(status, theme), kind);
	}
});

test("graph header, widget trailer, status list, picker and switcher agree on the run state (#4643)", () => {
	for (const [name, { run: target, label, color }] of Object.entries(FIXTURES)) {
		const header = renderHeader(target, { width: WIDE, theme })[1]!;
		const trailer = widgetTrailer(target);
		const listRow = statusListRow(target);
		const picker = pickerRows(target);
		const switcher = switcherTitle(target);
		if (label === undefined || color === undefined) {
			for (const surface of [header, trailer, picker.nameRow]) {
				for (const other of RUN_STATE_LABELS)
					assert.equal(plain(surface).includes(other), false, `${name}: ${other}`);
			}
			assert.match(plain(listRow), /● running/, name);
			assert.equal(switcher, undefined, name);
			continue;
		}
		const styled = `${hexToAnsi(color)}${label}`;
		assert.ok(header.includes(styled), `${name}: header`);
		assert.ok(trailer.includes(styled), `${name}: widget trailer`);
		assert.ok(listRow.includes(styled), `${name}: status list`);
		assert.ok(picker.nameRow.includes(styled), `${name}: picker`);
		assert.equal(switcher, label, `${name}: switcher`);
		assert.ok(plain(picker.idRow).startsWith(`│ ${label.split(" ")[0]} `), `${name}: picker glyph`);
	}
});

test("the widget trailer leads with the run state and fits the width (#4643)", () => {
	assert.equal(plain(widgetTrailer(blockedExit)), " ↑ blocked · 1/1 done");
	assert.equal(plain(widgetTrailer(resumedFromBlock)), " 1/2 done · 1 running");
	assert.equal(plain(widgetTrailer(running)), " 1/2 done · 1 running");
	const narrow = widgetTrailer(
		run({ ...paused, stages: [stage("a", "running"), stage("b", "failed"), stage("c", "blocked")] }),
		NARROW,
	);
	assert.equal(plain(narrow), " ❚❚ paused · 0/3 done · 1 running · 1 f…");
});

test("the picker shows the run state beside the elapsed time and keeps the row width (#4643)", () => {
	assert.match(plain(pickerRows(blockedExit).nameRow), /^│ {3}blocked-demo +↑ blocked {7}59s │$/);
	assert.match(plain(pickerRows(running).nameRow), /^│ {3}blocked-demo +1m │$/);
});

test("the picker shortens a long run name to keep the run state and elapsed time (#4643)", () => {
	const longName = "n".repeat(85);
	assert.match(plain(pickerRows({ ...blockedExit, name: longName }).nameRow), /^│ {3}n{73}… ↑ blocked {7}59s │$/);
	assert.match(plain(pickerRows({ ...running, name: longName }).nameRow), /^│ {3}n{85} {7}1m │$/);
});

test("the picker keeps the awaiting-input glyph for a resumed run waiting on a prompt (#4643)", () => {
	const awaiting = run({ ...resumedFromBlock, pendingPrompt: makePendingPrompt({ createdAt: NOW - 1_000 }) });
	const { idRow, nameRow } = pickerRows(awaiting);
	assert.ok(plain(idRow).startsWith(`│ ${statusIcon("awaiting_input")} `));
	assert.ok(idRow.includes(hexToAnsi(statusColor("awaiting_input", theme))));
	assert.doesNotMatch(plain(nameRow), /resumed/);
});

test("renderSwitcher titles its border with the run state and keeps narrow borders closed (#4643)", () => {
	const stages = [stage("prepare", "completed")];
	const state = { query: "", selectedIndex: 0 };
	const titled = renderSwitcher(stages, state, { width: 40, theme, runState: runStateIndicator(blockedExit) });
	assertVisibleWidths(titled, 40);
	assert.equal(plain(titled[0]!), `╭─ ↑ blocked ${"─".repeat(26)}╮`);
	assert.ok(titled[0]!.includes(`${hexToAnsi(statusColor("blocked", theme))} ↑ blocked `));
	assert.equal(plain(renderSwitcher(stages, state, { width: 40, theme })[0]!), `╭${"─".repeat(38)}╮`);
	const tiny = renderSwitcher(stages, state, { width: 8, theme, runState: runStateIndicator(quit) });
	assert.equal(plain(tiny[0]!), "╭─ ○ qu╮");
	assert.equal(plain(tiny[0]!).length, 8);
});
