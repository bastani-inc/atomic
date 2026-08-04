/**
 * Unit tests for src/tui/session-picker.ts — selection logic, key handling,
 * and a render-smoke test (no thrown errors, expected content present).
 */
import assert from "node:assert/strict";

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	isWorkflowRunResumable,
	type WorkflowRunResumeCandidate,
} from "../../packages/workflows/src/durable/resume-eligibility.ts";
import type { RunSnapshot, StoreSnapshot } from "../../packages/workflows/src/shared/store-types.ts";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.ts";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import {
	createSessionPickerResumeCandidateCache,
	createSessionPickerState,
	handleSessionPickerInput,
	renderSessionPicker,
	selectRunsForPicker,
} from "../../packages/workflows/src/tui/session-picker.ts";
import { statusColor, statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.ts";

function makeRun(over: Partial<RunSnapshot>): RunSnapshot {
	return {
		id: over.id ?? "00000000-0000-0000-0000-000000000000",
		name: over.name ?? "demo",
		inputs: over.inputs ?? {},
		status: over.status ?? "running",
		stages: over.stages ?? [],
		startedAt: over.startedAt ?? 1000,
		endedAt: over.endedAt,
		durationMs: over.durationMs,
		result: over.result,
		error: over.error,
		resumable: over.resumable,
		failureRecoverability: over.failureRecoverability,
		exitReason: over.exitReason,
	};
}

test("selectRunsForPicker buckets active vs retained terminal by default", () => {
	const now = 10_000_000;
	const hourMs = 60 * 60 * 1000;
	const runs: RunSnapshot[] = [
		makeRun({ id: "a-active", status: "running", startedAt: now - 1000 }),
		makeRun({ id: "b-recent", status: "completed", startedAt: now - 5000, endedAt: now - 1000, durationMs: 4000 }),
		makeRun({
			id: "c-old",
			status: "completed",
			startedAt: now - hourMs * 4,
			endedAt: now - hourMs * 3,
			durationMs: hourMs,
		}),
	];
	const rows = selectRunsForPicker(runs, "", true, now);
	assert.deepEqual(
		rows.map((r) => r.run.id),
		["a-active", "b-recent", "c-old"],
	);
	assert.deepEqual(
		rows.map((r) => r.bucket),
		["active", "terminal", "terminal"],
	);

	const legacyRecentOnly = selectRunsForPicker(runs, "", false, now);
	assert.deepEqual(
		legacyRecentOnly.map((r) => r.run.id),
		["a-active", "b-recent"],
	);
});

test("resume picker inclusion agrees with the shared resumability predicate across run states", () => {
	const statuses: RunSnapshot["status"][] = ["failed", "running", "paused", "completed", "killed"];
	const endedValues: Array<number | undefined> = [undefined, 2_000];
	const resumableValues: Array<boolean | undefined> = [undefined, false, true];
	const recoverabilityValues: Array<RunSnapshot["failureRecoverability"]> = [undefined, "recoverable"];
	const exitReasons: Array<string | undefined> = [undefined, "quit"];
	let index = 0;
	for (const status of statuses) {
		for (const endedAt of endedValues) {
			for (const resumable of resumableValues) {
				for (const failureRecoverability of recoverabilityValues) {
					for (const exitReason of exitReasons) {
						const run = makeRun({
							id: `resume-${index++}`,
							status,
							endedAt,
							resumable,
							failureRecoverability,
							exitReason,
						});
						// The picker derives `hasPausedState` from the snapshot exactly as the
						// resume command does, so both sides consult one predicate.
						const hasPausedState = status === "paused" || exitReason === "quit";
						const expected = isWorkflowRunResumable({ ...run, hasPausedState });
						const rows = selectRunsForPicker([run], "", true, Date.now(), "resume");
						assert.equal(
							rows.length === 1,
							expected,
							`${status}/${endedAt}/${resumable}/${failureRecoverability}/${exitReason}`,
						);
					}
				}
			}
		}
	}
});

test("a paused run whose artifacts were pruned is not resumable", () => {
	const paused = makeRun({ id: "pruned-artifacts", status: "paused", resumable: true });
	assert.equal(isWorkflowRunResumable({ ...paused, hasPausedState: true }), true);
	assert.equal(isWorkflowRunResumable({ ...paused, hasPausedState: true, artifactsIntact: false }), false);
	assert.equal(isWorkflowRunResumable({ ...paused, hasPausedState: true, hasDurableCheckpoint: false }), false);
});

test("resume picker production filtering hides a run whose referenced artifact directory is missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-picker-artifact-root-"));
	const runId = "artifact-aware-run";
	const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
	try {
		process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
		const referenced = join(root, "runs", runId, "transcripts", "stage.transcript.md");
		const run = makeRun({
			id: runId,
			status: "paused",
			resumable: true,
			result: { transcript_path: referenced },
		});
		assert.equal(selectRunsForPicker([run], "", true, Date.now(), "resume").length, 0);
		await mkdir(join(root, "runs", runId), { recursive: true });
		assert.equal(selectRunsForPicker([run], "", true, Date.now(), "resume").length, 1);
	} finally {
		if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("resume candidate probes are memoized across selections within one store revision", () => {
	const runs = [
		makeRun({ id: "cache-a", status: "paused", resumable: true }),
		makeRun({ id: "cache-b", status: "paused", resumable: true }),
	];
	const snapshot: StoreSnapshot = { runs, notices: [], version: 7 };
	let probeCount = 0;
	const probe = (run: RunSnapshot): WorkflowRunResumeCandidate => {
		probeCount += 1;
		return {
			status: run.status,
			endedAt: run.endedAt,
			resumable: run.resumable,
			failureRecoverability: run.failureRecoverability,
			exitReason: run.exitReason,
			hasPausedState: true,
			hasDurableCheckpoint: true,
		};
	};
	const cache = createSessionPickerResumeCandidateCache(probe);
	const now = 10_000;
	const baseline = selectRunsForPicker(runs, "", true, now, "resume");
	const first = selectRunsForPicker(runs, "", true, now, "resume", cache(snapshot));
	const second = selectRunsForPicker(runs, "", true, now, "resume", cache(snapshot));

	assert.equal(JSON.stringify(first), JSON.stringify(baseline));
	assert.equal(JSON.stringify(second), JSON.stringify(baseline));
	assert.equal(probeCount, runs.length, "render and input selections share one probe per run");

	selectRunsForPicker(runs, "", true, now, "resume", cache({ ...snapshot, version: 8 }));
	assert.equal(probeCount, runs.length * 2, "a store revision invalidates the cached probes");
});

test("cached resume selection keeps the offered rows byte-identical", () => {
	const runs = [makeRun({ id: "byte-identical", status: "paused", resumable: true })];
	const snapshot: StoreSnapshot = { runs, notices: [], version: 12 };
	const cache = createSessionPickerResumeCandidateCache((run) => ({
		status: run.status,
		endedAt: run.endedAt,
		resumable: run.resumable,
		failureRecoverability: run.failureRecoverability,
		exitReason: run.exitReason,
		hasPausedState: true,
		hasDurableCheckpoint: true,
	}));
	const baseline = selectRunsForPicker(runs, "", true, 10_000, "resume");
	const cached = selectRunsForPicker(runs, "", true, 10_000, "resume", cache(snapshot));
	assert.equal(JSON.stringify(cached), JSON.stringify(baseline));
});

test("connect picker remains broad while resume hides a completed run", () => {
	const completed = makeRun({ id: "completed", status: "completed", endedAt: 2_000 });
	assert.equal(selectRunsForPicker([completed], "", true, Date.now(), "connect").length, 1);
	assert.equal(selectRunsForPicker([completed], "", true, Date.now(), "resume").length, 0);
});

test("resume picker lists a resumable paused run and hides a non-resumable one", () => {
	const resumablePaused = makeRun({ id: "resumable-paused", status: "paused", resumable: true });
	const refusedPaused = makeRun({ id: "refused-paused", status: "paused", resumable: false });
	const rows = selectRunsForPicker([resumablePaused, refusedPaused], "", true, Date.now(), "resume");
	assert.deepEqual(
		rows.map((row) => row.run.id),
		["resumable-paused"],
	);
});

test("selectRunsForPicker filters by name and runId prefix", () => {
	const runs: RunSnapshot[] = [
		makeRun({ id: "abc12345-0000-0000-0000-000000000000", name: "tournament" }),
		makeRun({ id: "def67890-0000-0000-0000-000000000000", name: "deep-research" }),
	];
	assert.equal(selectRunsForPicker(runs, "tournament", true).length, 1);
	assert.equal(selectRunsForPicker(runs, "research", true).length, 1);
	assert.equal(selectRunsForPicker(runs, "abc", true)[0]?.run.name, "tournament");
	assert.equal(selectRunsForPicker(runs, "zzz", true).length, 0);
});

test("handleSessionPickerInput: enter on selected row returns connect", () => {
	const state = createSessionPickerState();
	const rows = [
		{ run: makeRun({ id: "id-1", name: "a" }), bucket: "active" as const },
		{ run: makeRun({ id: "id-2", name: "b" }), bucket: "active" as const },
	];
	const action = handleSessionPickerInput("\r", state, rows);
	assert.deepEqual(action, { kind: "connect", runId: "id-1" });
});

test("handleSessionPickerInput: arrows navigate and x has no workflow action", () => {
	const state = createSessionPickerState();
	const rows = [
		{ run: makeRun({ id: "id-1" }), bucket: "active" as const },
		{ run: makeRun({ id: "id-2" }), bucket: "active" as const },
	];
	handleSessionPickerInput("\x1b[B", state, rows);
	assert.equal(state.selectedIndex, 1);
	assert.deepEqual(handleSessionPickerInput("x", state, rows), { kind: "noop" });
});

test("handleSessionPickerInput: x is a no-op on terminal rows", () => {
	const state = createSessionPickerState();
	const rows = [{ run: makeRun({ id: "id-1", status: "completed", endedAt: 2000 }), bucket: "terminal" as const }];
	const action = handleSessionPickerInput("x", state, rows);
	assert.deepEqual(action, { kind: "noop" });
});

test("handleSessionPickerInput: / enters filter mode and types into query", () => {
	const state = createSessionPickerState();
	const rows = [{ run: makeRun({ id: "id-1" }), bucket: "active" as const }];
	handleSessionPickerInput("/", state, rows);
	assert.equal(state.filterFocused, true);
	handleSessionPickerInput("r", state, rows);
	handleSessionPickerInput("a", state, rows);
	assert.equal(state.query, "ra");
	// Backspace removes a char.
	handleSessionPickerInput("\x7f", state, rows);
	assert.equal(state.query, "r");
	// Enter exits filter mode without firing connect.
	const action = handleSessionPickerInput("\r", state, rows);
	assert.deepEqual(action, { kind: "noop" });
	assert.equal(state.filterFocused, false);
});

test("handleSessionPickerInput: double esc exits filter mode", () => {
	const state = createSessionPickerState();
	const rows = [{ run: makeRun({ id: "id-1" }), bucket: "active" as const }];
	handleSessionPickerInput("/", state, rows);
	assert.equal(state.filterFocused, true);
	assert.deepEqual(handleSessionPickerInput("\x1b\x1b", state, rows), { kind: "noop" });
	assert.equal(state.filterFocused, false);
});

test("handleSessionPickerInput: a toggles includeAll", () => {
	const state = createSessionPickerState();
	assert.equal(state.includeAll, true);
	handleSessionPickerInput("a", state, []);
	assert.equal(state.includeAll, false);
	handleSessionPickerInput("a", state, []);
	assert.equal(state.includeAll, true);
});

test("handleSessionPickerInput: esc variants close", () => {
	for (const key of ["\x1b", "\x1b[27u", "\x1b[27;1;27~"]) {
		const state = createSessionPickerState();
		const action = handleSessionPickerInput(key, state, []);
		assert.deepEqual(action, { kind: "close" }, JSON.stringify(key));
	}
});

test("renderSessionPicker emits header, sections, and footer hints", () => {
	const theme = deriveGraphTheme({});
	const state = createSessionPickerState();
	const rows = [
		{ run: makeRun({ id: "aaaa1111-0000-0000-0000-000000000000", name: "tournament" }), bucket: "active" as const },
		{
			run: makeRun({
				id: "bbbb2222-0000-0000-0000-000000000000",
				name: "deep-research",
				status: "completed",
				endedAt: 2000,
			}),
			bucket: "terminal" as const,
		},
	];
	const lines = renderSessionPicker({ width: 80, theme, rows, state });
	const joined = lines.join("\n");
	assert.match(joined, /Connect to workflow run/);
	assert.match(joined, /ACTIVE/);
	assert.match(joined, /TERMINAL/);
	assert.match(joined, /aaaa1111-0000-0000-0000-000000000000/);
	assert.match(joined, /tournament/);
	assert.match(joined, /Navigate/);
	assert.match(joined, /Connect/);
	assert.doesNotMatch(joined, /Kill/);
});

test("renderSessionPicker uses the awaiting-input glyph and info colour for a prompted run", () => {
	const theme = deriveGraphTheme({});
	const awaiting = makeRun({
		id: "awaiting111-0000-0000-0000-000000000000",
		name: "awaiting-workflow",
		stages: [
			{
				id: "ask",
				name: "ask",
				status: "awaiting_input",
				parentIds: [],
				toolEvents: [],
			},
		],
	});
	const rows = [
		{ run: makeRun({ id: "other111-0000-0000-0000-000000000000" }), bucket: "active" as const },
		{ run: awaiting, bucket: "active" as const },
	];
	const state = createSessionPickerState();
	const joined = renderSessionPicker({ width: 100, theme, rows, state, allRuns: [rows[0]!.run, awaiting] })
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(joined, new RegExp(`${statusIcon("awaiting_input")} awaiting111`));
	assert.ok(
		renderSessionPicker({ width: 100, theme, rows, state, allRuns: [rows[0]!.run, awaiting] })
			.join("\n")
			.includes(hexToAnsi(statusColor("awaiting_input", theme))),
	);
});

test("renderSessionPicker keeps paused quit treatment when the run carries a pending prompt", () => {
	const theme = deriveGraphTheme({});
	const quit: RunSnapshot = {
		...makeRun({
			id: "quit-picker-prompt",
			name: "resume-me",
			status: "paused",
			exitReason: "quit",
			resumable: true,
		}),
		pendingPrompt: {
			id: "quit-picker-prompt-id",
			kind: "confirm",
			message: "Continue?",
			createdAt: 900,
		},
	};
	const other = makeRun({ id: "other-picker-run", name: "other-workflow" });
	const rows = [
		{ run: other, bucket: "active" as const },
		{ run: quit, bucket: "active" as const },
	];
	const state = createSessionPickerState();
	const rendered = renderSessionPicker({ width: 100, theme, rows, state, allRuns: [other, quit] }).join("\n");
	const plain = rendered.replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(plain, new RegExp(`${statusIcon(quit.status)}\\s+${quit.id}`));
	assert.ok(rendered.includes(hexToAnsi(statusColor(quit.status, theme))));
	assert.doesNotMatch(plain, new RegExp(statusIcon("awaiting_input")));
	assert.equal(rendered.includes(hexToAnsi(statusColor("awaiting_input", theme))), false);
});

test("renderSessionPicker shows empty state when no rows", () => {
	const theme = deriveGraphTheme({});
	const state = createSessionPickerState();
	const lines = renderSessionPicker({ width: 80, theme, rows: [], state });
	assert.match(lines.join("\n"), /no workflow runs to show/);
});

test("renderSessionPicker clamps long and wide workflow names to the panel width", () => {
	const theme = deriveGraphTheme({});
	const state = createSessionPickerState();
	const rows = [
		{
			run: makeRun({
				id: "wide1111-0000-0000-0000-000000000000",
				name: `${"研究".repeat(24)}-super-long-workflow-name`,
				startedAt: 1000,
			}),
			bucket: "active" as const,
		},
	];
	const width = 72;
	const lines = renderSessionPicker({ width, theme, rows, state, now: 120_000 });
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
	}
	assert.match(lines.join("\n"), /…/);
});

