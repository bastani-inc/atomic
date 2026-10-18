import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { releasePausedRunsOwnedBy } from "../../packages/workflows/src/durable/sdk-owner-release.js";
import type { PiExecuteContext } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { makeExecuteWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool.js";
import { jobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { stageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const OWNER_SESSION = "disposed-owner-session";
const SUCCESSOR_SESSION = "successor-session";

function sessionClosedError(): Error {
	return Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
}

function staleContextError(): Error {
	return new Error("This extension ctx is stale after session replacement or reload.");
}

const closedSessionErrors = [
	{ label: "SessionClosed", create: sessionClosedError },
	{ label: "stale extension context", create: staleContextError },
];

function modelContext(sessionId: string): PiExecuteContext {
	return { sessionId, sessionManager: { getSessionId: () => sessionId }, cwd: process.cwd() } as PiExecuteContext;
}

/**
 * The owning session's lifetime. Disposing a session aborts `ctx.sessionSignal` before any shutdown handler runs,
 * and the workflows extension reports the owner as closing from that signal, so the tests dispose the same way.
 */
function ownerSession() {
	const lifetime = new AbortController();
	return {
		closing: () => lifetime.signal.aborted,
		dispose: () => lifetime.abort(),
	};
}

type OwnerSession = ReturnType<typeof ownerSession>;
type RuntimeDefinition = NonNullable<NonNullable<Parameters<typeof createExtensionRuntime>[0]>["definitions"]>[number];

const stageWorkflow = workflow({
	name: "dispose-paused",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.tool("checkpoint", {}, async () => "checkpointed");
		await ctx.stage("step").prompt("work");
		return {};
	},
});

function throwingWorkflow(raised: Error): RuntimeDefinition {
	return workflow({
		name: "dispose-paused",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.tool("checkpoint", {}, async () => "checkpointed");
			throw raised;
		},
	});
}

function setup(definition: RuntimeDefinition, owner: OwnerSession, createStageSession: () => Promise<never>) {
	const runtime = createExtensionRuntime({
		definitions: [definition],
		store,
		adapters: { agentSession: { create: createStageSession }, ownerSessionClosing: owner.closing },
	});
	return makeExecuteWorkflowTool(
		runtime,
		() => undefined,
		() => undefined,
	);
}

async function launch(execute: ReturnType<typeof setup>): Promise<string> {
	const result = await execute({ action: "run", workflow: "dispose-paused", inputs: {} }, modelContext(OWNER_SESSION));
	assert.ok("runId" in result && result.runId !== undefined, JSON.stringify(result));
	return result.runId;
}

beforeEach(async () => {
	store.clear();
	setDurableBackend(await createMemoryTestBackend());
});

afterEach(() => {
	stageControlRegistry.clear();
	store.clear();
	setDurableBackend(undefined);
});

describe("a disposed session leaves its workflow runs paused and resumable", () => {
	for (const { label, create } of closedSessionErrors) {
		test.sequential(`keeps a quit-paused run paused when its session is disposed (${label}) (#3742)`, async () => {
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			const owner = ownerSession();
			const stageCreation = Promise.withResolvers<void>();
			const stageCreationStarted = Promise.withResolvers<void>();
			const execute = setup(stageWorkflow, owner, async () => {
				stageCreationStarted.resolve();
				await stageCreation.promise;
				throw create();
			});
			const runId = await launch(execute);
			const job = jobTracker.get(runId);
			assert.ok(job, "the run must be tracked while it executes");
			await stageCreationStarted.promise;

			const quit = await execute({ action: "quit", runId }, modelContext(OWNER_SESSION));
			assert.equal("code" in quit, false, JSON.stringify(quit));
			await vi.waitFor(() => assert.equal(backend.getWorkflow(runId)?.status, "paused"));
			owner.dispose();
			await releasePausedRunsOwnedBy(backend, OWNER_SESSION);
			assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, OWNER_SESSION);

			stageCreation.resolve();
			await job.promise;

			assert.equal(backend.getWorkflow(runId)?.status, "paused");
			assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, OWNER_SESSION);
			assert.equal(store.runs().find((run) => run.id === runId)?.status, "paused");

			const adopted = await execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION));
			assert.equal("code" in adopted, false, JSON.stringify(adopted));
			assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
		});

		test.sequential(`pauses a run whose stage was mid-step when its session was disposed (${label}) (#3742)`, async () => {
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			const owner = ownerSession();
			const stageCreation = Promise.withResolvers<void>();
			const stageCreationStarted = Promise.withResolvers<void>();
			const execute = setup(stageWorkflow, owner, async () => {
				stageCreationStarted.resolve();
				await stageCreation.promise;
				throw create();
			});
			const runId = await launch(execute);
			const job = jobTracker.get(runId);
			assert.ok(job, "the run must be tracked while it executes");
			await stageCreationStarted.promise;

			owner.dispose();
			stageCreation.resolve();
			await job.promise;

			const snapshot = store.runs().find((run) => run.id === runId);
			assert.equal(snapshot?.status, "paused", JSON.stringify(snapshot));
			assert.equal(snapshot?.exitReason, "quit");
			assert.equal(snapshot?.endedAt, undefined);
			assert.equal(backend.getWorkflow(runId)?.status, "paused");

			await releasePausedRunsOwnedBy(backend, OWNER_SESSION);
			const adopted = await execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION));
			assert.equal("code" in adopted, false, JSON.stringify(adopted));
			assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
		});
	}

	test.sequential("pauses a root run whose nested child's stage hit the closed session and lets a successor resume it (#3742)", async () => {
		const backend = await createMemoryTestBackend();
		setDurableBackend(backend);
		const owner = ownerSession();
		const child = workflow({
			name: "dispose-paused-child",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("child-step").prompt("work");
				return {};
			},
		});
		const nested = workflow({
			name: "dispose-paused",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("checkpoint", {}, async () => "checkpointed");
				await ctx.workflow(child);
				return {};
			},
		});
		const stageCreation = Promise.withResolvers<void>();
		const stageCreationStarted = Promise.withResolvers<void>();
		let stageCreations = 0;
		const execute = setup(nested, owner, async () => {
			stageCreations++;
			stageCreationStarted.resolve();
			await stageCreation.promise;
			throw sessionClosedError();
		});
		const runId = await launch(execute);
		const job = jobTracker.get(runId);
		assert.ok(job, "the run must be tracked while it executes");
		await stageCreationStarted.promise;

		owner.dispose();
		stageCreation.resolve();
		await job.promise;

		const root = store.runs().find((run) => run.id === runId);
		assert.equal(root?.status, "paused", JSON.stringify(root));
		assert.equal(root?.exitReason, "quit");
		assert.equal(root?.endedAt, undefined);
		assert.equal(backend.getWorkflow(runId)?.status, "paused");
		assert.equal(stageCreations, 1);

		await releasePausedRunsOwnedBy(backend, OWNER_SESSION);
		const adopted = await execute({ action: "resume", runId }, modelContext(SUCCESSOR_SESSION));
		assert.equal("code" in adopted, false, JSON.stringify(adopted));
		assert.equal(backend.getWorkflow(runId)?.modelOwner, SUCCESSOR_SESSION);
		await vi.waitFor(() => assert.equal(stageCreations, 2), { timeout: 10_000 });
		await jobTracker.get(runId)?.promise;
	});
});

