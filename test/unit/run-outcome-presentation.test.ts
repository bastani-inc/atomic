/**
 * Shared run-level outcome presentation (`src/tui/run-outcome-presentation.ts`).
 *
 * Issue #2565: a resume-eligible failure reads `failed · resumable` in the
 * warning tone; a terminal failure stays `failed` in the error tone; specific
 * stop labels (`blocked`, `budget_exceeded`) keep their word and gain the cue.
 * Eligibility is the resume rule and then a usable restart point, so a failed
 * run the engine flags resumable but that has nothing to restart from stays
 * red (flora131's request on the issue), and that distinction is pinned here.
 *
 * Fixtures carry what the engine writes: an active block is recorded only with
 * a `failedStageId` (engine/run.ts, the active_blocked branch), and a terminal
 * failure records the failed stage the same way (engine/run-terminal-failure.ts).
 *
 * cross-ref: src/durable/resume-eligibility.ts · src/durable/resume-restart-point.ts · src/tui/status-helpers.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { DbosNotReadyError } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import type { WorkflowRunResumeCandidate } from "../../packages/workflows/src/durable/resume-eligibility.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import {
	isBudgetExceededStop,
	isResumableRunOutcome,
	RESUMABLE_CUE,
	RUN_LABEL_SEPARATOR,
	runOutcomePresentation,
	runOutcomeToneColor,
	runSnapshotOutcomePresentation,
} from "../../packages/workflows/src/tui/run-outcome-presentation.js";

function makeRun(over: Partial<RunSnapshot>): RunSnapshot {
	return {
		id: over.id ?? "run-1",
		name: over.name ?? "review-and-repair",
		inputs: {},
		status: over.status ?? "running",
		stages: over.stages ?? [],
		startedAt: over.startedAt ?? 1,
		...over,
	};
}

describe("runOutcomePresentation (#2565)", () => {
	test("matches the maintainer label table", () => {
		const table: Array<[Parameters<typeof runOutcomePresentation>[0], string, string]> = [
			[{ status: "failed", resumable: true }, "failed · resumable", "warning"],
			[{ status: "blocked", resumable: true }, "blocked · resumable", "warning"],
			[{ status: "blocked", resumable: true, budgetExceeded: true }, "budget_exceeded · resumable", "warning"],
			[{ status: "failed", resumable: false }, "failed", "error"],
			[{ status: "running", resumable: true }, "running", "warning"],
			[{ status: "crashed", resumable: true }, "crashed · resumable", "warning"],
			[{ status: "crashed", resumable: false }, "crashed", "error"],
		];
		for (const [input, label, tone] of table) {
			const presentation = runOutcomePresentation(input);
			assert.equal(presentation.label, label, JSON.stringify(input));
			assert.equal(presentation.tone, tone, JSON.stringify(input));
		}
	});

	test("splits status and cue so a surface can interleave its own fields", () => {
		const resumable = runOutcomePresentation({ status: "failed", resumable: true });
		assert.equal(resumable.status, "failed");
		assert.equal(resumable.cue, RESUMABLE_CUE);
		assert.equal(resumable.label, `${resumable.status}${RUN_LABEL_SEPARATOR}${resumable.cue}`);
		assert.equal(
			[resumable.status, resumable.cue, "12m 08s"].join(RUN_LABEL_SEPARATOR),
			"failed · resumable · 12m 08s",
		);

		const terminal = runOutcomePresentation({ status: "failed", resumable: false });
		assert.equal(terminal.cue, "");
		assert.equal(terminal.label, "failed");
	});

	test("only failed, blocked and crashed can carry the cue", () => {
		for (const status of ["pending", "running", "paused", "completed", "skipped", "cancelled", "killed"] as const) {
			const presentation = runOutcomePresentation({ status, resumable: true });
			assert.equal(presentation.cue, "", status);
			assert.equal(presentation.label, status, status);
		}
	});

	test("non-resumable stops keep their existing tones", () => {
		assert.equal(runOutcomePresentation({ status: "blocked", resumable: false }).tone, "dim");
		assert.equal(runOutcomePresentation({ status: "killed", resumable: false }).tone, "error");
		assert.equal(runOutcomePresentation({ status: "completed", resumable: false }).tone, "success");
		assert.equal(runOutcomePresentation({ status: "paused", resumable: false }).tone, "warning");
		assert.equal(runOutcomePresentation({ status: "cancelled", resumable: false }).tone, "dim");
	});

	test("budget_exceeded is only substituted for a blocked status", () => {
		assert.equal(
			runOutcomePresentation({ status: "failed", resumable: true, budgetExceeded: true }).status,
			"failed",
		);
		assert.equal(
			runOutcomePresentation({ status: "blocked", resumable: false, budgetExceeded: true }).label,
			"budget_exceeded",
		);
	});

	test("tones map onto the theme's role colours", () => {
		const theme = deriveGraphTheme();
		assert.equal(runOutcomeToneColor("warning", theme), theme.warning);
		assert.equal(runOutcomeToneColor("error", theme), theme.error);
		assert.equal(runOutcomeToneColor("success", theme), theme.success);
		assert.equal(runOutcomeToneColor("info", theme), theme.info);
		assert.equal(runOutcomeToneColor("dim", theme), theme.dim);
	});
});

describe("isResumableRunOutcome (#2565)", () => {
	const probe =
		(extra: Partial<WorkflowRunResumeCandidate> = {}) =>
		(run: RunSnapshot): WorkflowRunResumeCandidate => ({ ...run, ...extra });

	test("a failed run with no resumable metadata counts as resumable when it has a stage to restart from", () => {
		// flora131: missing optional metadata must not automatically mean non-resumable.
		const run = makeRun({ status: "failed", endedAt: 2, failedStageId: "s1" });
		assert.equal(run.resumable, undefined);
		assert.equal(isResumableRunOutcome(run, probe()), true);
	});

	test("explicit non-resumable metadata, a missing checkpoint, or lost artifacts are terminal", () => {
		const run = makeRun({ status: "failed", endedAt: 2, failedStageId: "s1" });
		assert.equal(isResumableRunOutcome(makeRun({ ...run, resumable: false }), probe()), false);
		assert.equal(isResumableRunOutcome(run, probe({ hasDurableCheckpoint: false })), false);
		assert.equal(isResumableRunOutcome(run, probe({ artifactsIntact: false })), false);
	});

	test("an active blocked run presents as blocked · resumable while its raw status stays running", () => {
		const run = makeRun({
			status: "running",
			failureDisposition: "active_blocked",
			failureRecoverability: "recoverable",
			failureKind: "auth",
			resumable: true,
			blockedAt: 3,
			failedStageId: "s1",
		});
		const presentation = runSnapshotOutcomePresentation(run, probe());
		assert.equal(presentation.label, "blocked · resumable");
		assert.equal(presentation.tone, "warning");
	});

	test("a system-owned budget stop presents as budget_exceeded · resumable", () => {
		const run = makeRun({
			status: "running",
			failureDisposition: "active_blocked",
			failureRecoverability: "recoverable",
			resumable: true,
			blockedAt: 3,
			endedAt: 3,
			result: { status: "budget_exceeded" },
			budgetState: { systemOwnedStop: true } as RunSnapshot["budgetState"],
		});
		assert.equal(isBudgetExceededStop(run), true);
		const presentation = runSnapshotOutcomePresentation(run, probe({ budgetSystemOwnedStop: true }));
		assert.equal(presentation.label, "budget_exceeded · resumable");
		assert.equal(presentation.tone, "warning");
	});

	test("an author-returned budget_exceeded status is not the engine rail", () => {
		const run = makeRun({ status: "completed", endedAt: 2, result: { status: "budget_exceeded" } });
		assert.equal(isBudgetExceededStop(run), false);
	});

	test("the candidate probe runs only for statuses that can carry the cue", () => {
		let probes = 0;
		const counting = (run: RunSnapshot): WorkflowRunResumeCandidate => {
			probes++;
			return { ...run };
		};
		isResumableRunOutcome(makeRun({ status: "running" }), counting);
		isResumableRunOutcome(makeRun({ status: "completed", endedAt: 2 }), counting);
		isResumableRunOutcome(makeRun({ status: "paused", pausedAt: 2 }), counting);
		assert.equal(probes, 0);
		isResumableRunOutcome(makeRun({ status: "failed", endedAt: 2, failedStageId: "s1" }), counting);
		assert.equal(probes, 1);
	});

	test("regression: a failed run with no restart point stays red although the engine's flag says resumable", () => {
		// A run that died before creating a stage: unknownDecision() marks it resumable,
		// and /workflow resume refuses it with insufficient_state. The presentation
		// must agree with resume, not with the flag.
		const noRestartPoint = makeRun({ status: "failed", endedAt: 2, resumable: true, stages: [] });
		assert.equal(isResumableRunOutcome(noRestartPoint, probe()), false);
		assert.deepEqual(runSnapshotOutcomePresentation(noRestartPoint, probe()), {
			status: "failed",
			cue: "",
			label: "failed",
			tone: "error",
		});
		// The same run with a failed stage is the yellow case; only the restart point differs.
		const withRestartPoint = makeRun({ ...noRestartPoint, failedStageId: "s1" });
		assert.equal(isResumableRunOutcome(withRestartPoint, probe()), true);
		assert.equal(runSnapshotOutcomePresentation(withRestartPoint, probe()).label, "failed · resumable");
	});

	test("the backend is asked only for a tool frontier, and a backend that is not ready gives the run the benefit of the doubt", () => {
		let asked = 0;
		const notReady = () => {
			asked++;
			throw new DbosNotReadyError();
		};
		// A stage restart point never touches the backend.
		assert.equal(
			isResumableRunOutcome(makeRun({ status: "failed", endedAt: 2, failedStageId: "s1" }), probe(), notReady),
			true,
		);
		assert.equal(asked, 0);
		// A tool frontier needs it; before it is ready the run is not known to lack state.
		const toolRun = makeRun({
			status: "failed",
			endedAt: 2,
			failedToolNodeId: "tool:abc",
			toolNodes: [] as RunSnapshot["toolNodes"],
		});
		assert.equal(isResumableRunOutcome(toolRun, probe(), notReady), true);
		assert.equal(asked, 1);
	});

	test("a killed run is never resumable and never cued", () => {
		const run = makeRun({ status: "killed", endedAt: 2, resumable: true });
		assert.equal(isResumableRunOutcome(run, probe()), false);
		assert.equal(runSnapshotOutcomePresentation(run, probe()).label, "killed");
	});
});
