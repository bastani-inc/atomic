import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ModelCatalogDiscoveryCoordinator } from "../../packages/coding-agent/src/core/extensions/model-catalog-discovery.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createCancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowDefinition, WorkflowModelCatalogPort } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";

function makeWorkflow(name: string): WorkflowDefinition {
	return workflow({ name, description: "", inputs: {}, outputs: {}, run: async () => ({}) }) as WorkflowDefinition;
}

function freshDeps() {
	return { store: createStore(), cancellation: createCancellationRegistry(), jobs: createJobTracker() };
}

function modelCatalog(options: {
	readonly models?: readonly { readonly provider: string; readonly id: string; readonly fullId: string }[];
	readonly discover?: () => Promise<void>;
} = {}): WorkflowModelCatalogPort {
	return {
		discoverModels: options.discover,
		listModels: async () => options.models ?? [],
		currentModel: "openai/default-model",
	};
}

describe("named Cursor workflow preflight", () => {
	test("strict failure creates no Run, job, or workflow body", async () => {
		const deps = freshDeps();
		let bodyCalls = 0;
		const definition = workflow({
			name: "cursor-preflight-failure", description: "", inputs: {}, outputs: {},
			run: async () => { bodyCalls += 1; return {}; },
		}) as WorkflowDefinition;
		const result = await dispatch(
			{ action: "run", workflow: definition.name, model: "cursor/missing-route", fallbackModels: ["openai/default-model"] },
			{ registry: createRegistry([definition]), ...deps, models: modelCatalog() },
		);
		assert.equal(result.action, "run");
		if (result.action === "run") {
			assert.equal(result.status, "failed");
			assert.equal(result.runId, "");
			assert.match(result.error ?? "", /cursor\/missing-route.*reselect/su);
		}
		assert.equal(bodyCalls, 0);
		assert.equal(deps.store.runs().length, 0);
		assert.equal(deps.jobs.runIds().length, 0);
	});

	test("concurrent runs await one discovery before creating Runs", async () => {
		const coordinator = new ModelCatalogDiscoveryCoordinator();
		const deps = freshDeps();
		let discoveryStarts = 0;
		let discovered = false;
		let releaseDiscovery: (() => void) | undefined;
		const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
		const catalog: WorkflowModelCatalogPort = {
			discoverModels: () => coordinator.discover(async () => {
				discoveryStarts += 1;
				await discoveryGate;
				discovered = true;
			}),
			listModels: async () => discovered ? [{ provider: "cursor", id: "live-route", fullId: "cursor/live-route" }] : [],
		};
		const definition = makeWorkflow("cursor-preflight-success");
		const options = { registry: createRegistry([definition]), ...deps, models: catalog };
		const first = dispatch({ action: "run", workflow: definition.name, model: "cursor/live-route" }, options);
		const second = dispatch({ action: "run", workflow: definition.name, model: "cursor/live-route" }, options);
		await Promise.resolve();
		assert.equal(discoveryStarts, 1);
		assert.equal(deps.store.runs().length, 0);
		releaseDiscovery?.();
		const results = await Promise.all([first, second]);
		assert.equal(results.every((result) => result.action === "run" && result.runId.length > 0), true);
		assert.equal(discoveryStarts, 1);
	});

	test("cancellation and bare tombstones fail before Run creation", async () => {
		let bodyCalls = 0;
		const definition = workflow({
			name: "cursor-preflight-cancel", description: "", inputs: {}, outputs: {},
			run: async () => { bodyCalls += 1; return {}; },
		}) as WorkflowDefinition;
		for (const [reference, discover] of [
			["cursor/live-route", async () => { throw new DOMException("cancelled", "AbortError"); }],
			["composer-2", async () => {}],
		] as const) {
			const deps = freshDeps();
			let promptCalls = 0;
			const result = await dispatch(
				{ action: "run", workflow: definition.name, model: reference },
				{
					registry: createRegistry([definition]), ...deps,
					adapters: { prompt: { async prompt() { promptCalls += 1; return "unexpected"; } } },
					models: modelCatalog({ discover }),
				},
			);
			assert.equal(result.action, "run");
			if (result.action === "run") assert.equal(result.runId, "");
			assert.equal(deps.store.runs().length, 0);
			assert.equal(deps.jobs.runIds().length, 0);
			assert.equal(promptCalls, 0);
		}
		assert.equal(bodyCalls, 0);
	});

	test("exact suffix routes and current bare tombstones start only their validated Runs", async () => {
		for (const scenario of [
			{ reference: "cursor/literal-route:high", models: [{ provider: "cursor", id: "literal-route:high", fullId: "cursor/literal-route:high" }] },
			{ reference: "composer-2", models: [
				{ provider: "cursor", id: "composer-2", fullId: "cursor/composer-2" },
				{ provider: "openai", id: "composer-2", fullId: "openai/composer-2" },
			] },
		] as const) {
			const deps = freshDeps();
			let discoveryCalls = 0;
			let promptCalls = 0;
			const definition = workflow({
				name: `exact-${scenario.reference.replaceAll("/", "-")}`, description: "", inputs: {}, outputs: {},
				run: async (ctx) => { await ctx.stage("exact").prompt("run exact"); return {}; },
			}) as WorkflowDefinition;
			const result = await dispatch(
				{ action: "run", workflow: definition.name, model: scenario.reference },
				{
					registry: createRegistry([definition]), ...deps,
					adapters: { prompt: { async prompt() { promptCalls += 1; return "ok"; } } },
					models: modelCatalog({ models: scenario.models, discover: async () => { discoveryCalls += 1; } }),
				},
			);
			assert.equal(result.action, "run");
			if (result.action !== "run") throw new Error("Expected named Cursor run");
			assert.notEqual(result.runId, "");
			await deps.jobs.get(result.runId)?.promise;
			assert.equal(discoveryCalls, 1);
			assert.equal(promptCalls, 1);
			assert.equal(deps.store.runs().length, 1);
		}
	});

	test("nonexact suffix rejects before Run while non-Cursor bypasses discovery", async () => {
		const failedDeps = freshDeps();
		let promptCalls = 0;
		const definition = makeWorkflow("nonexact-suffix");
		const failed = await dispatch(
			{ action: "run", workflow: definition.name, model: "cursor/literal-route:high" },
			{
				registry: createRegistry([definition]), ...failedDeps,
				adapters: { prompt: { async prompt() { promptCalls += 1; return "unexpected"; } } },
				models: modelCatalog({ models: [{ provider: "cursor", id: "literal-route", fullId: "cursor/literal-route" }], discover: async () => {} }),
			},
		);
		assert.equal(failed.action, "run");
		if (failed.action === "run") {
			assert.equal(failed.runId, "");
			assert.match(failed.error ?? "", /literal-route:high.*reselect/su);
		}
		assert.equal(promptCalls, 0);
		assert.equal(failedDeps.store.runs().length, 0);
		assert.equal(failedDeps.jobs.runIds().length, 0);

		const successDeps = freshDeps();
		let discoveryCalls = 0;
		const success = await dispatch(
			{ action: "run", workflow: "non-cursor-preflight", model: "openai/gpt-5-mini" },
			{
				registry: createRegistry([makeWorkflow("non-cursor-preflight")]), ...successDeps,
				models: modelCatalog({
					models: [{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" }],
					discover: () => { discoveryCalls += 1; return new Promise(() => {}); },
				}),
			},
		);
		assert.equal(success.action, "run");
		if (success.action === "run") assert.notEqual(success.runId, "");
		assert.equal(discoveryCalls, 0);
	});
});
