import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import {
	STAGE_ROUTING_CONCURRENCY,
	STAGE_ROUTING_DEADLINE_MS,
} from "../../packages/workflows/src/runs/foreground/stage-routing.js";
import {
	RoutingProvider,
	type RoutingProviderBehavior,
	recordSettlement,
	settleVirtually,
	useVirtualTime,
} from "../helpers/routing-provider.js";
import { decisionModel, registeredDecisionRuntime } from "../helpers/structured-output.js";
import { createStore, run, workflow } from "./executor-shared.js";
import { createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

const OTHER_MODEL = { ...decisionModel, id: "other", name: "Other" };
const CURRENT_MODEL_ID = "decision-test/chat";
const ROUTED_MODEL_ID = "decision-test/other";
/** Virtual time a bounded outcome may exceed its deadline by (timers armed around it). */
const DEADLINE_SLACK_MS = 5_000;
const CONCURRENT_WORKFLOWS = STAGE_ROUTING_CONCURRENCY * 6;
const PARALLEL_AUTO_STAGES = 5;

beforeEach(useVirtualTime);
afterEach(() => {
	vi.restoreAllMocks();
});

async function fixture(provider: RoutingProvider, withCurrentModel = true) {
	const { registry } = await registeredDecisionRuntime(provider.streamSimple);
	vi.spyOn(registry, "getAvailable").mockReturnValue([decisionModel, OTHER_MODEL]);
	const models = workflowModelCatalogFromContext({
		...(withCurrentModel ? { model: decisionModel } : {}),
		modelRegistry: registry,
		getRouterModel: () => CURRENT_MODEL_ID,
	});
	const admissions: string[] = [];
	const adapters = {
		agentSession: {
			async create(options: import("./stage-runner-helpers.js").StageSessionCreateOptions) {
				admissions.push(
					typeof options.model === "string" ? options.model : `${options.model?.provider}/${options.model?.id}`,
				);
				return makeMockSession({
					model: options.model,
					async prompt() {
						return "done";
					},
					getLastAssistantText: () => "done",
				}).session;
			},
		},
	};
	return { models, admissions, adapters, store: createStore() };
}

const explicitThenAuto = workflow({
	name: "explicit-then-auto",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("explicit", { model: CURRENT_MODEL_ID }).prompt("Do the explicit-model work");
		await ctx.stage("auto", { model: "auto" }).prompt("Solve the auto-routed task");
		return {};
	},
});

const parallelAuto = workflow({
	name: "parallel-auto",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await Promise.all(
			Array.from({ length: PARALLEL_AUTO_STAGES }, (_, index) =>
				ctx.stage(`auto-${index}`, { model: "auto" }).prompt(`Solve the auto-routed task ${index}`),
			),
		);
		return {};
	},
});

async function runConcurrently(f: Awaited<ReturnType<typeof fixture>>, count: number) {
	const started = Date.now();
	const settlements = Array.from({ length: count }, () =>
		recordSettlement(run(explicitThenAuto, {}, { models: f.models, adapters: f.adapters, store: f.store })),
	);
	await settleVirtually(Promise.all(settlements));
	return { settlements: await Promise.all(settlements), started };
}

const stalledBehaviors: ReadonlyArray<readonly [string, RoutingProviderBehavior]> = [
	["hangs", { kind: "hang", honorsAbort: true }],
	["hangs and ignores abort", { kind: "hang", honorsAbort: false }],
	["answers every call with a 429 and a long Retry-After", { kind: "rate-limit", retryAfterMs: 600_000 }],
];

for (const [name, behavior] of stalledBehaviors) {
	test(`every stage of many concurrent workflows starts within the routing deadline when the router ${name}`, async () => {
		const provider = new RoutingProvider(behavior);
		const f = await fixture(provider);
		const { settlements, started } = await runConcurrently(f, CONCURRENT_WORKFLOWS);
		for (const settlement of settlements) {
			assert.ok(settlement.ok, "a workflow run threw");
			assert.equal(settlement.value.status, "completed");
			assert.ok(
				settlement.at - started <= STAGE_ROUTING_DEADLINE_MS + DEADLINE_SLACK_MS,
				`a workflow needed ${settlement.at - started}ms of virtual time`,
			);
		}
		assert.deepEqual(f.admissions, Array(CONCURRENT_WORKFLOWS * 2).fill(CURRENT_MODEL_ID));
		for (const runSnapshot of f.store.runs())
			for (const stage of runSnapshot.stages)
				assert.notEqual(stage.startup?.phase, "model-resolution", `${stage.name} is stuck selecting its model`);
		assert.ok(provider.peakInflight <= STAGE_ROUTING_CONCURRENCY);
	});
}