test("keeps full ids and intact borders at narrow widths", () => {
	const theme = deriveGraphTheme({});
	const state = createSessionPickerState();
	const runId = "d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f";
	const row = { run: makeRun({ id: runId, name: "build-check" }), bucket: "active" as const };
	for (const width of [80, 79, 60, 40, 30, 20]) {
		const plain = renderSessionPicker({ width, theme, rows: [row], state }).map((line) =>
			line.replace(/\u001b\[[0-9;]*m/g, ""),
		);
		const bordered = plain.filter((line) => line.startsWith("╭") || line.startsWith("│") || line.startsWith("╰"));
		assert.ok(bordered.length > 0);
		const borderWidth = visibleWidth(bordered[0]!);
		for (const line of bordered) assert.equal(visibleWidth(line), borderWidth);
		const idStart = plain.findIndex((line) => line.includes(runId.slice(0, 8)));
		let consumed = 0;
		for (const line of plain.slice(idStart)) {
			const fragment = line.replace(/[^0-9a-f-]/gi, "");
			if (fragment.length === 0) continue;
			if (!runId.startsWith(fragment, consumed)) break;
			consumed += fragment.length;
			if (consumed === runId.length) break;
		}
		assert.equal(consumed, runId.length, `full id is retained at width ${width}`);
		assert.doesNotMatch(plain.join("\n"), /d4e5f6a1-.*…/);
	}
});

test("limits the run viewport so full-id rows keep the overlay height compact", () => {
	const theme = deriveGraphTheme({});
	const state = createSessionPickerState();
	const rows = Array.from({ length: 12 }, (_, index) => ({
		run: makeRun({
			id: `${String(index).padStart(8, "0")}-0000-0000-0000-${String(index).padStart(12, "0")}`,
			name: `workflow-${index}`,
		}),
		bucket: "active" as const,
	}));

	assert.equal(renderSessionPicker({ width: 80, theme, rows, state }).length, 18);
	assert.equal(renderSessionPicker({ width: 40, theme, rows, state }).length, 23);
});
test("renderSessionPicker emits a clean ╰────╯ bottom border with hints on a separate row below", () => {
	// Regression gate: previously the hints text was embedded inside the
	// bottom-corner row (`╰── ↑↓ Navigate · …  ╯`), producing the broken
	// border visible in the user's report. The fix renders the bottom
	// corner as `╰─────╯` and emits the hints on the next line, outside
	// the box.
	const theme = deriveGraphTheme({});
	const state = createSessionPickerState();
	const rows = [
		{ run: makeRun({ id: "aaaa1111-0000-0000-0000-000000000000", name: "tournament" }), bucket: "active" as const },
	];
	const lines = renderSessionPicker({ width: 80, theme, rows, state });
	// The last visible chrome row is the hints text — no border glyphs.
	const hintsLine = lines[lines.length - 1]!;
	// Strip ANSI to inspect the printable characters.
	// eslint-disable-next-line no-control-regex
	const stripped = hintsLine.replace(/\u001b\[[0-9;]*m/g, "");
	assert.match(stripped, /Navigate/);
	assert.ok(!stripped.includes("╰"), "hints row must not include the bottom-left corner glyph");
	assert.ok(!stripped.includes("╯"), "hints row must not include the bottom-right corner glyph");

	// The penultimate row is the clean bottom border with NO hint text
	// embedded inside it.
	const borderLine = lines[lines.length - 2]!;
	// eslint-disable-next-line no-control-regex
	const borderStripped = borderLine.replace(/\u001b\[[0-9;]*m/g, "");
	assert.ok(
		borderStripped.startsWith("╰"),
		`bottom border should start with ╰; got ${JSON.stringify(borderStripped)}`,
	);
	assert.ok(borderStripped.endsWith("╯"), `bottom border should end with ╯; got ${JSON.stringify(borderStripped)}`);
	assert.ok(!/navigate|connect|kill|filter/.test(borderStripped), "bottom border must not embed hint labels");
	// Interior of the border is just `─` (plus the corner glyphs).
	const interior = borderStripped.slice(1, -1);
	assert.ok(/^─+$/.test(interior), `bottom border interior should be only ─; got ${JSON.stringify(interior)}`);
});
