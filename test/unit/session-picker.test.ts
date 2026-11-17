import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { isWorkflowRunResumable } from "../../packages/workflows/src/durable/resume-eligibility.ts";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.ts";
import {
	ENV_WORKFLOW_ARTIFACT_DIR,
	refreshWorkflowArtifactPresence,
} from "../../packages/workflows/src/shared/workflow-artifacts.ts";
import { selectRunsForPicker } from "../../packages/workflows/src/tui/session-picker.ts";

function makeRun(over: Partial<RunSnapshot>): RunSnapshot {
	return {
		id: over.id ?? "00000000-0000-0000-0000-000000000000",
		name: over.name ?? "demo",
		inputs: over.inputs ?? {},
		status: over.status ?? "running",
		toolNodes: [],
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

test("selectRunsForPicker buckets active vs retained terminal by default (#5224)", () => {
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

test("resume picker inclusion agrees with the shared resumability predicate across run states (#5224)", () => {
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

test("a paused run whose artifacts were pruned is not resumable (#5224)", () => {
	const paused = makeRun({ id: "pruned-artifacts", status: "paused", resumable: true });
	assert.equal(isWorkflowRunResumable({ ...paused, hasPausedState: true }), true);
	assert.equal(isWorkflowRunResumable({ ...paused, hasPausedState: true, artifactsIntact: false }), false);
	assert.equal(isWorkflowRunResumable({ ...paused, hasPausedState: true, hasDurableCheckpoint: false }), false);
});

test("resume picker production filtering hides a run whose referenced artifact directory is missing (#5224)", async () => {
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
		await refreshWorkflowArtifactPresence([run], [run]);
		assert.equal(selectRunsForPicker([run], "", true, Date.now(), "resume").length, 0);
		await mkdir(join(root, "runs", runId), { recursive: true });
		await refreshWorkflowArtifactPresence([run], [run]);
		assert.equal(selectRunsForPicker([run], "", true, Date.now(), "resume").length, 1);
	} finally {
		if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
		await rm(root, { recursive: true, force: true });
	}
});

test("connect picker remains broad while resume hides a completed run (#5224)", () => {
	const completed = makeRun({ id: "completed", status: "completed", endedAt: 2_000 });
	assert.equal(selectRunsForPicker([completed], "", true, Date.now(), "connect").length, 1);
	assert.equal(selectRunsForPicker([completed], "", true, Date.now(), "resume").length, 0);
});

test("resume picker lists a resumable paused run and hides a non-resumable one (#5224)", () => {
	const resumablePaused = makeRun({ id: "resumable-paused", status: "paused", resumable: true });
	const refusedPaused = makeRun({ id: "refused-paused", status: "paused", resumable: false });
	const rows = selectRunsForPicker([resumablePaused, refusedPaused], "", true, Date.now(), "resume");
	assert.deepEqual(
		rows.map((row) => row.run.id),
		["resumable-paused"],
	);
});

test("selectRunsForPicker filters by name and runId prefix (#5224)", () => {
	const runs: RunSnapshot[] = [
		makeRun({ id: "abc12345-0000-0000-0000-000000000000", name: "tournament" }),
		makeRun({ id: "def67890-0000-0000-0000-000000000000", name: "deep-research" }),
	];
	assert.equal(selectRunsForPicker(runs, "tournament", true).length, 1);
	assert.equal(selectRunsForPicker(runs, "research", true).length, 1);
	assert.equal(selectRunsForPicker(runs, "abc", true)[0]?.run.name, "tournament");
	assert.equal(selectRunsForPicker(runs, "zzz", true).length, 0);
});
