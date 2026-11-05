import assert from "node:assert/strict";
import { test } from "vitest";
import { isWorkflowSendPredictionFields } from "../../packages/intercom/workflow-prediction-fields.js";
import type { StageDecisionPort } from "../../packages/workflows/src/shared/possible-stage-prediction-errors.js";
import { StagePredictor } from "../../packages/workflows/src/shared/possible-stage-predictor.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function launch(knownPaths: readonly string[], probabilities: Readonly<Record<string, number>>) {
	const store = createStore();
	store.recordRunStart({
		id: "root",
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
	} as RunSnapshot);
	const requests: string[] = [];
	const decisions: StageDecisionPort = {
		async decide(request) {
			const path = String(request.state.target);
			requests.push(path);
			return { answers: { target: { type: "bool", probability: probabilities[path] ?? 0.1 } } };
		},
	};
	const predictor = new StagePredictor();
	predictor.launch({
		store,
		runId: "root",
		workflowName: "flow",
		maxDepth: undefined,
		inputs: {},
		decisions,
		admitted: Promise.resolve(true),
		scan: {
			stages: knownPaths,
			hasTrackedNodes: true,
			warnings: [],
			uncertainties: [],
			wildcardsWithoutUncertainty: [],
			sources: [],
		},
	});
	const classify = (path: string) => predictor.classifySend(store.run("root")!, path.split("/"));
	const settle = async (path: string) => {
		classify(path);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(store.run("root")?.stagePredictions?.targets[path], probabilities[path] ?? 0.1);
		return classify(path);
	};
	return { store, requests, classify, settle };
}

for (const pattern of ["release-*", "**/release", "workflow:*/release"]) {
	test(`a positive ${pattern} send judgment does not predict every matching literal (#4359)`, async () => {
		const typo = pattern.replace("*", "typo").replace("*", "child");
		const { settle, classify, store, requests } = launch([], { [pattern]: 0.95 });
		assert.deepEqual(await settle(pattern), { prediction: "predicted" });
		assert.deepEqual(classify(typo), { prediction: "unknown" });
		assert.deepEqual(await settle(typo), { prediction: "unknown", unexpected: true });
		assert.deepEqual(classify(pattern), { prediction: "predicted" });
		assert.deepEqual(classify(typo), { prediction: "unknown", unexpected: true });
		assert.deepEqual(requests, [pattern, typo]);
		assert.deepEqual(store.run("root")?.stagePredictions?.entries, []);
	});
}

test("a broad send cannot hide an exact negative judgment cached earlier (#4359)", async () => {
	const { settle, classify } = launch(["release-good"], { "release-*": 0.9 });
	const rejected = await settle("release-goof");
	assert.deepEqual(rejected, { prediction: "unknown", unexpected: true, suggestion: "release-good" });
	assert.deepEqual(await settle("release-*"), { prediction: "predicted" });
	assert.deepEqual(classify("release-goof"), rejected);
});

for (const length of [512, 513]) {
	test(`a ${length}-character closest stage produces a valid send acknowledgment (#4359)`, async () => {
		const name = "a".repeat(length);
		const typo = `${name.slice(0, -1)}b`;
		const { settle } = launch([name], {});
		const result = await settle(typo);
		assert.deepEqual(result, {
			prediction: "unknown",
			unexpected: true,
			...(length === 512 ? { suggestion: name } : {}),
		});
		assert.equal(isWorkflowSendPredictionFields(result), true);
	});
}
