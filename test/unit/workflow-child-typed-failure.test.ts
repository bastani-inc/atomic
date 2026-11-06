import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import {
	findStageWaitError,
	StageRehydrationError,
	StageReleaseError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { typedFailureDetail } from "../../packages/workflows/src/shared/typed-failure-detail.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { bindChildWorkerDispatcher } from "../../packages/workflows/src/workers/dispatch.js";
import { closeMemoryTestBackends, createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { makeMockSession, type StageSessionCreateOptions } from "./stage-runner-helpers.js";

afterEach(closeMemoryTestBackends);

const REHYDRATION_FIELDS = {
	runId: "child-run",
	stageId: "waiting-stage",
	stageName: "review",
	sessionId: "session-1",
} as const;

function rehydrationFailure(): StageRehydrationError {
	return new StageRehydrationError(REHYDRATION_FIELDS, { cause: new Error("session store unreachable") });
}

/** A child whose one agent stage fails because its released session could not be reopened. */
const stageChild = workflow({
	name: "rehydrating-child",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.stage("review").prompt("Review the change");
		return {};
	},
});

const rehydrationAdapters = {
	agentSession: {
		async create(options: StageSessionCreateOptions) {
			return makeMockSession({
				model: options.model,
				async prompt() {
					throw rehydrationFailure();
				},
			}).session;
		},
	},
};

/** A parent that records the error `ctx.workflow(child)` rejects with, then fails on it. */
function catchingParent(name: string, child: WorkflowDefinition, caught: unknown[]) {
	return workflow({
		name,
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			try {
				await ctx.workflow(child);
			} catch (error) {
				caught.push(error);
				throw error;
			}
			return {};
		},
	});
}

function assertRehydrationError(error: unknown): void {
	const found = findStageWaitError(error);
	assert.ok(found instanceof StageRehydrationError, `no StageRehydrationError in ${String(error)}`);
	assert.equal(found.code, "session-unavailable");
	assert.deepEqual(found.fields, REHYDRATION_FIELDS);
	assert.equal((found.cause as Error | undefined)?.message, "session store unreachable");
}

test("a child stage that fails with StageRehydrationError puts it in the parent's error chain (#4309)", async () => {
	const caught: unknown[] = [];
	const store = createStore();

	const result = await run(
		catchingParent("root", stageChild, caught),
		{},
		{ runId: "stage-root", store, adapters: rehydrationAdapters },
	);

	assert.equal(caught.length, 1);
	assertRehydrationError(caught[0]);
	// The root's own result carries it on, as its parent or its SDK caller reads it.
	assert.equal(result.failureDetail?.name, "StageRehydrationError", JSON.stringify(result));
	assert.deepEqual(result.failureDetail?.fields, REHYDRATION_FIELDS);
	const child = store.runs().find((snapshot) => snapshot.parentRunId === "stage-root");
	const review = child?.stages.find((stage) => stage.name === "review");
	assert.equal(review?.failureDetail?.name, "StageRehydrationError");
});

test("a StageRehydrationError two child levels down reaches the root's error chain (#4309)", async () => {
	const caught: unknown[] = [];
	const middle = catchingParent("middle", stageChild, []);

	await run(catchingParent("root", middle, caught), {}, { runId: "nested-root", adapters: rehydrationAdapters });

	assert.equal(caught.length, 1);
	assertRehydrationError(caught[0]);
});

test("a typed error a child's tool throws, with no failed stage, reaches the parent's error chain (#4309)", async () => {
	const child = workflow({
		name: "releasing-child",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("release", {}, async () => {
				throw new StageReleaseError("stage-busy", { stageId: "stage-1", stageName: "review" });
			});
			return {};
		},
	});
	const caught: unknown[] = [];

	const result = await run(catchingParent("root", child, caught), {}, { runId: "tool-root" });

	const found = findStageWaitError(caught[0]);
	assert.ok(found instanceof StageReleaseError);
	assert.equal(found.code, "stage-busy");
	assert.deepEqual(found.fields, { stageId: "stage-1", stageName: "review" });
	assert.equal(result.failureDetail?.name, "StageReleaseError", JSON.stringify(result));
});

/** Runs `root` with its child dispatched the way the local worker pool returns one: a JSON result. */
async function runWithDispatchedChild(runId: string, root: WorkflowDefinition, childResult: object) {
	const backend = await createMemoryTestBackend();
	const release = bindChildWorkerDispatcher(backend, {
		validateOptions() {},
		async run(_definition, _inputs, options) {
			return JSON.parse(JSON.stringify({ ...childResult, runId: options.runId })) as RunResult;
		},
	});
	try {
		const store = createStore();
		const result = await run(root, {}, { runId, store, durableBackend: backend });
		return { result, store };
	} finally {
		release();
	}
}

const pooledChild = workflow({ name: "pooled-child", description: "", inputs: {}, outputs: {}, run: async () => ({}) });

test("a pooled child's JSON result with a failure detail fails the parent with that typed error (#4309)", async () => {
	const caught: unknown[] = [];

	await runWithDispatchedChild("pooled-root", catchingParent("root", pooledChild, caught), {
		status: "failed",
		error: "Cannot rehydrate stage",
		failureDetail: typedFailureDetail(rehydrationFailure()),
		stages: [],
		toolNodes: [],
	});

	assertRehydrationError(caught[0]);
});

test("a pooled child's malformed failure detail is reported once and the parent still fails on its text (#4309)", async () => {
	const caught: unknown[] = [];

	const { result, store } = await runWithDispatchedChild(
		"malformed-root",
		catchingParent("root", pooledChild, caught),
		{
			status: "failed",
			error: "Cannot rehydrate stage",
			failureDetail: { family: "StageWaitError", name: "StageRehydrationError", code: 5, fields: null },
			stages: [],
			toolNodes: [],
		},
	);

	assert.equal(result.status, "failed", JSON.stringify(result));
	assert.match(result.error ?? "", /child workflow "pooled-child".*Cannot rehydrate stage/);
	assert.equal(findStageWaitError(caught[0]), undefined);
	const notices = store.notices().filter((notice) => notice.runId === "malformed-root");
	assert.equal(notices.length, 1, JSON.stringify(notices));
	assert.equal(notices[0]?.level, "warning");
	assert.match(notices[0]?.id ?? "", /^child-failure-detail-ignored:malformed-root:/);
	assert.match(notices[0]?.message ?? "", /pooled-child.*typed failure that could not be read/);
});

test("a pooled child that failed without a failure detail fails the parent on its text and reports nothing (#4309)", async () => {
	const caught: unknown[] = [];

	const { result, store } = await runWithDispatchedChild("plain-root", catchingParent("root", pooledChild, caught), {
		status: "failed",
		error: "the child's own failure",
		stages: [],
		toolNodes: [],
	});

	assert.equal(result.status, "failed", JSON.stringify(result));
	assert.match(result.error ?? "", /child workflow "pooled-child".*the child's own failure/);
	assert.deepEqual(
		store.notices().filter((notice) => notice.runId === "plain-root"),
		[],
	);
});
