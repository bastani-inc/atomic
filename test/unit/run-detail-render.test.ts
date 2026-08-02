/**
 * Unit tests for the per-run detail renderer (`src/tui/run-detail.ts`)
 * and the `inspectRun()` lookup helper that feeds it.
 *
 * cross-ref: src/tui/run-detail.ts · src/runs/background/status.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { RunDetail } from "../../packages/workflows/src/runs/background/status.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

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

describe("renderRunDetail — themed", () => {
	test("emits rounded run panel, stage cards, and a cancel hint for an active run", () => {
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

		// Active run keeps the complete id in the interrupt action hint.
		assert.match(plain, /workflow interrupt\s+id=abc123uuid/);
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
		assert.doesNotMatch(plain, /workflow interrupt/);
		assert.doesNotMatch(plain, /○ pending/);
	});

	test("ended run swaps the action hint to resume and reports duration", () => {
		const now = 1_000_000;
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
		assert.doesNotMatch(plain, /workflow interrupt/);
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
