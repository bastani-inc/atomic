/**
 * Advisory persistence after a preserving `/reload` boundary must not fail an
 * in-flight run. Issue #2749: `workflow.stage.end` and `workflow.run.end`
 * escaped through a stale predecessor persistence port.
 */

import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { createExtensionAPI } from "../../packages/coding-agent/src/core/extensions/loader-api.js";
import { createExtensionRuntime as createHostExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import { ExtensionRunner, emitSessionShutdownEvent } from "../../packages/coding-agent/src/core/extensions/runner.js";
import { STALE_EXTENSION_CONTEXT_MESSAGE } from "../../packages/coding-agent/src/core/extensions/stale-context.js";
import type { Extension } from "../../packages/coding-agent/src/core/extensions/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { makePersistencePort } from "../../packages/workflows/src/extension/index.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { runDetached } from "../../packages/workflows/src/runs/background/runner.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition, WorkflowPersistencePort } from "../../packages/workflows/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

const WAIT_FOR_RUN_MS = 5_000;

function staleError(): Error {
	return new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
}

function piThrowingStaleOn(types: ReadonlySet<string>): ExtensionAPI {
	return {
		appendEntry(type) {
			if (types.has(type)) throw staleError();
			return `entry-${type}`;
		},
	};
}

function hostExtension(label: string): Extension {
	const path = `/tmp/stale-persistence-port-${label}.ts`;
	return {
		path,
		resolvedPath: path,
		sourceInfo: {
			path,
			source: "test",
			scope: "user",
			origin: "top-level",
			configurationOrigin: "bundled",
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function createHostGeneration(label: string): {
	readonly runner: ExtensionRunner;
	readonly persistence: WorkflowPersistencePort | undefined;
} {
	const runtime = createHostExtensionRuntime();
	runtime.appendEntry = () => {};
	runtime.setLabel = () => {};
	const extension = hostExtension(label);
	const { api } = createExtensionAPI(extension, runtime, "/tmp", createEventBus());
	api.on("session_shutdown", () => {});
	api.on("session_start", () => {});
	return {
		runner: new ExtensionRunner([extension], runtime, "/tmp", {} as never, {} as never),
		persistence: makePersistencePort(api as unknown as ExtensionAPI, true),
	};
}

function recordingPersistence(inner: WorkflowPersistencePort | undefined): {
	readonly persistence: WorkflowPersistencePort | undefined;
	readonly attempted: string[];
} {
	const attempted: string[] = [];
	if (inner === undefined) return { persistence: undefined, attempted };
	return {
		attempted,
		persistence: {
			appendEntry(type, payload) {
				attempted.push(type);
				return inner.appendEntry(type, payload);
			},
			setLabel: inner.setLabel,
			appendCustomMessageEntry: inner.appendCustomMessageEntry,
		},
	};
}

async function drivePreservingReloadBoundary(
	predecessor: ExtensionRunner,
	invalidatePredecessor: boolean,
): Promise<void> {
	const shutdown = await emitSessionShutdownEvent(predecessor, { type: "session_shutdown", reason: "reload" });
	assert.equal(shutdown, true);
	if (invalidatePredecessor) predecessor.invalidate();
	const successor = createHostGeneration("successor");
	await successor.runner.emit({ type: "session_start", reason: "reload" });
}

function gatedWorkflow(): {
	readonly definition: WorkflowDefinition;
	readonly adapters: StageAdapters;
	readonly release: () => void;
} {
	const gate = Promise.withResolvers<void>();
	const definition = workflow({
		name: "stale-persistence-boundary",
		description: "",
		inputs: {},
		outputs: { done: Type.Optional(Type.Boolean()) },
		run: async (ctx) => {
			const stage = ctx.stage("post-boundary");
			await stage.prompt("hello");
			return { done: true };
		},
	}) as WorkflowDefinition;
	return {
		definition,
		adapters: {
			prompt: {
				async prompt() {
					await gate.promise;
					return "ok";
				},
			},
		},
		release: () => gate.resolve(),
	};
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = WAIT_FOR_RUN_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(5);
	}
	throw new Error(message);
}

function describeOutcome(
	store: ReturnType<typeof createStore>,
	runId: string,
	raw: { ok: boolean; error: unknown },
): string {
	const run = store.runs().find((candidate) => candidate.id === runId);
	const stages = (run?.stages ?? []).map((stage) => `${stage.name}=${stage.status}`).join(",");
	const rawError = raw.error instanceof Error ? raw.error.message : raw.error === undefined ? "" : String(raw.error);
	return `run status=${run?.status ?? "missing"}; run error=${run?.error ?? ""}; stages=[${stages}]; raw executor rejection=${rawError}`;
}

async function runGatedWithPersistence(persistence: WorkflowPersistencePort | undefined): Promise<{
	readonly store: ReturnType<typeof createStore>;
	readonly runId: string;
	readonly release: () => void;
	readonly waitForSettlement: () => Promise<{ ok: boolean; error: unknown }>;
}> {
	const { definition, adapters, release } = gatedWorkflow();
	const store = createStore();
	const settled = Promise.withResolvers<{ ok: boolean; error: unknown }>();
	const accepted = runDetached(
		definition,
		{},
		{
			store,
			adapters,
			persistence,
			cancellation: createCancellationRegistry(),
			jobs: createJobTracker(),
			onRawSettled(ok: boolean, _result: RunResult | undefined, error: unknown | undefined) {
				settled.resolve({ ok, error });
			},
		},
	);
	await waitUntil(
		() =>
			store
				.runs()
				.find((run) => run.id === accepted.runId)
				?.stages.some((stage) => stage.name === "post-boundary") === true,
		`stage post-boundary did not start for ${accepted.runId}`,
	);
	return {
		store,
		runId: accepted.runId,
		release,
		waitForSettlement: () => settled.promise,
	};
}

describe("advisory persistence after a preserving session boundary", () => {
	test("workflow.stage.end stale append does not fail the run", async () => {
		const persistence = makePersistencePort(piThrowingStaleOn(new Set(["workflow.stage.end"])), true);
		const { store, runId, release, waitForSettlement } = await runGatedWithPersistence(persistence);
		release();
		const raw = await waitForSettlement();
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(
			run?.status,
			"completed",
			`advisory append must not fail the run: ${describeOutcome(store, runId, raw)}`,
		);
		assert.equal(run?.stages[0]?.status, "completed");
		assert.equal(raw.ok, true, describeOutcome(store, runId, raw));
	});

	test("workflow.run.end stale append after stage.end does not fail the run", async () => {
		const persistence = makePersistencePort(
			piThrowingStaleOn(new Set(["workflow.stage.end", "workflow.run.end"])),
			true,
		);
		const { store, runId, release, waitForSettlement } = await runGatedWithPersistence(persistence);
		release();
		const raw = await waitForSettlement();
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(
			run?.status,
			"completed",
			`advisory append must not fail the run: ${describeOutcome(store, runId, raw)}`,
		);
		assert.equal(run?.stages[0]?.status, "completed");
		assert.equal(raw.ok, true, describeOutcome(store, runId, raw));
	});

	test("real preserving reload boundary does not fail the run", async () => {
		const predecessor = createHostGeneration("predecessor");
		const recorded = recordingPersistence(predecessor.persistence);
		const { store, runId, release, waitForSettlement } = await runGatedWithPersistence(recorded.persistence);
		await drivePreservingReloadBoundary(predecessor.runner, true);
		release();
		const raw = await waitForSettlement();
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(
			run?.status,
			"completed",
			`advisory append must not fail the run: ${describeOutcome(store, runId, raw)}`,
		);
		assert.equal(run?.stages[0]?.status, "completed");
		assert.equal(raw.ok, true, describeOutcome(store, runId, raw));
		assert.equal(recorded.attempted.includes("workflow.stage.end"), true, recorded.attempted.join(","));
		assert.equal(recorded.attempted.includes("workflow.run.end"), true, recorded.attempted.join(","));
	});

	test("preserving boundary without invalidating still completes", async () => {
		const predecessor = createHostGeneration("live-predecessor");
		const recorded = recordingPersistence(predecessor.persistence);
		const { store, runId, release, waitForSettlement } = await runGatedWithPersistence(recorded.persistence);
		await drivePreservingReloadBoundary(predecessor.runner, false);
		release();
		const raw = await waitForSettlement();
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(run?.status, "completed", describeOutcome(store, runId, raw));
		assert.equal(raw.ok, true, describeOutcome(store, runId, raw));
		assert.equal(recorded.attempted.includes("workflow.stage.end"), true, recorded.attempted.join(","));
		assert.equal(recorded.attempted.includes("workflow.run.end"), true, recorded.attempted.join(","));
	});

	test("a non-stale stage.end persistence error still fails the run", async () => {
		const persistence = makePersistencePort(
			{
				appendEntry(type) {
					if (type === "workflow.stage.end") throw new Error("disk full");
					return `entry-${type}`;
				},
			},
			true,
		);
		const { store, runId, release, waitForSettlement } = await runGatedWithPersistence(persistence);
		release();
		await waitForSettlement();
		const run = store.runs().find((candidate) => candidate.id === runId);
		assert.equal(run?.status, "failed");
		assert.match(run?.error ?? "", /disk full/);
	});
});
