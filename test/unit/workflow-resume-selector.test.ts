/**
 * Row building, ordering, and presentation for the `/workflow resume` picker
 * (`workflowResumeSelectorItems`). Picker interaction is covered by
 * `workflow-resume-selector-host-picker.test.ts` — the selector mounts
 * exclusively through the host session-picker capability; there is no
 * remote-rendered path.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifacts.js";
import {
	toWorkflowPickerRow,
	workflowResumeSelectorItems,
} from "../../packages/workflows/src/tui/workflow-resume-selector.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

function entry(
	id: string,
	status: ResumableWorkflowEntry["status"],
	updatedAt = status === "completed" ? 300 : 200,
): ResumableWorkflowEntry {
	return {
		workflowId: id,
		name: `${status}-workflow`,
		status,
		completedCheckpoints: 2,
		pendingPrompts: 0,
		createdAt: 1,
		updatedAt,
	};
}

function stage(id: string, endedAt: number): StageSnapshot {
	return {
		id,
		name: id,
		status: "completed",
		parentIds: [],
		startedAt: endedAt - 1,
		endedAt,
		toolEvents: [],
	};
}

function pausedLiveRun(id = "live-paused", activityAt = 100): RunSnapshot {
	return {
		id,
		name: "live-workflow",
		inputs: {},
		status: "paused",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		pausedAt: activityAt,
		resumable: true,
	};
}

describe("workflow resume selector rows", () => {
	test("omits a live run with missing artifacts from resumable rows while retaining completed inspection", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-resume-selector-missing-artifact-"));
		const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		try {
			process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
			const runId = "missing-artifact-run";
			const run = {
				...pausedLiveRun(runId),
				result: { transcript_path: join(root, "runs", runId, "transcripts", "stage.md") },
			};
			const items = workflowResumeSelectorItems(
				[run],
				[entry(runId, "paused")],
				[entry(runId, "completed")],
				undefined,
				undefined,
				undefined,
				{
					includeCompletedWithoutResumable: true,
				},
			);
			assert.deepEqual(
				items.map((item) => item.result.kind),
				["completed"],
			);
			assert.deepEqual(
				workflowResumeSelectorItems([run], [entry(runId, "paused")], [entry(runId, "completed")]),
				[],
			);
		} finally {
			if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
			else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
			await rm(root, { recursive: true, force: true });
		}
	});
	test("keeps a completed local snapshot visible exactly once alongside durable inspection", () => {
		const runId = "completed-local-run";
		const completed = {
			...pausedLiveRun(runId),
			status: "completed" as const,
			endedAt: 500,
			resumable: false,
		};
		const items = workflowResumeSelectorItems(
			[completed],
			[],
			[entry(runId, "completed")],
			undefined,
			undefined,
			undefined,
			{
				includeCompletedWithoutResumable: true,
			},
		);
		assert.deepEqual(
			items.map((item) => item.result.kind),
			["completed"],
		);
		assert.equal(items[0]?.result.kind === "completed" ? items[0].result.workflowId : undefined, runId);
		assert.deepEqual(workflowResumeSelectorItems([completed], [], [entry(runId, "completed")]), []);
	});

	test("offers a healthy paused live run exactly once instead of durable or completed duplicates", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-resume-selector-healthy-artifact-"));
		const previousRoot = process.env[ENV_WORKFLOW_ARTIFACT_DIR];
		try {
			process.env[ENV_WORKFLOW_ARTIFACT_DIR] = root;
			const runId = "healthy-artifact-run";
			await mkdir(join(root, "runs", runId), { recursive: true });
			const run = {
				...pausedLiveRun(runId),
				result: { transcript_path: join(root, "runs", runId, "transcripts", "stage.md") },
			};
			const items = workflowResumeSelectorItems([run], [entry(runId, "paused")], [entry(runId, "completed")]);
			assert.deepEqual(
				items.map((item) => item.result.kind),
				["live"],
			);
			assert.equal(items[0]?.result.kind === "live" ? items[0].result.runId : undefined, runId);
		} finally {
			if (previousRoot === undefined) delete process.env[ENV_WORKFLOW_ARTIFACT_DIR];
			else process.env[ENV_WORKFLOW_ARTIFACT_DIR] = previousRoot;
			await rm(root, { recursive: true, force: true });
		}
	});
	test.each(["durable", "completed"] as const)(
		"keeps saved presentation metadata on a live row from the %s catalog",
		(catalog) => {
			const run = pausedLiveRun();
			const saved = {
				...entry(run.id, "paused"),
				label: "Saved objective",
				summary: "Implementation finished; validation remains",
				summarizedThrough: 90,
			};
			const rows = workflowResumeSelectorItems(
				[run],
				catalog === "durable" ? [saved] : [],
				catalog === "completed" ? [saved] : [],
			);
			assert.equal(rows.length, 1);
			assert.deepEqual(rows[0]!.result, { kind: "live", runId: run.id });
			assert.equal(rows[0]!.session.firstMessage, `paused 0/0 live-workflow  ${saved.label}`);
			assert.equal(rows[0]!.session.summary, saved.summary);
			assert.ok(rows[0]!.session.summary!.includes(saved.summary));
			assert.ok(rows[0]!.session.allMessagesText.includes(saved.summary));
			assert.ok(rows[0]!.session.allMessagesText.includes(saved.label));
			assert.equal(run.label, undefined);
			assert.equal(run.summary, undefined);

			const [current] = workflowResumeSelectorItems(
				[{ ...run, label: "Current objective", summary: "Current progress" }],
				[saved],
			);
			assert.equal(current!.session.firstMessage, "paused 0/0 live-workflow  Current objective");
			assert.ok(current!.session.summary!.endsWith("Current progress"));
		},
	);

	test("globally orders mixed rows and renders completed rows with a green semantic", () => {
		const items = workflowResumeSelectorItems(
			[pausedLiveRun()],
			[entry("durable-paused", "paused")],
			[entry("durable-completed", "completed")],
		);

		assert.deepEqual(
			items.map((item) => item.result.kind),
			["completed", "durable", "live"],
		);
		const completed = items[0]!;
		assert.match(completed.session.summary!, /✓ completed/);
		assert.equal(completed.session.messageColor, "success");
		assert.equal(completed.session.path, "workflow-completed:durable-completed");
	});

	test("sorts unsorted live rows by latest activity", () => {
		const items = workflowResumeSelectorItems(
			[pausedLiveRun("middle", 200), pausedLiveRun("newest", 300), pausedLiveRun("oldest", 100)],
			[],
		);

		assert.deepEqual(
			items.map((item) => item.session.id),
			["newest", "middle", "oldest"],
		);
	});

	test("sorts unsorted durable rows by durable update time", () => {
		const items = workflowResumeSelectorItems(
			[],
			[entry("oldest", "paused", 100), entry("newest", "paused", 300), entry("middle", "paused", 200)],
		);

		assert.deepEqual(
			items.map((item) => item.session.id),
			["newest", "middle", "oldest"],
		);
	});

	test("globally interleaves live and durable rows by recency", () => {
		const items = workflowResumeSelectorItems(
			[pausedLiveRun("live-oldest", 100), pausedLiveRun("live-newest", 400)],
			[entry("durable-middle-new", "paused", 300), entry("durable-middle-old", "paused", 200)],
		);

		assert.deepEqual(
			items.map((item) => item.session.id),
			["live-newest", "durable-middle-new", "durable-middle-old", "live-oldest"],
		);
	});

	test("uses latest stage activity and deterministic ids for equal-time ties", () => {
		const live = pausedLiveRun("zulu-live", 50);
		live.stages.push(stage("recent", 500));
		const reversed = workflowResumeSelectorItems(
			[live, pausedLiveRun("alpha-live", 400)],
			[entry("zulu-durable", "paused", 400), entry("alpha-durable", "paused", 400)],
			[entry("middle-completed", "completed", 450)],
		);

		assert.deepEqual(
			reversed.map((item) => item.session.id),
			["zulu-live", "middle-completed", "alpha-durable", "alpha-live", "zulu-durable"],
		);
		assert.deepEqual(
			workflowResumeSelectorItems(
				[pausedLiveRun("alpha-live", 400), live],
				[entry("alpha-durable", "paused", 400), entry("zulu-durable", "paused", 400)],
				[entry("middle-completed", "completed", 450)],
			).map((item) => item.session.id),
			reversed.map((item) => item.session.id),
		);
	});

	test("deduplicates before sorting and keeps live then durable precedence", () => {
		const items = workflowResumeSelectorItems(
			[pausedLiveRun()],
			[entry("same-id", "paused", 500)],
			[entry("same-id", "completed", 900), entry("live-paused", "completed", 1_000)],
		);

		assert.deepEqual(
			items.map((item) => item.session.id),
			["same-id", "live-paused"],
		);
		assert.deepEqual(
			items.map((item) => item.result.kind),
			["durable", "live"],
		);
	});
});

describe("workflow resume selector row presentation", () => {
	test("uses a label then objective input for identity and keeps generated summaries searchable", () => {
		const rows = workflowResumeSelectorItems(
			[],
			[
				{
					...entry("label-id", "paused"),
					label: " Ship\n feature ",
					inputs: { objective: "Ignored" },
					summary: "Implementation verified",
					summarizedThrough: 100,
				},
				{ ...entry("objective-id", "paused"), inputs: { other: "Fallback", objective: "Fix\n resume" } },
				{ ...entry("fallback-id", "paused"), inputs: { count: 2, custom: "First string" } },
			],
		);
		const byId = new Map(rows.map(({ session }) => [session.id, session]));
		assert.equal(byId.get("label-id")?.firstMessage, "paused paused-workflow  Ship feature");
		assert.match(byId.get("label-id")!.summary!, /Implementation verified/);
		assert.match(byId.get("label-id")!.firstMessage, /paused.*paused-workflow/);
		assert.match(byId.get("label-id")!.allMessagesText, /label-id.*Ship feature.*Implementation verified/);
		assert.equal(byId.get("objective-id")?.firstMessage, "Fix resume");
		assert.equal(byId.get("fallback-id")?.firstMessage, "First string");
	});
	test("keeps the full live run ID in the label and search text with status, count and name in the summary", () => {
		const id = "11111111-1111-4111-8111-111111111111";
		const [item] = workflowResumeSelectorItems([pausedLiveRun(id)], []);
		assert.equal(item?.session.firstMessage, id);
		assert.equal(item.session.summary, "paused  0/0 stages  live-workflow");
		assert.match(item.session.allMessagesText, new RegExp(id));
		assert.deepEqual(item.result, { kind: "live", runId: id });
	});
	test("keeps durable and completed IDs in the label and search text with details in the summary", () => {
		const durableId = "22222222-2222-4222-8222-222222222222";
		const completedId = "33333333-3333-4333-8333-333333333333";
		const items = workflowResumeSelectorItems([], [entry(durableId, "paused")], [entry(completedId, "completed")]);
		const byId = new Map(items.map((item) => [item.session.id, item]));
		assert.equal(byId.get(durableId)?.session.firstMessage, durableId);
		assert.equal(byId.get(durableId)?.session.summary, "paused  paused-workflow");
		assert.match(byId.get(durableId)!.session.allMessagesText, new RegExp(durableId));
		assert.deepEqual(byId.get(durableId)?.result, { kind: "durable", workflowId: durableId });
		assert.equal(byId.get(completedId)?.session.firstMessage, completedId);
		assert.equal(byId.get(completedId)?.session.summary, "✓ completed  completed-workflow");
		assert.match(byId.get(completedId)!.session.allMessagesText, new RegExp(completedId));
		assert.deepEqual(byId.get(completedId)?.result, { kind: "completed", workflowId: completedId });
	});

	test("colors paused yellow, failed and blocked red, completed green", () => {
		const items = workflowResumeSelectorItems(
			[pausedLiveRun("live-paused-run")],
			[entry("d-paused", "paused"), entry("d-failed", "failed"), entry("d-blocked", "blocked")],
			[entry("d-completed", "completed")],
		);
		const byId = new Map(items.map((item) => [item.session.id, item.session]));
		assert.equal(byId.get("d-paused")?.messageColor, "warning");
		assert.equal(byId.get("d-failed")?.messageColor, "error");
		assert.equal(byId.get("d-blocked")?.messageColor, "error");
		assert.equal(byId.get("d-completed")?.messageColor, "success");
		assert.equal(byId.get("live-paused-run")?.messageColor, "warning");
	});

	test("omits checkpoint and pending prompt counts from durable and completed rows", () => {
		const durable = { ...entry("prompted", "paused"), pendingPrompts: 7 };
		const completed = { ...entry("completed-prompted", "completed"), pendingPrompts: 3 };
		const items = workflowResumeSelectorItems([], [durable], [completed]);
		for (const item of items) {
			assert.doesNotMatch(item.session.firstMessage, /\b\d+ prompts?\b/);
			assert.doesNotMatch(item.session.allMessagesText, /\b\d+ prompts?\b/);
			assert.doesNotMatch(item.session.summary!, /checkpoints|\d+ cp/);
			assert.doesNotMatch(item.session.firstMessage, /checkpoints|\d+ cp/);
			assert.equal(item.session.messageCount, 2);
		}
	});
	test("presents a stale-heartbeat running durable row as crashed, never running", () => {
		const [item] = workflowResumeSelectorItems([], [{ ...entry("d-crashed", "running"), name: "repro-flow" }], []);
		assert.equal(item!.session.firstMessage, "d-crashed");
		assert.equal(item!.session.summary, "crashed  repro-flow");
		assert.doesNotMatch(item!.session.summary!, /running/);
		assert.equal(item!.session.messageColor, "error");
		assert.match(item!.session.allMessagesText, /crashed/);
	});
});

describe("workflow resume picker rows: a title and one detail line (#5224)", () => {
	const NOW = 10_000_000;

	test("a live run's title names the workflow and its identity; its detail is status · stage · elapsed · cost", () => {
		const run: RunSnapshot = {
			...pausedLiveRun("run-ship", NOW - 60_000),
			name: "ralph",
			label: "fix the shipping benchmark",
			startedAt: NOW - 3_000_000,
			durationMs: 41 * 60_000,
			stages: [
				{ ...stage("plan", NOW - 2_000_000), status: "completed" },
				{ ...stage("research", NOW - 1_900_000), status: "completed" },
				{ ...stage("implement", NOW - 100_000), status: "running", endedAt: undefined },
				{ ...stage("review", NOW), status: "pending", startedAt: undefined, endedAt: undefined },
				{ ...stage("verify", NOW), status: "pending", startedAt: undefined, endedAt: undefined },
			],
			budgetState: { accounting: { cost: 1.84 } } as RunSnapshot["budgetState"],
		};
		const [item] = workflowResumeSelectorItems([run], [], [], undefined, undefined, NOW);
		assert.equal(item?.session.title, "ralph · fix the shipping benchmark");
		assert.equal(item?.session.detail, "paused · stage 3/5 implement · 41m · $1.84");
	});

	test("a finished run's detail says how long ago it ended; a failed run's says why", () => {
		const completed = { ...entry("done-run", "completed", NOW - 2 * 3_600_000), name: "review-pr", label: "#5222" };
		const failed = {
			...entry("bad-run", "failed", NOW - 60_000),
			name: "goal",
			error: "Error: gate failed: 2 jobs\n    at run (x.ts:1:1)",
		};
		const items = workflowResumeSelectorItems([], [failed], [completed], undefined, undefined, NOW);
		const byId = new Map(items.map((item) => [item.session.id, item.session]));
		assert.equal(byId.get("done-run")?.title, "review-pr · #5222");
		assert.equal(byId.get("done-run")?.detail, "✓ completed · 2h ago");
		assert.equal(byId.get("bad-run")?.detail, "failed · 1m ago · ✗ gate failed: 2 jobs");
	});

	test.each(["at least one reviewer rejected the change", "at capacity: the provider is overloaded"])(
		"keeps literal failure reasons beginning with 'at': %s (#5256)",
		(reason) => {
			for (const field of ["error", "exitReason"] as const) {
				for (const prefix of ["", "    at run (runner.ts:1:2)\n", "    at runner.ts:1:2\n"]) {
					const [item] = workflowResumeSelectorItems(
						[],
						[{ ...entry("literal-reason", "failed"), [field]: prefix + reason }],
						[],
						undefined,
						undefined,
						NOW,
					);
					assert.ok(item?.session.detail?.endsWith(`✗ ${reason}`), `${field}: ${prefix + reason}`);
				}
			}
		},
	);

	test("keeps Unicode intact when shortening a workflow failure reason (#5256)", () => {
		const prefix = "x".repeat(58);
		const [item] = workflowResumeSelectorItems(
			[],
			[{ ...entry("unicode-failure", "failed"), error: `Error: ${prefix}🚀 retry failed` }],
			[],
			undefined,
			undefined,
			NOW,
		);
		assert.ok(item?.session.detail?.endsWith(`✗ ${prefix}…`));
	});

	test("a saved run's detail omits raw checkpoint counts and reports whether it waits on an answer", () => {
		const saved = { ...entry("saved-run", "paused", NOW - 120_000), completedCheckpoints: 4, pendingPrompts: 1 };
		const [item] = workflowResumeSelectorItems([], [saved], [], undefined, undefined, NOW);
		assert.equal(item?.session.detail, "paused · waiting on 1 answer · 2m ago");
	});

	test("a run without a label or objective uses its workflow description or omits the id suffix (#5256)", () => {
		const id = "11111111-1111-4111-8111-111111111111";
		const [fallbackItem] = workflowResumeSelectorItems([], [entry(id, "paused")], [], undefined, undefined, NOW);
		assert.equal(fallbackItem?.session.title, "paused-workflow");

		const [describedItem] = workflowResumeSelectorItems(
			[],
			[{ ...entry(id, "paused"), name: "slowflow" }],
			[],
			undefined,
			undefined,
			NOW,
			{ resolveDescription: (name) => (name === "slowflow" ? "Fix the shipping benchmark" : undefined) },
		);
		assert.equal(describedItem?.session.title, "slowflow · Fix the shipping benchmark");
	});

	test("durable, completed, and older durable runs render stage n/m name, age, elapsed, cost, and recorded branch instead of checkpoint counts (#5256)", async () => {
		const backend = await createMemoryTestBackend();
		const workspace = {
			remotes: ["https://example.com/repo.git"],
			head: "0123456789abcdef0123456789abcdef01234567",
			tree: "89abcdef0123456789abcdef0123456789abcdef",
			envHash: "env-hash",
			repository: "repo",
			branch: "feat/ship",
		};

		const pausedId = "aaaaaaaa-1111-4111-8111-111111111111";
		await backend.commitWorkflowRegistration({
			workflowId: pausedId,
			name: "slowflow",
			inputs: {},
			createdAt: NOW - 120_000,
			updatedAt: NOW - 60_000,
			status: "paused",
			completedCheckpoints: 2,
			possibleStages: ["plan", "implement", "review"],
			workspace,
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: pausedId,
			checkpointId: "stage:plan",
			name: "plan",
			replayKey: "stage:plan:1",
			output: "planned",
			startedAt: NOW - 120_000,
			endedAt: NOW - 90_000,
			durationMs: 30_000,
			completedAt: NOW - 90_000,
			modelAttempts: [
				{
					model: "gpt-4o",
					status: "completed",
					success: true,
					usage: { input: 100, output: 50, cost: 1.84 },
				},
			],
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: pausedId,
			checkpointId: "stage:implement",
			name: "implement",
			replayKey: "stage:implement:1",
			startedAt: NOW - 90_000,
			durationMs: 11_000,
			completedAt: NOW - 60_000,
		});

		const completedId = "bbbbbbbb-2222-4222-8222-222222222222";
		await backend.commitWorkflowRegistration({
			workflowId: completedId,
			name: "quickflow",
			inputs: {},
			createdAt: NOW - 240_000,
			updatedAt: NOW - 237_000,
			status: "completed",
			completedCheckpoints: 1,
			possibleStages: ["summarise"],
			workspace,
		});
		await backend.commitCheckpoint({
			kind: "stage",
			workflowId: completedId,
			checkpointId: "stage:summarise",
			name: "summarise",
			replayKey: "stage:summarise:1",
			output: "done",
			startedAt: NOW - 240_000,
			endedAt: NOW - 237_000,
			durationMs: 3_000,
			completedAt: NOW - 237_000,
			modelAttempts: [
				{
					model: "gpt-4o",
					status: "completed",
					success: true,
					usage: { input: 50, output: 20, cost: 0.42 },
				},
			],
		});

		const liveFailed: RunSnapshot = {
			...pausedLiveRun("cccccccc-3333-4333-8333-333333333333", NOW - 30_000),
			name: "failflow",
			status: "failed",
			startedAt: NOW - 31_000,
			endedAt: NOW - 30_000,
			durationMs: 1_000,
			error: "Error: at least one reviewer rejected the change",
			resumable: true,
			stages: [{ ...stage("draft", NOW - 30_000), status: "completed" }],
		};
		await backend.commitWorkflowRegistration({
			workflowId: liveFailed.id,
			name: "failflow",
			inputs: {},
			createdAt: NOW - 31_000,
			updatedAt: NOW - 30_000,
			status: "failed",
			resumable: true,
			completedCheckpoints: 1,
			workspace,
		});

		const items = workflowResumeSelectorItems(
			[liveFailed],
			backend.listResumableWorkflows().filter((item) => item.workflowId === pausedId),
			backend.listCompletedWorkflows(),
			[liveFailed],
			backend,
			NOW,
			{
				resolveDescription: (name) =>
					({
						slowflow: "Fix the shipping benchmark",
						quickflow: "Summarise the release notes",
						failflow: "Review the lock change",
					})[name],
			},
		);
		const byId = new Map(items.map((item) => [item.session.id, item]));
		assert.equal(byId.get(pausedId)?.session.title, "slowflow · Fix the shipping benchmark");
		assert.equal(
			byId.get(pausedId)?.session.detail,
			"paused · stage 2/3 implement · 1m ago · 1m · $1.84 · feat/ship",
		);
		assert.equal(byId.get(completedId)?.session.title, "quickflow · Summarise the release notes");
		assert.equal(
			byId.get(completedId)?.session.detail,
			"✓ completed · stage 1/1 summarise · 3m ago · 3s · $0.42 · feat/ship",
		);
		assert.equal(byId.get(liveFailed.id)?.session.title, "failflow · Review the lock change");
		assert.equal(
			byId.get(liveFailed.id)?.session.detail,
			"failed · stage 1/1 draft · just now · 1s · feat/ship · ✗ at least one reviewer rejected the change",
		);
	});

	test("labels a quit live run as paused and matches canDelete to the retention policy (#5256)", () => {
		const quitLive: RunSnapshot = {
			...pausedLiveRun("quit-live", NOW - 10_000),
			status: "running",
			exitReason: "quit",
			resumable: true,
			durationMs: 60_000,
			stages: [
				{ ...stage("plan", NOW - 50_000), status: "completed" },
				{ ...stage("build", NOW - 10_000), status: "running", endedAt: undefined },
				{ ...stage("verify", NOW), status: "pending", startedAt: undefined, endedAt: undefined },
			],
		};
		const failedLive: RunSnapshot = {
			...pausedLiveRun("failed-live", NOW - 5_000),
			status: "failed",
			endedAt: NOW - 5_000,
			durationMs: 10_000,
			resumable: true,
			error: "Error: boom",
			failedStageId: "build",
			stages: [
				{ ...stage("plan", NOW - 15_000), status: "completed" },
				{ ...stage("build", NOW - 5_000), status: "failed" },
			],
		};
		const crashedDurable = entry("crashed-durable", "running", NOW - 20_000);
		const pausedDurable = entry("paused-durable", "paused", NOW - 30_000);
		const completedDurable = entry("completed-durable", "completed", NOW - 40_000);

		const items = workflowResumeSelectorItems(
			[quitLive, failedLive],
			[crashedDurable, pausedDurable],
			[completedDurable],
			[quitLive, failedLive],
			undefined,
			NOW,
		);
		const byId = new Map(items.map((item) => [item.session.id, item]));

		assert.equal(byId.get("quit-live")?.session.detail, "paused · stage 2/3 build · 1m");
		assert.equal(byId.get("quit-live")?.session.messageColor, "warning");
		assert.equal(toWorkflowPickerRow(byId.get("quit-live")!).canDelete, false);

		assert.equal(byId.get("failed-live")?.session.detail, "failed · stage 2/2 build · just now · 10s · ✗ boom");
		assert.equal(toWorkflowPickerRow(byId.get("failed-live")!).canDelete, true);

		assert.equal(toWorkflowPickerRow(byId.get("crashed-durable")!).canDelete, false);
		assert.equal(toWorkflowPickerRow(byId.get("paused-durable")!).canDelete, true);
		assert.equal(toWorkflowPickerRow(byId.get("completed-durable")!).canDelete, true);
	});
});
