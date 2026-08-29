/**
 * Tests for the DBOS-backed durable backend adapter and checkpoint envelope
 * encode/decode. Read-side hydration tests live in
 * `durable-dbos-hydration.test.ts`; the shared mock DBOS SDK lives in
 * `durable-dbos-backend-helpers.ts`.
 *
 * cross-ref: issue #1498 — DBOS read-side hydration.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import { durableHash } from "../../packages/workflows/src/durable/backend.js";
import { DbosDurableBackend, type DbosSdkHandle } from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	type DbosCheckpointEnvelope,
	decodeToCheckpoint,
	encodeCheckpoint,
	isCheckpointEnvelope,
} from "../../packages/workflows/src/durable/dbos-envelope.js";
import { ScopedDurableBackend } from "../../packages/workflows/src/durable/scoped-backend.js";
import type {
	DurableStageCheckpoint,
	DurableToolCheckpoint,
	DurableUiCheckpoint,
} from "../../packages/workflows/src/durable/types.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";

// ---------------------------------------------------------------------------
// DBOS adapter delegation tests (existing behavior)
// ---------------------------------------------------------------------------

describe("DbosDurableBackend (mock SDK)", () => {
	let sdk: ReturnType<typeof createMockSdk>;
	let backend: DbosDurableBackend;

	beforeEach(() => {
		sdk = createMockSdk();
		backend = new DbosDurableBackend(sdk);
	});

	test("registerWorkflow delegates to DBOS startWorkflow", async () => {
		backend.registerWorkflow({
			workflowId: "wf-dbos-1",
			name: "dbos-workflow",
			inputs: { task: "analyze" },
			createdAt: Date.now(),
			status: "running",
		});
		await backend.flush();
		assert.equal(sdk.state.starts.length, 1);
		assert.equal(sdk.state.starts[0]!.workflowId, "wf-dbos-1");
		assert.equal(sdk.state.starts[0]!.name, "dbos-workflow");
		assert.equal(backend.getWorkflow("wf-dbos-1")!.name, "dbos-workflow");
	});

	test("recordCheckpoint stores envelope in DBOS", async () => {
		backend.registerWorkflow({
			workflowId: "wf-2",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		const hash = durableHash({ name: "fetch", args: {} });
		const cp: DurableToolCheckpoint = {
			kind: "tool",
			workflowId: "wf-2",
			checkpointId: "cp-1",
			name: "fetch-data",
			argsHash: hash,
			output: "result",
			completedAt: Date.now(),
		};
		backend.recordCheckpoint(cp);
		await backend.flush();
		assert.equal([...sdk.state.steps.keys()].filter((k) => k.includes(":checkpoint:__atomic_metadata")).length, 2);
		const stored = sdk.state.steps.get("wf-2:checkpoint:cp-1");
		assert.ok(isCheckpointEnvelope(stored));
		const env = stored as DbosCheckpointEnvelope;
		assert.equal(env.kind, "tool");
		assert.equal(env.argsHash, hash);
		assert.equal(env.output, "result");
	});

	test("deleteWorkflow removes DBOS data and suppresses the handle", async () => {
		backend.registerWorkflow({ workflowId: "wf-delete", name: "delete", inputs: {}, createdAt: 1, status: "paused" });
		await backend.flush();
		await backend.deleteWorkflow("wf-delete");
		await backend.flush();
		assert.deepEqual(sdk.state.deletions, ["wf-delete"]);
		assert.equal(backend.getWorkflow("wf-delete"), undefined);
		assert.equal(backend.isWorkflowLoadable("wf-delete"), false);
	});

	test("deleteWorkflowIfInactive refuses running state and deletes paused state", async () => {
		backend.registerWorkflow({
			workflowId: "wf-running",
			name: "running",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		backend.registerWorkflow({ workflowId: "wf-paused", name: "paused", inputs: {}, createdAt: 1, status: "paused" });
		await backend.flush();
		assert.deepEqual(await backend.deleteWorkflowIfInactive("wf-running"), { ok: false, reason: "running" });
		assert.deepEqual(await backend.deleteWorkflowIfInactive("wf-paused"), { ok: true });
		assert.equal(backend.getWorkflow("wf-paused"), undefined);
	});

	test("stage checkpoint envelope round-trips hydration metadata", () => {
		const usage = {
			input: 101,
			output: 23,
			cacheRead: 47,
			cacheWrite: 5,
			cost: 0.0042,
			turns: 2,
		};
		const cp: DurableStageCheckpoint = {
			kind: "stage",
			workflowId: "wf-stage-meta",
			checkpointId: "stage:review:1",
			name: "review",
			replayKey: "stage:review:1",
			output: { verdict: "pass" },
			completedAt: 3000,
			startedAt: 1000,
			endedAt: 3000,
			durationMs: 2000,
			result: "review passed",
			sessionId: "sid",
			sessionFile: "/tmp/review.jsonl",
			model: "gpt-test",
			fastMode: true,
			attemptedModels: ["gpt-test"],
			modelAttempts: [{ model: "gpt-test", success: true, usage }],
			structured: { verdict: "pass", confidence: 0.9 },
			artifacts: [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }],
			warnings: ["used fallback model"],
			topology: { version: 1, stageId: "review", parentIds: [] },
		};

		const env = encodeCheckpoint(cp);
		assert.equal(env.startedAt, 1000);
		assert.equal(env.durationMs, 2000);
		assert.equal(env.result, "review passed");
		assert.deepEqual(env.attemptedModels, ["gpt-test"]);
		const encodedAttempts = env.modelAttempts;
		assert.ok(Array.isArray(encodedAttempts));
		const encodedAttempt = encodedAttempts[0];
		assert.ok(encodedAttempt !== null && typeof encodedAttempt === "object" && !Array.isArray(encodedAttempt));
		assert.deepEqual(encodedAttempt.usage, usage);

		const decoded = decodeToCheckpoint("wf-stage-meta", "stage:review:1", env);
		assert.ok(decoded?.kind === "stage");
		assert.equal(decoded.startedAt, 1000);
		assert.equal(decoded.endedAt, 3000);
		assert.equal(decoded.durationMs, 2000);
		assert.equal(decoded.result, "review passed");
		assert.equal(decoded.model, "gpt-test");
		assert.equal(decoded.fastMode, true);
		assert.deepEqual(decoded.attemptedModels, ["gpt-test"]);
		assert.equal(decoded.modelAttempts?.[0]?.success, true);
		assert.deepEqual(decoded.modelAttempts?.[0]?.usage, usage);
		assert.deepEqual(decoded.structured, { verdict: "pass", confidence: 0.9 });
		assert.deepEqual(decoded.artifacts, [{ kind: "diff", path: "/tmp/review.diff", taskName: "review" }]);
		assert.deepEqual(decoded.warnings, ["used fallback model"]);
	});

	test("stage checkpoint without model usage round-trips without a usage property", () => {
		const cp: DurableStageCheckpoint = {
			kind: "stage",
			workflowId: "wf-stage-nousage",
			checkpointId: "stage:review:2",
			name: "review",
			replayKey: "stage:review:2",
			output: { verdict: "pass" },
			completedAt: 3000,
			topology: { version: 1, stageId: "review", parentIds: [] },
			modelAttempts: [{ model: "gpt-test", success: true }],
		};

		const env = encodeCheckpoint(cp);
		assert.ok(Array.isArray(env.modelAttempts));
		const encodedAttempt = env.modelAttempts[0];
		assert.ok(encodedAttempt !== null && typeof encodedAttempt === "object" && !Array.isArray(encodedAttempt));
		assert.equal(Object.hasOwn(encodedAttempt, "usage"), false);
		const decoded = decodeToCheckpoint("wf-stage-nousage", "stage:review:2", env);
		assert.ok(decoded?.kind === "stage");
		assert.equal(Object.hasOwn(decoded.modelAttempts?.[0] ?? {}, "usage"), false);
	});

	test("rejects non-numeric, non-finite, or negative nested model usage at the decode boundary", () => {
		const cp: DurableStageCheckpoint = {
			kind: "stage",
			workflowId: "wf-stage-malformed",
			checkpointId: "stage:review:3",
			name: "review",
			replayKey: "stage:review:3",
			output: { verdict: "pass" },
			completedAt: 3000,
			topology: { version: 1, stageId: "review", parentIds: [] },
			modelAttempts: [{ model: "gpt-test", success: true }],
		};
		const base = encodeCheckpoint(cp);
		const malformedEnvelopes: DbosCheckpointEnvelope[] = [
			{
				...base,
				modelAttempts: [
					{
						model: "gpt-test",
						success: true,
						usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: "0.0042", turns: 1 },
					},
				],
			},
			{
				...base,
				modelAttempts: [
					{
						model: "gpt-test",
						success: true,
						usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: Number.POSITIVE_INFINITY, turns: 1 },
					},
				],
			},
			{
				...base,
				modelAttempts: [
					{
						model: "gpt-test",
						success: true,
						usage: { input: 1, output: 2, cacheRead: -3, cacheWrite: 4, cost: 0.0042, turns: 1 },
					},
				],
			},
		];
		for (const env of malformedEnvelopes) {
			assert.equal(decodeToCheckpoint("wf-stage-malformed", "stage:review:3", env), undefined);
		}
	});

	test("flush waits for queued async checkpoint writes", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delayedSdk = createMockSdk();
		let persisted = false;
		const baseRecord = delayedSdk.recordStepOutput;
		const slowSdk: DbosSdkHandle = {
			...delayedSdk,
			async recordStepOutput(workflowId, stepName, output) {
				await gate;
				await baseRecord(workflowId, stepName, output);
				if (stepName === "cp-delayed") persisted = true;
			},
		};
		const slowBackend = new DbosDurableBackend(slowSdk);
		slowBackend.registerWorkflow({
			workflowId: "wf-delay",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		const hash = durableHash({ name: "fetch", args: {} });
		slowBackend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-delay",
			checkpointId: "cp-delayed",
			name: "fetch",
			argsHash: hash,
			output: "result",
			completedAt: Date.now(),
		});
		const flushed = slowBackend.flush().then(() => "flushed");
		await Promise.resolve();
		assert.equal(persisted, false);
		release();
		assert.equal(await flushed, "flushed");
		assert.equal(persisted, true);
	});

	test("a hung workflow write does not block an independent workflow lane", async () => {
		const blocked = Promise.withResolvers<void>();
		const persistStarted = Promise.withResolvers<void>();
		const events: string[] = [];
		const laneSdk: DbosSdkHandle = {
			...sdk,
			async startWorkflow(workflowId, name, inputs) {
				events.push(`start:${workflowId}`);
				await sdk.startWorkflow(workflowId, name, inputs);
			},
			async recordStepOutput(workflowId, stepName, output) {
				events.push(`write:${workflowId}:${stepName}`);
				if (workflowId === "wf-blocked" && stepName === "cp-blocked") {
					persistStarted.resolve();
					await blocked.promise;
				}
				await sdk.recordStepOutput(workflowId, stepName, output);
			},
		};
		const laneBackend = new DbosDurableBackend(laneSdk);
		laneBackend.registerWorkflow({
			workflowId: "wf-blocked",
			name: "blocked",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		await laneBackend.flush("wf-blocked");
		laneBackend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-blocked",
			checkpointId: "cp-blocked",
			name: "blocked",
			argsHash: durableHash({ name: "blocked", args: {} }),
			output: "blocked",
			completedAt: Date.now(),
		});
		await persistStarted.promise;

		laneBackend.registerWorkflow({
			workflowId: "wf-independent",
			name: "independent",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		await laneBackend.flush("wf-independent");
		assert.ok(events.includes("start:wf-independent"));

		laneBackend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-blocked",
			checkpointId: "cp-after-blocked",
			name: "after-blocked",
			argsHash: durableHash({ name: "after-blocked", args: {} }),
			output: "after",
			completedAt: Date.now(),
		});
		let globalFlushed = false;
		const globalFlush = laneBackend.flush().then(() => {
			globalFlushed = true;
		});
		await Promise.resolve();
		assert.equal(globalFlushed, false);
		assert.equal(
			events.some((event) => event === "write:wf-blocked:cp-after-blocked"),
			false,
		);

		blocked.resolve();
		await globalFlush;
		assert.equal(globalFlushed, true);
		assert.ok(events.indexOf("write:wf-blocked:cp-blocked") < events.indexOf("write:wf-blocked:cp-after-blocked"));
	});

	test("workflow-scoped flushes surface only their lane's fatal errors", async () => {
		const events: string[] = [];
		const failingSdk: DbosSdkHandle = {
			...sdk,
			async recordStepOutput(workflowId, stepName, output) {
				events.push(`write:${workflowId}:${stepName}`);
				if (workflowId === "wf-failing" && stepName === "cp-failing") throw new Error("lane write failed");
				await sdk.recordStepOutput(workflowId, stepName, output);
			},
		};
		const laneBackend = new DbosDurableBackend(failingSdk);
		for (const workflowId of ["wf-failing", "wf-healthy"]) {
			laneBackend.registerWorkflow({
				workflowId,
				name: workflowId,
				inputs: {},
				createdAt: Date.now(),
				status: "running",
			});
		}
		await laneBackend.flush();
		laneBackend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-failing",
			checkpointId: "cp-failing",
			name: "failing",
			argsHash: durableHash({ name: "failing", args: {} }),
			output: "failure",
			completedAt: Date.now(),
		});
		laneBackend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-healthy",
			checkpointId: "cp-healthy",
			name: "healthy",
			argsHash: durableHash({ name: "healthy", args: {} }),
			output: "success",
			completedAt: Date.now(),
		});

		await laneBackend.flush("wf-healthy");
		await assert.rejects(() => laneBackend.flush("wf-failing"), /lane write failed/);
		laneBackend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-failing",
			checkpointId: "cp-recovered",
			name: "recovered",
			argsHash: durableHash({ name: "recovered", args: {} }),
			output: "recovered",
			completedAt: Date.now(),
		});
		await laneBackend.flush("wf-failing");
		assert.ok(events.includes("write:wf-failing:cp-recovered"));
	});

	test("a child workflow flush stays on its physical root lane", async () => {
		const rootWorkflowId = "wf-scoped-root";
		backend.registerWorkflow({
			workflowId: rootWorkflowId,
			name: "root",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		await backend.flush(rootWorkflowId);
		const scoped = new ScopedDurableBackend(backend, {
			rootWorkflowId,
			scopePrefix: "workflow:child:1",
		});
		await scoped.recordCheckpointAsync({
			kind: "tool",
			workflowId: "child-run-id",
			checkpointId: "child-checkpoint",
			name: "child-tool",
			argsHash: "child-hash",
			output: "child-output",
			completedAt: Date.now(),
		});
		await scoped.flush("child-run-id");

		assert.ok([...sdk.state.steps.keys()].some((key) => key.startsWith(`${rootWorkflowId}:checkpoint:`)));
		assert.equal(backend.getWorkflow("child-run-id"), undefined);
	});

	test("flush propagates queued async checkpoint write failures", async () => {
		const failingSdk: DbosSdkHandle = {
			...sdk,
			async recordStepOutput() {
				throw new Error("dbos write failed");
			},
		};
		const failingBackend = new DbosDurableBackend(failingSdk);
		failingBackend.registerWorkflow({
			workflowId: "wf-fail-write",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		const hash = durableHash({ name: "fetch", args: {} });
		failingBackend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-fail-write",
			checkpointId: "cp-fail",
			name: "fetch",
			argsHash: hash,
			output: "result",
			completedAt: Date.now(),
		});
		await assert.rejects(() => failingBackend.flush(), /dbos write failed/);
	});

	test("recordCheckpointAsync does not update replay mirror before DBOS accepts", async () => {
		const hash = durableHash({ name: "fetch", args: {}, ordinal: 1 });
		const failingBackend = new DbosDurableBackend({
			...sdk,
			async recordStepOutput() {
				throw new Error("dbos write failed");
			},
		});
		failingBackend.registerWorkflow({
			workflowId: "wf-async-fail",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		await assert.rejects(
			() =>
				failingBackend.recordCheckpointAsync!({
					kind: "tool",
					workflowId: "wf-async-fail",
					checkpointId: `tool:${hash}`,
					name: "fetch",
					argsHash: hash,
					output: "result",
					completedAt: Date.now(),
				}),
			/dbos write failed/,
		);
		assert.equal(failingBackend.getToolOutput("wf-async-fail", hash), undefined);
	});

	test("aborting a hung recordCheckpointAsync lets flush settle", async () => {
		const controller = new AbortController();
		const persistStarted = Promise.withResolvers<void>();
		const hanging = new DbosDurableBackend({
			...sdk,
			async recordStepOutput(workflowId, stepName, output) {
				if (stepName.startsWith("task:")) {
					persistStarted.resolve();
					await new Promise<never>(() => {});
				}
				await sdk.recordStepOutput(workflowId, stepName, output);
			},
		});
		hanging.registerWorkflow({
			workflowId: "wf-hung-checkpoint",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		await hanging.flush();
		const pending = hanging.recordCheckpointAsync(
			{
				kind: "stage",
				workflowId: "wf-hung-checkpoint",
				checkpointId: "task:stage:task:review:1",
				name: "review",
				replayKey: "stage:task:review:1",
				output: { name: "review", stageName: "review", text: "review" },
				completedAt: Date.now(),
			},
			{ signal: controller.signal },
		);
		await persistStarted.promise;
		controller.abort(new Error("cancelled during persist"));
		await assert.rejects(pending, /cancelled during persist/);
		await hanging.flush();
	});

	test("same-process hydration recovers a DBOS checkpoint that never reached the memory mirror", async () => {
		const workflowId = "wf-abort-after-persist";
		const replayKey = "stage:task:review:1";
		backend.registerWorkflow({
			workflowId,
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		await backend.flush();
		await sdk.recordStepOutput(
			workflowId,
			`task:${replayKey}`,
			encodeCheckpoint({
				kind: "stage",
				workflowId,
				checkpointId: `task:${replayKey}`,
				name: "review",
				replayKey,
				output: { name: "review", stageName: "review", text: "review", structured: null },
				completedAt: Date.now(),
			}),
		);
		assert.equal(backend.getStageOutput(workflowId, replayKey), undefined);
		await backend.hydrateWorkflow(workflowId);
		assert.deepEqual(backend.getStageOutput(workflowId, replayKey), {
			name: "review",
			stageName: "review",
			text: "review",
			structured: null,
		});
	});

	test("same-process hydration rejects unknown checkpoints", async () => {
		const workflowId = "wf-same-process-unknown";
		const hash = durableHash({ name: "side-effect", args: {} });
		backend.registerWorkflow({
			workflowId,
			name: "unknown-history",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await sdk.recordStepOutput(workflowId, `tool:${hash}`, { not: "an envelope" });
		await backend.hydrateWorkflow(workflowId);
		assert.equal(backend.isWorkflowLoadable(workflowId), false);
		assert.equal(backend.getWorkflow(workflowId), undefined);
		assert.equal(backend.getToolOutput(workflowId, hash), undefined);
	});

	test("cancelWorkflow delegates to DBOS cancelWorkflow", async () => {
		backend.registerWorkflow({
			workflowId: "wf-3",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		backend.setWorkflowStatus("wf-3", "cancelled");
		await backend.flush();
		assert.equal(sdk.state.cancels.length, 1);
		assert.equal(sdk.state.cancels[0], "wf-3");
		assert.equal(backend.getWorkflow("wf-3")!.status, "cancelled");
	});

	test("resume sets running status and delegates to DBOS resumeWorkflow", async () => {
		backend.registerWorkflow({
			workflowId: "wf-4",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "paused",
		});
		backend.setWorkflowStatus("wf-4", "running");
		await backend.flush();
		assert.equal(sdk.state.resumes.length, 1);
		assert.equal(sdk.state.resumes[0], "wf-4");
		assert.equal(backend.getWorkflow("wf-4")!.status, "running");
	});

	test("versioned metadata hydrates latest mutable status and checkpoint count", async () => {
		backend.registerWorkflow({
			workflowId: "wf-meta-update",
			name: "test",
			inputs: {},
			createdAt: 1,
			status: "running",
		});
		await backend.flush();
		await new Promise((resolve) => setTimeout(resolve, 1));
		const hash = durableHash({ name: "tool", args: {}, ordinal: 1 });
		await backend.recordCheckpointAsync({
			kind: "tool",
			workflowId: "wf-meta-update",
			checkpointId: `tool:${hash}`,
			name: "tool",
			argsHash: hash,
			output: "done",
			completedAt: Date.now(),
		});
		await new Promise((resolve) => setTimeout(resolve, 1));
		backend.setWorkflowStatus("wf-meta-update", "failed");
		await backend.flush();

		const fresh = new DbosDurableBackend(sdk);
		await fresh.hydrateWorkflow("wf-meta-update");
		const handle = fresh.getWorkflow("wf-meta-update")!;
		assert.equal(handle.status, "failed");
		assert.equal(handle.completedCheckpoints, 1);
	});

	test("getToolOutput reads from in-memory mirror", () => {
		backend.registerWorkflow({
			workflowId: "wf-5",
			name: "test",
			inputs: {},
			createdAt: Date.now(),
			status: "running",
		});
		const hash = durableHash({ name: "compute", args: { x: 1 } });
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: "wf-5",
			checkpointId: "cp-1",
			name: "compute",
			argsHash: hash,
			output: 42,
			completedAt: Date.now(),
		});
		assert.equal(backend.getToolOutput("wf-5", hash), 42);
	});
});

// ---------------------------------------------------------------------------
// Envelope encode/decode tests
// ---------------------------------------------------------------------------

describe("DBOS checkpoint envelope", () => {
	test("encodeCheckpoint produces a valid envelope for tool", () => {
		const cp: DurableToolCheckpoint = {
			kind: "tool",
			workflowId: "w",
			checkpointId: "cp1",
			name: "n",
			argsHash: "h1",
			output: 42,
			completedAt: 100,
		};
		const env = encodeCheckpoint(cp);
		assert.ok(isCheckpointEnvelope(env));
		assert.equal(env.kind, "tool");
		assert.equal(env.argsHash, "h1");
		assert.equal(env.output, 42);
	});

	test("encodeCheckpoint produces a valid envelope for ui", () => {
		const cp: DurableUiCheckpoint = {
			kind: "ui",
			workflowId: "w",
			checkpointId: "cp2",
			promptKind: "input",
			message: "?",
			promptHash: "h2",
			response: "A",
			completedAt: 200,
		};
		const env = encodeCheckpoint(cp);
		assert.equal(env.kind, "ui");
		assert.equal(env.promptHash, "h2");
		assert.equal(env.promptKind, "input");
	});

	test("encode → decode round-trip preserves all fields", () => {
		const cp: DurableStageCheckpoint = {
			kind: "stage",
			workflowId: "w",
			checkpointId: "cp3",
			name: "build",
			replayKey: "stage:build:1",
			output: "ok",
			completedAt: 300,
			topology: { version: 1, stageId: "build", parentIds: [] },
		};
		const env = encodeCheckpoint(cp);
		const decoded = decodeToCheckpoint("w", "cp3", env);
		assert.ok(decoded !== undefined);
		assert.equal(decoded!.kind, "stage");
		const s = decoded as DurableStageCheckpoint;
		assert.equal(s.replayKey, "stage:build:1");
		assert.equal(s.output, "ok");
		assert.equal(s.checkpointId, "cp3");
	});

	test("rejects marked return-mode tool checkpoints with a malformed outcome", () => {
		const cp: DurableToolCheckpoint = {
			kind: "tool",
			workflowId: "w",
			checkpointId: "bad-return-outcome",
			name: "check",
			argsHash: "bad-hash",
			output: "not-an-outcome",
			outcomeKind: "return_failure",
			completedAt: 400,
		};
		const env = encodeCheckpoint(cp);

		assert.equal(decodeToCheckpoint("w", "bad-return-outcome", env), undefined);
	});
	test("isCheckpointEnvelope rejects plain values", () => {
		assert.equal(isCheckpointEnvelope("hello"), false);
		assert.equal(isCheckpointEnvelope(42), false);
		assert.equal(isCheckpointEnvelope({ foo: 1 }), false);
		assert.equal(isCheckpointEnvelope(null), false);
	});
});