describe("a closed-session error from a live session still fails the run", () => {
	const domainError = () => new Error("upload failed: remote session closed", { cause: sessionClosedError() });
	const cases = [
		{ label: "an author-thrown SessionClosed error", where: "body", create: sessionClosedError },
		{ label: "a domain error caused by a SessionClosed error", where: "body", create: domainError },
		{ label: "a stage adapter throwing SessionClosed", where: "stage", create: sessionClosedError },
		{ label: "a stage adapter throwing a stale extension context error", where: "stage", create: staleContextError },
	] as const;

	for (const { label, where, create } of cases) {
		test.sequential(`does not pause a run on ${label} while its owner is alive (#3742)`, async () => {
			const backend = await createMemoryTestBackend();
			setDurableBackend(backend);
			const owner = ownerSession();
			const raised = create();
			const definition = where === "body" ? throwingWorkflow(raised) : stageWorkflow;
			const execute = setup(definition, owner, async () => {
				throw raised;
			});
			const runId = await launch(execute);
			const job = jobTracker.get(runId);
			assert.ok(job, "the run must be tracked while it executes");
			await job.promise;

			const snapshot = store.runs().find((run) => run.id === runId);
			assert.equal(snapshot?.status, "failed", JSON.stringify(snapshot));
			assert.notEqual(snapshot?.exitReason, "quit");
			assert.ok(snapshot?.error?.includes(raised.message), `the original error must be kept: ${snapshot?.error}`);
			assert.equal(backend.getWorkflow(runId)?.status, "failed");
			assert.equal(backend.getWorkflow(runId)?.releasedModelOwner, undefined);
		});
	}
});
