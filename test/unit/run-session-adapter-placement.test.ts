/**
 * Run-level session adapter placement ("the run, not the stage, is the unit of
 * remote placement"):
 *  - the launch selector is recorded on the run snapshot once at launch;
 *  - every stage session of the run resolves through the named adapter;
 *  - stage snapshots never carry the selector;
 *  - a continuation inherits the source run's placement instead of
 *    recomputing it, and an explicit launch selector wins over inheritance;
 *  - runs without a launch selector keep the local session runtime.
 *
 * cross-ref: src/engine/run.ts, src/runs/foreground/executor-stage-factory.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	SESSION_ADAPTER_PROTOCOL_VERSION,
	SessionAdapterRegistry,
} from "../../packages/workflows/src/runs/foreground/session-adapter-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { SessionAdapterSelector } from "../../packages/workflows/src/shared/types.js";
import { mockSession, Type } from "./executor-shared.js";

type Store = ReturnType<typeof createStore>;

const REMOTE: SessionAdapterSelector = { name: "remote-pi", config: { profile: "example-profile" } };
const OTHER: SessionAdapterSelector = { name: "remote-pi-alt", config: { profile: "alt-profile" } };

const definition = workflow({
	name: "goal",
	description: "single-stage workflow used to exercise run-level adapter placement",
	inputs: {},
	outputs: { result: Type.String() },
	run: async (ctx) => {
		const stage = await ctx.task("implement", { prompt: "do the work" });
		return { result: stage.text };
	},
});

/** Named adapters plus a default local adapter; counts creations per name. */
function namedAdapters(selectors: readonly SessionAdapterSelector[]) {
	const registry = new SessionAdapterRegistry();
	const creates = new Map<string, number>();
	for (const selector of selectors) {
		registry.register({
			version: SESSION_ADAPTER_PROTOCOL_VERSION,
			name: selector.name,
			adapter: {
				async create() {
					creates.set(selector.name, (creates.get(selector.name) ?? 0) + 1);
					return mockSession();
				},
			},
		});
	}
	return {
		creates,
		adapters: {
			agentSession: {
				async create() {
					return mockSession();
				},
			},
			sessionAdapters: registry,
		},
	};
}

/** A terminal failed run that a continuation can legitimately resume from. */
function failedSourceRun(store: Store, id: string, sessionAdapter?: SessionAdapterSelector): RunSnapshot {
	store.recordRunStart({
		id,
		name: "goal",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
		...(sessionAdapter === undefined ? {} : { sessionAdapter }),
	});
	store.recordStageStart(id, { id: "implement", name: "implement", status: "running", parentIds: [], toolEvents: [] });
	store.recordStageEnd(id, {
		id: "implement",
		name: "implement",
		status: "failed",
		parentIds: [],
		toolEvents: [],
		error: "boom",
	});
	store.recordRunEnd(id, "failed", {}, "boom");
	const source = store.runs().find((candidate) => candidate.id === id);
	assert.ok(source);
	return structuredClone(source);
}

describe("run-level session adapter placement", () => {
	test("launch selector is recorded on the run, drives the stage session, and stays off stages", async () => {
		const store = createStore();
		const { adapters, creates } = namedAdapters([REMOTE]);
		await run(
			definition,
			{},
			{
				runId: "run-launch",
				store,
				durableBackend: new InMemoryDurableBackend(),
				sessionAdapter: REMOTE,
				adapters,
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "run-launch");
		assert.ok(snapshot);
		assert.deepEqual(snapshot.sessionAdapter, REMOTE, "recorded once at run launch");
		for (const stage of snapshot.stages) {
			assert.equal("sessionAdapter" in stage, false, "stage snapshots never carry the selector");
		}
		assert.equal(creates.get("remote-pi"), 1, "the stage session is created through the named adapter");
	});

	test("a continuation inherits the source run's placement instead of recomputing it", async () => {
		const store = createStore();
		const source = failedSourceRun(store, "run-src", REMOTE);
		const { adapters, creates } = namedAdapters([REMOTE]);
		await run(
			definition,
			{},
			{
				runId: "run-cont",
				store,
				durableBackend: new InMemoryDurableBackend(),
				continuation: { source, resumeFromStageId: "implement" },
				adapters,
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "run-cont");
		assert.ok(snapshot);
		assert.deepEqual(snapshot.sessionAdapter, REMOTE, "inherited from the continued source run");
		assert.equal(creates.get("remote-pi"), 1, "the resumed stage session stays remote");
	});

	test("an explicit launch selector overrides the inherited placement", async () => {
		const store = createStore();
		const source = failedSourceRun(store, "run-src-alt", REMOTE);
		const { adapters, creates } = namedAdapters([REMOTE, OTHER]);
		await run(
			definition,
			{},
			{
				runId: "run-cont-alt",
				store,
				durableBackend: new InMemoryDurableBackend(),
				continuation: { source, resumeFromStageId: "implement" },
				sessionAdapter: OTHER,
				adapters,
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "run-cont-alt");
		assert.ok(snapshot);
		assert.deepEqual(snapshot.sessionAdapter, OTHER, "the explicit launch selector wins");
		assert.equal(creates.get("remote-pi-alt"), 1);
		assert.equal(creates.get("remote-pi"), undefined, "the inherited adapter is not used");
	});

	test("runs without a launch selector keep the local session runtime", async () => {
		const store = createStore();
		const { adapters, creates } = namedAdapters([REMOTE]);
		await run(
			definition,
			{},
			{
				runId: "run-local",
				store,
				durableBackend: new InMemoryDurableBackend(),
				adapters,
			},
		);
		const snapshot = store.runs().find((candidate) => candidate.id === "run-local");
		assert.ok(snapshot);
		assert.equal(snapshot.sessionAdapter, undefined);
		assert.equal(creates.size, 0, "no named adapter is created for a local run");
	});
});
