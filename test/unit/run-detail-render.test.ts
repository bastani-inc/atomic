/**
 * Unit tests for the per-run detail renderer (`src/tui/run-detail.ts`)
 * and the `inspectRun()` lookup helper that feeds it.
 *
 * cross-ref: src/tui/run-detail.ts · src/runs/background/status.ts
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { isResumableRunOutcome } from "../../packages/workflows/src/durable/resume-outcome-eligibility.js";
import type { RunDetail } from "../../packages/workflows/src/runs/background/status.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function makeStage(
	id: string,
	name: string,
	status: StageSnapshot["status"],
	extras: Partial<StageSnapshot> = {},
): StageSnapshot {
	return { id, name, status, parentIds: [], toolEvents: [], ...extras };
}

function makeRun(over: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: over.id ?? "abc123uuid",
		name: over.name ?? "refactor-auth",
		inputs: over.inputs ?? {},
		status: over.status ?? "running",
		stages: over.stages ?? [],
		startedAt: over.startedAt ?? 1000,
		endedAt: over.endedAt,
		durationMs: over.durationMs,
		pausedDurationMs: over.pausedDurationMs,
		pausedAt: over.pausedAt,
		resumedAt: over.resumedAt,
		result: over.result,
		error: over.error,
	};
}

function detailFromRun(run: RunSnapshot): RunDetail {
	return {
		runId: run.id,
		name: run.name,
		status: run.status,
		mode: run.stages.length > 1 ? "chain" : "single",
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		durationMs: run.durationMs,
		pausedDurationMs: run.pausedDurationMs,
		pausedAt: run.pausedAt,
		resumedAt: run.resumedAt,
		inputs: run.inputs,
		stages: run.stages,
		result: run.result,
		error: run.error,
	};
}

test("stage rows show execution duration without startup diagnostics", () => {
	const stage = makeStage("s1", "worker", "completed", {
		startedAt: 1_000,
		endedAt: 66_000,
		startup: {
			phase: "first-dispatch",
			startedAt: 1_000,
			phaseStartedAt: 4_000,
			state: "dispatched",
			ownershipPending: false,
		},
	});
	const detail = detailFromRun(makeRun({ status: "completed", stages: [stage], endedAt: 66_000 }));
	for (const theme of [undefined, deriveGraphTheme({})]) {
		const output = stripAnsi(renderRunDetail(detail, { theme, now: 66_000, width: 100 }));
		assert.match(output, /worker.*completed.*1m 5s/);
		assert.doesNotMatch(output, /startup|first-dispatch|current step/);
	}
	assert.equal(stage.startup?.state, "dispatched");
});

// ---------------------------------------------------------------------------
// inspectRun
// ---------------------------------------------------------------------------

describe("inspectRun", () => {
	test("returns ok:false not_found for unknown id", () => {
		const store = createStore();
		const result = inspectRun("nonexistent", { store });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "not_found");
	});

	test("returns detail for active run", () => {
		const store = createStore();
		store.recordRunStart(makeRun({ id: "abc123uuid", name: "wf", status: "running" }));
		const result = inspectRun("abc123uuid", { store });
		assert.equal(result.ok, true);
		if (result.ok) {
			assert.equal(result.detail.runId, "abc123uuid");
			assert.equal(result.detail.mode, "single");
			assert.equal(result.detail.status, "running");
		}
	});

	test("does not resolve a short prefix to a longer matching run", () => {
		const store = createStore();
		store.recordRunStart(makeRun({ id: "abc123full-uuid", name: "wf" }));
		const result = inspectRun("abc123", { store });
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "not_found");
	});

	test("derives mode=chain when stage count > 1", () => {
		const store = createStore();
		store.recordRunStart(
			makeRun({
				id: "chainrun",
				stages: [makeStage("s1", "a", "running"), makeStage("s2", "b", "pending")],
			}),
		);
		const result = inspectRun("chainrun", { store });
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.detail.mode, "chain");
	});
});

// ---------------------------------------------------------------------------
// renderRunDetail
// ---------------------------------------------------------------------------

// Issue #3008: set TZ only on a fresh process, never on a parallel test worker.
for (const [tz, startedAt, started, ended] of [
	["UTC", 1789202285073, "08:38:05", "08:38:57"],
	["Europe/Zurich", 1789202285073, "10:38:05", "10:38:57"],
	["Europe/Zurich", Date.parse("2026-01-12T08:38:05.073Z"), "09:38:05", "09:38:57"],
	["Asia/Kathmandu", 1789202285073, "14:23:05", "14:23:57"],
	// Spring-forward changes wall-clock hours, not the 52-second elapsed interval.
	["Europe/Zurich", Date.parse("2026-03-29T00:59:30.000Z"), "01:59:30", "03:00:22"],
] as const) {
	test(`run detail uses system local time in ${tz} at ${startedAt}`, () => {
		const originalTZ = process.env.TZ;
		const renderer = fileURLToPath(new URL("../../packages/workflows/src/tui/run-detail.ts", import.meta.url));
		const themes = fileURLToPath(new URL("../../packages/workflows/src/tui/graph-theme.ts", import.meta.url));
		const details = [
			detailFromRun(makeRun({ startedAt })),
			detailFromRun(makeRun({ startedAt, status: "paused", pausedAt: startedAt + 32_000 })),
			detailFromRun(makeRun({ startedAt, status: "completed", endedAt: startedAt + 52_000 })),
			detailFromRun(makeRun({ startedAt, status: "failed", endedAt: startedAt + 52_000, durationMs: 42_000 })),
		];
		const child = spawnSyncCollect(
			[
				bunExecutable(),
				"-e",
				`
			import { renderRunDetail } from ${JSON.stringify(renderer)};
			import { deriveGraphTheme } from ${JSON.stringify(themes)};
			const details = ${JSON.stringify(details)};
			const output = details.map(detail => [undefined, deriveGraphTheme({})].map(theme =>
				renderRunDetail(detail, { theme, width: 100, now: ${startedAt + 52_000} })));
			console.log(JSON.stringify({ output, details }));
		`,
			],
			{ env: { ...process.env, TZ: tz } },
		);
		assert.equal(child.exitCode, 0, child.stderr.toString());
		const result = JSON.parse(child.stdout.toString()) as { output: string[][]; details: RunDetail[] };
		assert.deepEqual(
			result.details,
			JSON.parse(JSON.stringify(details)),
			"rendering preserves raw timestamps and duration",
		);
		for (const [index, outputs] of result.output.entries()) {
			for (const output of outputs) {
				const plain = stripAnsi(output);
				assert.match(plain, new RegExp(`started\\s+${started}\\s`));
				if (index < 2) {
					assert.doesNotMatch(plain, /ended\s/);
					assert.match(plain, new RegExp(`elapsed\\s+${index === 0 ? 52 : 32}s\\s`));
				} else {
					assert.match(plain, new RegExp(`ended\\s+${ended}\\s`));
					assert.match(plain, new RegExp(`duration\\s+${index === 2 ? 52 : 42}s\\s`));
				}
			}
		}
		assert.equal(process.env.TZ, originalTZ);
	});
}

// PR #2973: the resumable action must not be described as cancellation.
test("active run detail labels its pause action consistently across rendering modes", () => {
	const detail = detailFromRun(makeRun({ id: "aaaaaaaa-1111-4111-8111-111111111111" }));
	for (const theme of [undefined, deriveGraphTheme({})]) {
		for (const width of [48, 100]) {
			const plain = stripAnsi(renderRunDetail(detail, { theme, width, now: 2_000 }));
			assert.match(plain, /workflow pause/);
			assert.match(plain, /pause workflow/);
			assert.doesNotMatch(plain, /cancel/);
			for (const line of plain.split("\n")) assert.ok(visibleWidth(line) <= width);
		}
	}
});

describe("renderRunDetail — themed", () => {
	test("emits rounded run panel, stage cards, and a pause hint for an active run", () => {
		const now = 1_000_000;
		const run = makeRun({
			id: "abc123uuid",
			name: "refactor-auth",
			status: "running",
			startedAt: now - 117_000,
			stages: [
				makeStage("s1", "scout", "completed", { durationMs: 45_000 }),
				makeStage("s2", "planner", "running", { startedAt: now - 72_000 }),
				makeStage("s3", "worker", "pending"),
			],
		});
		const detail = detailFromRun(run);
		const out = renderRunDetail(detail, { theme: deriveGraphTheme({}), now });
		const plain = stripAnsi(out);

		// The full run id is in the identity row, while the title keeps the
		// workflow name and state badge.
		assert.match(plain, /RUN refactor-auth/);
		assert.match(plain, /abc123uuid/);
		assert.match(plain, /refactor-auth/);
		assert.match(plain, /● running/);

		// STAGES section label + stage glyphs.
		assert.match(plain, /STAGES/);
		assert.doesNotMatch(plain, /\u258e/);
		assert.match(plain, /✓ scout/);
		assert.match(plain, /● planner/);
		assert.match(plain, /○ worker/);

		// Active run keeps the complete id in the pause action hint.
		assert.match(plain, /workflow pause\s+id=abc123uuid/);
		assert.doesNotMatch(plain, /workflow resume/);
	});

	test("paused run renders paused badges, summary state, and resume hint", () => {
		const now = 1_000_000;
		const detail = detailFromRun(
			makeRun({
				id: "pause123uuid",
				name: "tournament",
				status: "paused",
				startedAt: now - 10_000,
				pausedAt: now - 6_000,
				stages: [makeStage("p1", "review", "paused", { startedAt: now - 10_000, pausedAt: now - 6_000 })],
			}),
		);

		const out = renderRunDetail(detail, { theme: deriveGraphTheme({}), now, width: 100 });
		const plain = stripAnsi(out);

		assert.match(plain, /RUN tournament/);
		assert.match(plain, /pause123uuid/);
		assert.match(plain, /tournament/);
		assert.match(plain, /❚❚ paused/);
		assert.match(plain, /state\s+❚❚ paused/);
		assert.match(plain, /workflow resume\s+id=pause123uuid/);
		assert.match(plain, /continue workflow/);
		assert.doesNotMatch(plain, /workflow pause/);
		assert.doesNotMatch(plain, /○ pending/);
	});

	test("ended non-resumable run offers read-only inspection and reports duration", () => {
		// Local wall-clock fixture; the explicit TZ regressions above fix the offsets.
		const now = new Date(2026, 0, 12, 0, 16, 40).getTime();
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const detail = detailFromRun(
			makeRun({
				id: runId,
				name: "scan-deps",
				status: "completed",
				startedAt: now - 60_000,
				endedAt: now - 8_000,
				durationMs: 52_000,
				stages: [makeStage("s1", "scan", "completed", { durationMs: 52_000 })],
			}),
		);
		const out = renderRunDetail(detail, { theme: deriveGraphTheme({}), now });
		const plain = stripAnsi(out);
		assert.match(plain, /✓ completed/);
		assert.ok(plain.includes(`id=${runId}`));
		assert.match(plain, /started\s+00:15:40/);
		assert.match(plain, /ended\s+00:16:32/);
		assert.doesNotMatch(plain, /\([^)]*ago\)/);
		assert.match(plain, /duration/);
		assert.doesNotMatch(plain, /workflow pause/);
		assert.match(plain, /workflow status\s+id=/);
		assert.doesNotMatch(plain, /workflow resume/);
	});

	test("foreign-live durable detail does not promise local pause", () => {
		const detail: RunDetail = {
			...detailFromRun(makeRun({ id: "foreign-live", name: "foreign-live", status: "running" })),
			ownerActiveElsewhere: true,
			resumeGuidance: "This workflow is actively running in another Atomic session.",
		};
		const plain = stripAnsi(renderRunDetail(detail, { theme: deriveGraphTheme({}), now: 2_000 }));

		assert.match(plain, /workflow status\s+id=foreign-live/);
		assert.match(plain, /owner active elsewhere/);
		assert.doesNotMatch(plain, /workflow pause/);
		assert.doesNotMatch(plain, /workflow resume/);
	});

	test("long and wide run detail values stay within the requested width", () => {
		const now = 1_000_000;
		const width = 56;
		const detail = detailFromRun(
			makeRun({
				id: "wide-run-detail",
				name: `${"研究".repeat(20)}-detail`,
				status: "running",
				startedAt: now - 117_000,
				inputs: { ["検索".repeat(10)]: "value" },
				stages: [
					makeStage("s1", "計画".repeat(16), "running", {
						startedAt: now - 72_000,
						toolEvents: [{ name: "ツール".repeat(12), startedAt: now - 10_000 }],
					}),
				],
				result: { long: "結果".repeat(30) },
			}),
		);
		const out = renderRunDetail(detail, { theme: deriveGraphTheme({}), now, width });
		for (const line of out.split("\n")) {
			assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`);
		}
		assert.match(stripAnsi(out), /…/);
	});

	test("active tool-activity label honours the captured clock so scrollback cards don't tick", () => {
		// Regression: a running stage's in-flight tool label (e.g. `bash · 6s`) was
		// computed from a fresh Date.now() inside stageActivityString(), bypassing
		// the capture-once `opts.now`. A `/workflow status <id>` detail card that had
		// scrolled above the viewport fold then changed bytes on every host render
		// tick (driven ~1×/sec by the below-editor companion widget), forcing
		// pi-tui's full-screen redraw (CSI 2J/H/3J) — whole-page + chat-box flicker.
		const now = 1_000_000;
		const detail = detailFromRun(
			makeRun({
				id: "ticky-run",
				name: "scan",
				status: "running",
				startedAt: now - 117_000,
				stages: [
					makeStage("s1", "worker", "running", {
						startedAt: now - 72_000,
						// In-flight tool event (no endedAt): elapsed is live unless `now` wins.
						toolEvents: [{ name: "bash", startedAt: now - 6_000 }],
					}),
				],
			}),
		);

		const originalNow = Date.now;
		try {
			// Two host re-renders at advancing wall-clock, same captured `now`.
			Date.now = () => now + 500_000;
			const first = stripAnsi(renderRunDetail(detail, { theme: deriveGraphTheme({}), now }));
			Date.now = () => now + 5_000_000;
			const second = stripAnsi(renderRunDetail(detail, { theme: deriveGraphTheme({}), now }));
			assert.equal(
				first,
				second,
				"run-detail active tool-activity label must not tick across re-renders (frozen clock avoids above-fold full-redraw flicker)",
			);
			// The active tool label reflects the captured clock (6s), not Date.now().
			assert.match(first, /bash · 6s/);

			// Sanity: a later captured clock renders a larger active-tool elapsed,
			// proving the label genuinely depends on the captured clock.
			const later = stripAnsi(renderRunDetail(detail, { theme: deriveGraphTheme({}), now: now + 4_000 }));
			assert.match(later, /bash · 10s/);
			assert.notEqual(first, later, "sanity: active tool elapsed must depend on the captured clock");
		} finally {
			Date.now = originalNow;
		}
	});
	test("themed detail names pending stages and truthful canonical targets", () => {
		const detail = detailFromRun(
			makeRun({
				id: "detail-run",
				stages: [
					makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true }),
					makeStage("offline", "review", "pending", { pendingStageDeliveryAvailable: false }),
				],
			}),
		);
		const plain = stripAnsi(renderRunDetail(detail, { theme: deriveGraphTheme({}), width: 100 }));
		assert.ok(plain.includes("pending target  workflow:detail-run/review-a"));
		assert.match(plain, /pending id {6}offline · delivery unavailable/);
		assert.doesNotMatch(plain, /detail-run:offline/);
	});
	test("plain detail exposes pending canonical identity and target within narrow widths", () => {
		const detail = detailFromRun(
			makeRun({
				id: "plain-run",
				stages: [makeStage("worker-id", "worker", "pending", { pendingStageDeliveryAvailable: true })],
			}),
		);
		const out = renderRunDetail(detail, { width: 80 });
		assert.ok(out.includes("pending target  workflow:plain-run/worker-id"));
		for (const line of renderRunDetail(detail, { width: 32 }).split("\n")) assert.equal(visibleWidth(line), 32);
	});
	test("never ellipsizes a projected pending-stage target at widths 32 through 200", () => {
		const runId = "aaaaaaaa-1111-4111-8111-111111111111";
		const target = `workflow:${runId}/review-a`;
		const localStore = createStore();
		localStore.recordRunStart(
			makeRun({
				id: runId,
				name: "projected-run-detail",
				stages: [makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true })],
			}),
		);
		const detail = detailFromRun(localStore.graphSnapshot().runs[0]!);

		for (let width = 32; width <= 200; width++) {
			const plain = stripAnsi(renderRunDetail(detail, { width }));
			const lines = plain.split("\n");
			const firstIndex = lines.findIndex((line) => line.includes("pending target"));
			assert.notEqual(firstIndex, -1, `pending target row is present at width ${width}`);
			const chunks: string[] = [];
			for (let index = firstIndex; index < lines.length; index++) {
				const content = lines[index]!.replace(/^│/u, "").replace(/│$/u, "").trimEnd();
				if (index === firstIndex) {
					chunks.push(content.slice(content.indexOf("pending target") + "pending target".length).trim());
					continue;
				}
				const chunk = content.trim();
				if (chunk.length === 0) break;
				chunks.push(chunk);
			}
			const renderedTarget = chunks.join("");
			assert.equal(renderedTarget, target, `target must remain exact at width ${width}`);
			assert.doesNotMatch(renderedTarget, /…/u, `target must never be ellipsized at width ${width}`);
			for (const line of lines) assert.equal(visibleWidth(line), width);
		}
	});
	test("projected detail suppresses pending-stage targets after the run terminates", () => {
		const runId = "terminated-projected-detail";
		const localStore = createStore();
		localStore.recordRunStart(
			makeRun({
				id: runId,
				name: "terminated-detail",
				stages: [makeStage("review-a", "review", "pending", { pendingStageDeliveryAvailable: true })],
			}),
		);
		localStore.recordRunEnd(runId, "failed", undefined, "boom");
		const detail = detailFromRun(localStore.graphSnapshot().runs[0]!);

		const plain = renderRunDetail(detail, { width: 100 });

		assert.match(plain, /✗ failed/);
		assert.match(plain, /pending id {6}review-a · delivery unavailable/);
		assert.doesNotMatch(plain, new RegExp(`workflow:${runId}/review-a`));
	});
});

describe("renderRunDetail — plain", () => {
	test("plain mode (no theme) is ANSI-free and includes rounded panel chrome", () => {
		// The full id is rendered in the body rather than shortened in the title.
		const detail = detailFromRun(makeRun({ id: "scratch01" }));
		const out = renderRunDetail(detail);
		assert.doesNotMatch(out, /\x1b\[/);
		assert.match(out, /╭ RUN refactor-auth/);
		assert.match(out, /run id\s+scratch01/);
		assert.match(out, /╰─+╯/);
	});
});

// #2565: a resume-eligible failure reads "failed · resumable" in the warning
// tone; the hint row agrees with the badge; a run with no restart point stays
// red even though the engine's flag says resumable; the claim is never rewritten.
describe("resumable failures (#2565)", () => {
	const theme = deriveGraphTheme({});
	const failedRun = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
		...makeRun({
			id: "aaaaaaaa-1111-4111-8111-111111111111",
			status: "failed",
			startedAt: 1_000,
			endedAt: 5_000,
			stages: [makeStage("s1", "review", "failed")],
		}),
		resumable: true,
		failedStageId: "s1",
		...over,
	});

	test("badge and hint follow the stored eligibility, not the claim", () => {
		const eligible = { ...detailFromRun(failedRun()), resumable: true, resumeEligible: true };
		const out = renderRunDetail(eligible, { theme });
		const plain = stripAnsi(out);
		assert.match(plain, /✗ failed · resumable/);
		assert.ok(out.includes(`${hexToAnsi(theme.warning)}✗ failed · resumable`), "warning tone on the badge");
		assert.match(plain, /workflow resume\s+id=/);
		assert.match(plain, /continue workflow/);

		const terminal = { ...detailFromRun(failedRun()), resumable: true, resumeEligible: false };
		const plainTerminal = stripAnsi(renderRunDetail(terminal, { theme }));
		assert.match(plainTerminal, /✗ failed(?! ·)/);
		assert.doesNotMatch(plainTerminal, /resumable/);
		assert.match(plainTerminal, /workflow status\s+id=/);
		assert.match(plainTerminal, /inspect retained state/);
	});

	test("blocked and crashed carry the cue the same way; a paused run keeps its own hint", () => {
		const blocked = { ...detailFromRun(failedRun({ status: "blocked" })), resumeEligible: true };
		assert.match(stripAnsi(renderRunDetail(blocked, { theme })), /↑ blocked · resumable/);
		const crashed = { ...detailFromRun(failedRun()), status: "crashed" as const, resumeEligible: false };
		assert.match(stripAnsi(renderRunDetail(crashed, { theme })), /✗ crashed(?! ·)/);
		const paused = { ...detailFromRun(makeRun({ status: "paused", pausedAt: 2_000 })), resumable: undefined };
		assert.match(stripAnsi(renderRunDetail(paused, { theme })), /workflow resume\s+id=/);
	});

	test("inspectRun stores the eligibility the shared check computes and leaves the claim as the engine wrote it", () => {
		const store = createStore();
		store.recordRunStart(failedRun());
		store.recordRunStart(
			failedRun({ id: "bbbbbbbb-2222-4222-8222-222222222222", stages: [], failedStageId: undefined }),
		);
		for (const run of store.runs()) {
			const inspected = inspectRun(run.id, { store });
			assert.ok(inspected.ok);
			assert.equal(inspected.detail.resumable, true, "the claim is copied unchanged");
			assert.equal(inspected.detail.resumeEligible, isResumableRunOutcome(run), run.id);
		}
		const [withStage, withoutStage] = store.runs().map((run) => inspectRun(run.id, { store }));
		assert.equal(withStage?.ok && withStage.detail.resumeEligible, true, "a failed stage is a restart point");
		assert.equal(withoutStage?.ok && withoutStage.detail.resumeEligible, false, "no stage, no restart point");
	});
});

// Review round on #3153: three things commit 3 got wrong, each pinned here.
describe("run detail corrections (#2565)", () => {
	const theme = deriveGraphTheme({});
	const budgetStop = (): RunSnapshot => ({
		...makeRun({
			id: "cccccccc-3333-4333-8333-333333333333",
			status: "running",
			startedAt: 1_000,
			endedAt: 5_000,
			stages: [],
		}),
		result: { status: "budget_exceeded" },
		budgetState: { systemOwnedStop: true } as RunSnapshot["budgetState"],
		resumable: true,
		// Without the disposition this is not an active block: effectiveRunStatus
		// returns the raw "running" and the card never reaches the budget rail.
		failureDisposition: "active_blocked",
		failureRecoverability: "recoverable",
		blockedAt: 3_000,
	});

	test("a budget stop reads budget_exceeded on the detail, as it does on every other surface", () => {
		const store = createStore();
		store.recordRunStart(budgetStop());
		const inspected = inspectRun("cccccccc-3333-4333-8333-333333333333", { store });
		assert.ok(inspected.ok);
		assert.equal(inspected.detail.budgetExceeded, true, "the flag is carried, since RunDetail has no budgetState");
		assert.equal(inspected.detail.status, "blocked", "an active budget block presents as blocked");
		const plain = stripAnsi(renderRunDetail(inspected.detail, { theme }));
		// Assert on the badge rows only: the raw `result` row further down the card
		// also contains the words, so a whole-output match proves nothing.
		const badgeRows = plain.split("\n").filter((line) => line.includes("state") || line.includes("RUN "));
		assert.ok(
			badgeRows.some((line) => line.includes("budget_exceeded · resumable")),
			`badge should carry the budget word and the cue: ${badgeRows.join(" // ")}`,
		);
		assert.ok(!badgeRows.some((line) => line.includes("↑ blocked")), "never the bare blocked word for a budget stop");
	});

	test("a backend fault leaves status readable instead of throwing out of inspectRun", () => {
		const exploding = () => {
			throw new Error("durable backend unavailable");
		};
		const run = {
			...makeRun({ id: "dddddddd-4444-4444-8444-444444444444", status: "failed", startedAt: 1, endedAt: 2 }),
			resumable: true,
			failedToolNodeId: "tool:abc",
			toolNodes: [] as RunSnapshot["toolNodes"],
		};
		// The tool-frontier branch is the one that reaches the backend at all.
		assert.equal(
			isResumableRunOutcome(run, (candidate) => ({ ...candidate }), exploding),
			false,
			"an unprovable restart point reads terminal, not an exception",
		);
		const store = createStore();
		store.recordRunStart(run);
		const inspected = inspectRun("dddddddd-4444-4444-8444-444444444444", { store });
		assert.ok(inspected.ok);
	});

	test("a detail saved before resumeEligible existed keeps the behaviour it was rendered with", () => {
		// Persisted payloads are re-rendered with no store to probe, so the field
		// is absent and the old rule has to answer: the claim AND a cue-capable
		// status. A bare claim fallback would offer resume on completed and killed.
		const legacy = (status: RunDetail["status"], resumable: boolean): RunDetail => ({
			...detailFromRun(makeRun({ id: "eeeeeeee-5555-4555-8555-555555555555", status: "failed", endedAt: 9 })),
			status,
			resumable,
			resumeEligible: undefined,
		});
		for (const status of ["failed", "crashed", "blocked"] as const) {
			assert.match(stripAnsi(renderRunDetail(legacy(status, true), { theme })), /workflow resume\s+id=/, status);
		}
		for (const status of ["completed", "killed"] as const) {
			const plain = stripAnsi(renderRunDetail(legacy(status, true), { theme }));
			assert.doesNotMatch(plain, /workflow resume\s+id=/, `${status} never offered resume before this change`);
		}
		// A new payload still wins over the claim in both directions.
		const fresh = { ...legacy("failed", true), resumeEligible: false };
		assert.doesNotMatch(stripAnsi(renderRunDetail(fresh, { theme })), /workflow resume\s+id=/);
	});
});
