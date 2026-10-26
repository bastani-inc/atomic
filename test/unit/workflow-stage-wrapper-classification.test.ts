import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import {
	RoutingProvider,
	type RoutingProviderBehavior,
	recordSettlement,
	settleVirtually,
	useVirtualTime,
} from "../helpers/routing-provider.js";
import { decisionModel, registeredDecisionRuntime } from "../helpers/structured-output.js";
import { createStore, run, workflow } from "./executor-shared.js";
import { makeMockSession, type StageSessionCreateOptions } from "./stage-runner-helpers.js";

const ROUTER_MODEL = { ...decisionModel, provider: "router-test" };

beforeEach(useVirtualTime);
afterEach(() => vi.restoreAllMocks());

/** Runs one auto-routed stage named `stageName` whose routing fails as the router `behavior` makes it fail. */
async function routedStageFailure(stageName: string, behavior: RoutingProviderBehavior) {
	const provider = new RoutingProvider(behavior);
	const { runtime, registry } = await registeredDecisionRuntime(provider.streamSimple);
	runtime.registerProvider(ROUTER_MODEL.provider, {
		api: ROUTER_MODEL.api,
		baseUrl: ROUTER_MODEL.baseUrl,
		apiKey: "mock-router-secret",
		models: [ROUTER_MODEL],
		streamSimple: provider.streamSimple,
	});
	vi.spyOn(registry, "getAvailable").mockReturnValue([decisionModel, ROUTER_MODEL]);
	const models = workflowModelCatalogFromContext({
		modelRegistry: registry,
		getRouterModel: () => "router-test/chat",
	});
	const adapters = {
		agentSession: {
			async create(options: StageSessionCreateOptions) {
				return makeMockSession({
					model: options.model,
					prompt: async () => "done",
					getLastAssistantText: () => "done",
				}).session;
			},
		},
	};
	const definition = workflow({
		name: "routed",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage(stageName, { model: "auto" }).prompt("Solve the auto-routed task");
			return {};
		},
	});
	const store = createStore();
	const settlement = recordSettlement(run(definition, {}, { models, adapters, store, runId: `routed-${stageName}` }));
	await settleVirtually(settlement);
	const result = await settlement;
	assert.ok(result.ok, "the workflow run threw");
	const stage = result.value.stages.find((candidate) => candidate.name === stageName);
	assert.match(stage?.error ?? "", new RegExp(`stage "${stageName}" failed during startup phase model-resolution`));
	return { status: result.value.status, failureKind: stage?.failureKind, disposition: stage?.failureDisposition };
}

test("a stage named like a rate limit whose routing times out fails like any other stage (#4031)", async () => {
	const named = await routedStageFailure("rate-limit-overloaded", { kind: "hang", honorsAbort: true });
	const plain = await routedStageFailure("plain", { kind: "hang", honorsAbort: true });
	assert.deepEqual(named, plain);
	assert.notEqual(named.failureKind, "rate_limit");
});

test("a stage whose router answers 429 stays resumable whatever the stage is named (#4031)", async () => {
	const plain = await routedStageFailure("plain", { kind: "rate-limit" });
	// The router reports the 429 as a failed provider request, which blocks the run for resume.
	assert.equal(plain.disposition, "active_blocked");
	assert.equal(plain.status, "running");
	assert.deepEqual(await routedStageFailure("rate-limit-overloaded", { kind: "rate-limit" }), plain);
});