test("a provider that answers 429 beyond its capacity never sees more routing calls than the stage limit, so every stage is routed", async () => {
	const provider = new RoutingProvider({ kind: "capacity", capacity: STAGE_ROUTING_CONCURRENCY, latencyMs: 300 });
	const f = await fixture(provider);
	const { settlements, started } = await runConcurrently(f, CONCURRENT_WORKFLOWS);
	for (const settlement of settlements) {
		assert.ok(settlement.ok, "a workflow run threw");
		assert.equal(settlement.value.status, "completed");
		assert.ok(settlement.at - started <= STAGE_ROUTING_DEADLINE_MS);
	}
	assert.equal(provider.rateLimited, 0, "routing calls overran the provider's capacity");
	assert.equal(f.admissions.filter((model) => model === ROUTED_MODEL_ID).length, CONCURRENT_WORKFLOWS);
});

test("many concurrent auto stages are routed and started against a healthy router without exceeding the concurrency limit", async () => {
	const provider = new RoutingProvider({ kind: "answer", latencyMs: 500 });
	const f = await fixture(provider);
	const { settlements, started } = await runConcurrently(f, CONCURRENT_WORKFLOWS);
	for (const settlement of settlements) {
		assert.ok(settlement.ok, "a workflow run threw");
		assert.equal(settlement.value.status, "completed");
		assert.ok(settlement.at - started <= STAGE_ROUTING_DEADLINE_MS);
	}
	assert.equal(f.admissions.filter((model) => model === ROUTED_MODEL_ID).length, CONCURRENT_WORKFLOWS);
	assert.ok(
		provider.peakInflight <= STAGE_ROUTING_CONCURRENCY,
		`${provider.peakInflight} routing calls were in flight at once`,
	);
});

test("a stage whose routing times out with no fallback fails naming its startup phase instead of staying in model resolution", async () => {
	const provider = new RoutingProvider({ kind: "hang", honorsAbort: true });
	const f = await fixture(provider, false);
	const settlement = recordSettlement(
		run(explicitThenAuto, {}, { models: f.models, adapters: f.adapters, store: f.store }),
	);
	await settleVirtually(settlement);
	const result = await settlement;
	assert.ok(result.ok, "the workflow run threw");
	const stage = result.value.stages.find((candidate) => candidate.name === "auto");
	assert.equal(stage?.status, "failed");
	assert.match(stage?.error ?? "", /stage "auto" failed during startup phase model-resolution/);
	assert.match(stage?.error ?? "", /timed out/);
	assert.deepEqual(
		{ phase: stage?.startup?.phase, state: stage?.startup?.state },
		{ phase: "model-resolution", state: "failed" },
	);
	assert.deepEqual(f.admissions, [CURRENT_MODEL_ID]);
});

test("a later prompt on the same stage routes again after a failed routing attempt", async () => {
	const provider = new RoutingProvider({ kind: "rate-limit" });
	const f = await fixture(provider, false);
	const ctx = createStageContext(
		makeOpts({ adapters: f.adapters, models: f.models, stageOptions: { model: "auto" } }),
	);
	const first = recordSettlement(ctx.prompt("Solve the task"));
	await settleVirtually(first);
	const failed = await first;
	assert.ok(!failed.ok, "routing against a rate-limited router unexpectedly succeeded");
	assert.match(failed.error.message, /failed during startup phase model-resolution/);
	assert.deepEqual(f.admissions, []);

	provider.behavior = { kind: "answer", latencyMs: 10 };
	const second = recordSettlement(ctx.prompt("Solve the task again"));
	await settleVirtually(second);
	assert.ok((await second).ok, "the retried prompt did not route");
	assert.deepEqual(f.admissions, [ROUTED_MODEL_ID]);
	await ctx.__dispose();
});

test("auto stages queued behind a stuck stage in the run's concurrency limit all start in bounded time", async () => {
	const provider = new RoutingProvider({ kind: "hang", honorsAbort: true });
	const f = await fixture(provider);
	const started = Date.now();
	const settlement = recordSettlement(
		run(parallelAuto, {}, { models: f.models, adapters: f.adapters, store: f.store }),
	);
	await settleVirtually(settlement);
	const result = await settlement;
	assert.ok(result.ok, "the workflow run threw");
	assert.equal(result.value.status, "completed");
	assert.deepEqual(f.admissions, Array(PARALLEL_AUTO_STAGES).fill(CURRENT_MODEL_ID));
	// Stages beyond the per-run limit begin routing only after a running stage ends.
	assert.ok(result.at - started <= 2 * STAGE_ROUTING_DEADLINE_MS + DEADLINE_SLACK_MS);
});
