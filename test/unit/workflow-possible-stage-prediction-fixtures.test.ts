import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createWorkflowBoundaryHopsResolver } from "../../packages/workflows/src/shared/pending-stage-status.js";
import { stagePredictionStatus } from "../../packages/workflows/src/shared/possible-stage-prediction.js";
import type { StageDecisionPort } from "../../packages/workflows/src/shared/possible-stage-prediction-errors.js";
import { StagePredictor } from "../../packages/workflows/src/shared/possible-stage-predictor.js";
import { scanPossibleStagesFromSource } from "../../packages/workflows/src/shared/possible-stages.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { isTerminalRunStatus } from "../../packages/workflows/src/shared/store-internal.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { moduleDir, sleep } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const FIXTURES = join(moduleDir(import.meta.url), "..", "fixtures", "possible-stage-prediction");

/**
 * Classifier-shaped answers recorded per fixture: each call site's probabilities over the offered criteria, summing
 * to one, with the distractors (bare literals, the other child, single loop elements) the source also offers.
 */
const RECORDED: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	"helper-names": {
		"stage review-1": 0.94,
		"stage review": 0.04,
		"stage summary-2": 0.93,
		"stage summary": 0.05,
		"none of these candidates": 0.02,
	},
	"imported-factory": { "stage lint": 0.97, "stage typecheck": 0.96, "none of these candidates": 0.03 },
	"data-driven-loop": {
		"every one of api, ui, docs": 0.88,
		"stage api": 0.04,
		"stage ui": 0.04,
		"stage docs": 0.03,
		"none of these candidates": 0.01,
	},
	"dynamic-children": {
		"child workflow workflow:child-alpha with stages workflow:child-alpha/alpha-draft": 0.9,
		"child workflow workflow:child-beta with stages workflow:child-beta/beta-draft": 0.08,
		"none of these candidates": 0.02,
	},
};

function recordedPort(recorded: Readonly<Record<string, number>>): StageDecisionPort {
	return {
		async decide(request) {
			return {
				answers: Object.fromEntries(
					Object.entries(request.questions).map(([key, question]) => [
						key,
						question.type === "choice"
							? {
									type: "choice" as const,
									probabilities: Object.fromEntries(
										Object.entries(question.criteria).map(([option, text]) => [option, recorded[text] ?? 0]),
									),
								}
							: { type: "bool" as const, probability: 0.5 },
					]),
				),
			};
		},
	};
}

afterEach(() => setDurableBackend(undefined));

describe("predicted stage names match the stages custom workflows materialize (#4359)", () => {
	for (const [name, recorded] of Object.entries(RECORDED)) {
		test(name, async () => {
			const entry = join(FIXTURES, name, "workflow.mjs");
			const scan = scanPossibleStagesFromSource(entry);
			const known = scan.stages.filter((stage) => !stage.includes("*"));
			const module = (await import(entry)) as { default: (factory: typeof workflow) => WorkflowDefinition };
			const definition = module.default(workflow);
			setDurableBackend(await createMemoryTestBackend());
			const store = createStore();
			const predictor = new StagePredictor();
			const result = await dispatch(
				{ action: "run", workflow: definition.normalizedName },
				{
					registry: createRegistry([definition]),
					store,
					adapters: { prompt: { prompt: async () => "ok" } },
					resolvePossibleStageEntry: () => entry,
					decisions: recordedPort(recorded),
					stagePredictor: predictor,
				},
			);
			if (result.action !== "run") assert.fail("expected a run result");
			for (let attempt = 0; attempt < 400; attempt += 1) {
				const run = store.run(result.runId);
				if (run !== undefined && isTerminalRunStatus(run.status) && run.stagePredictions !== undefined) break;
				await sleep(5);
			}
			const root = store.run(result.runId);
			assert.equal(root?.status, "completed");
			const runs = store.runs();
			const hopsOf = createWorkflowBoundaryHopsResolver(runs);
			const materialized = runs.flatMap((run) =>
				run.stages.map((stage) => [...(hopsOf(run.id) ?? []).map((hop) => hop.name), stage.name].join("/")),
			);
			const predicted = (root?.stagePredictions?.entries ?? []).map((prediction) => prediction.path);

			assert.ok(predicted.length > 0, "the decision model accepted candidates");
			assert.deepEqual(
				predicted.filter((path) => !materialized.includes(path)),
				[],
				"precision: every accepted prediction materialized",
			);
			assert.deepEqual(
				materialized.filter((path) => !known.includes(path) && !predicted.includes(path)),
				[],
				"recall: every materialized stage is known or predicted",
			);
			assert.deepEqual(
				stagePredictionStatus(root!, runs)?.entries.map((prediction) => prediction.outcome),
				predicted.map(() => "confirmed"),
			);
		});
	}
});
