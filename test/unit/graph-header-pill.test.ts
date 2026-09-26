/**
 * The graph header pill (`src/tui/header.ts`).
 *
 * Issue #2565: the pill's border carries the run's outcome. It reads the
 * effective status, not the raw stored one, so a run blocked on a recoverable
 * failure (still `status: "running"` in the store) is no longer painted as
 * healthy, and a resume-eligible stop takes the warning tone the other
 * run-level surfaces use. The label itself never changes.
 *
 * cross-ref: src/tui/header.ts · src/tui/run-outcome-presentation.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { renderHeader } from "../../packages/workflows/src/tui/header.js";

const theme = deriveGraphTheme({});

function run(over: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "aaaaaaaa-1111-4111-8111-111111111111",
		name: "review-and-merge",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1_000,
		...over,
	} as RunSnapshot;
}

/**
 * The pill's top row carries the band background as well as the border
 * foreground, so assert on which palette colour is present rather than on the
 * position of the first escape.
 */
const PALETTE = [theme.warning, theme.error, theme.success, theme.dim, theme.accent];

function assertBorder(lines: readonly string[], expected: string, label: string): void {
	const top = lines[0] ?? "";
	assert.ok(top.includes(hexToAnsi(expected)), `${label}: expected border colour missing`);
	for (const other of PALETTE) {
		if (other === expected) continue;
		assert.ok(!top.includes(hexToAnsi(other)), `${label}: unexpected border colour present`);
	}
}

describe("graph header pill (#2565)", () => {
	test("an eligible failure takes the warning border; a terminal one stays error", () => {
		const failed = run({ status: "failed", endedAt: 5_000 });
		assertBorder(renderHeader(failed, { width: 80, theme, resumable: true }), theme.warning, "eligible");
		assertBorder(renderHeader(failed, { width: 80, theme, resumable: false }), theme.error, "terminal");
	});

	test("a run blocked on a recoverable failure is read from its effective status, not its raw one", () => {
		// The store keeps this run at `running`; before this change the header
		// painted it with the neutral accent and gave no sign it was stuck.
		const activeBlocked = run({
			status: "running",
			failureDisposition: "active_blocked",
			failureRecoverability: "recoverable",
			// The effective status only reads blocked for a recoverable provider
			// failure kind; without it this is still an ordinary running run.
			failureKind: "auth",
			resumable: true,
			blockedAt: 3_000,
		});
		assert.equal(activeBlocked.status, "running", "raw status is unchanged");
		assertBorder(renderHeader(activeBlocked, { width: 80, theme, resumable: true }), theme.warning, "active blocked");
	});

	test("completed, killed and running keep the borders they had", () => {
		assertBorder(
			renderHeader(run({ status: "completed", endedAt: 5_000 }), { width: 80, theme }),
			theme.success,
			"completed",
		);
		assertBorder(renderHeader(run({ status: "killed", endedAt: 5_000 }), { width: 80, theme }), theme.dim, "killed");
		assertBorder(renderHeader(run(), { width: 80, theme }), theme.accent, "running");
	});

	test("the pill's word is untouched by the outcome", () => {
		for (const resumable of [true, false]) {
			const lines = renderHeader(run({ status: "failed", endedAt: 5_000 }), { width: 80, theme, resumable });
			assert.ok(lines.join(" ").includes("ORCHESTRATOR"), "the label never carries the cue");
		}
	});
});
