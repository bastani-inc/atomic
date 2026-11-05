import assert from "node:assert/strict";
import { join } from "node:path";
import {
	DecisionModelUnavailableError,
	DecisionOutputError,
	type DecisionQuestions,
	type DecisionResult,
	DecisionTimeoutError,
} from "@bastani/atomic";
import { afterEach, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { renderWorkflowToolContent } from "../../packages/workflows/src/extension/workflow-tool-content.js";
import * as sdk from "../../packages/workflows/src/sdk-surface.js";
import type { WorkflowDecisionRequest } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createWorkflowBoundaryHopsResolver } from "../../packages/workflows/src/shared/pending-stage-status.js";
import {
	closestStagePath,
	decodeScanAnswers,
	decodeTargetAnswer,
	formatStagePredictionStatus,
	inputsShape,
	knownScanEntries,
	scanDecisionState,
	scanQuestionPlan,
	stagePredictionDefinitionHash,
	stagePredictionOutcome,
	stagePredictionStatus,
	targetQuestion,
} from "../../packages/workflows/src/shared/possible-stage-prediction.js";
import {
	findPossibleStagePredictionError,
	isPossibleStagePredictionError,
	isStageDecisionAnswerError,
	isStageDecisionFailedError,
	isStageDecisionTimeoutError,
	isStageDecisionUnavailableError,
	POSSIBLE_STAGE_PREDICTION_THRESHOLDS,
	PossibleStagePredictionError,
	StageDecisionAnswerError,
	StageDecisionFailedError,
	type StageDecisionPort,
	type StageDecisionRequest,
	type StageDecisionResult,
	StageDecisionTimeoutError,
	StageDecisionUnavailableError,
} from "../../packages/workflows/src/shared/possible-stage-prediction-errors.js";
import {
	StagePredictor,
	stageDecisionPortFromModels,
} from "../../packages/workflows/src/shared/possible-stage-predictor.js";
import {
	PossibleStageRowsIndex,
	WorkflowTopologyIndex,
} from "../../packages/workflows/src/shared/possible-stage-rows.js";
import {
	type PossibleStagesScanResult,
	type PossibleStageUncertainty,
	scanPossibleStagesFromSource,
} from "../../packages/workflows/src/shared/possible-stages.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowDefinition, WorkflowModelCatalogPort } from "../../packages/workflows/src/shared/types.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { moduleDir, sleep } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const ROOT = "4ac72924-c452-4e5f-9e63-2435722109f7";
const FIXTURES = join(moduleDir(import.meta.url), "..", "fixtures", "possible-stage-prediction");
const fixtureEntry = (name: string): string => join(FIXTURES, name, "workflow.mjs");

async function fixtureDefinition(name: string): Promise<WorkflowDefinition> {
	const module = (await import(fixtureEntry(name))) as { default: (factory: typeof workflow) => WorkflowDefinition };
	return module.default(workflow);
}

function uncertainty(candidates: readonly (readonly string[])[], overrides: Partial<PossibleStageUncertainty> = {}) {
	return {
		code: "unresolved-name",
		file: "workflow.mjs",
		line: 3,
		excerpt: "await ctx.task(name(1))",
		boundary: "",
		candidates: candidates.map((stages) => ({ stages, source: "literal" as const })),
		...overrides,
	} satisfies PossibleStageUncertainty;
}

function scanOf(uncertainties: readonly PossibleStageUncertainty[], stages: readonly string[] = ["*"]) {
	return {
		stages,
		hasTrackedNodes: true,
		warnings: [],
		uncertainties,
		sources: [{ file: "workflow.mjs", sha256: "a".repeat(64) }],
	} satisfies PossibleStagesScanResult;
}

/** A recorded, classifier-shaped port: probabilities keyed by each option's criterion text. */
function recordedPort(
	recorded: Readonly<Record<string, number>>,
	target: (state: StageDecisionRequest["state"]) => number = () => 0.5,
) {
	const requests: StageDecisionRequest[] = [];
	const port: StageDecisionPort = {
		async decide(request) {
			requests.push(request);
			const answers: Record<string, StageDecisionResult["answers"][string]> = {};
			for (const [key, question] of Object.entries(request.questions)) {
				if (question.type === "bool") {
					answers[key] = { type: "bool", probability: target(request.state) };
					continue;
				}
				answers[key] = {
					type: "choice",
					probabilities: Object.fromEntries(
						Object.entries(question.criteria).map(([option, text]) => [option, recorded[text] ?? 0]),
					),
				};
			}
			return { answers };
		},
	};
	return { port, requests };
}

/** A port whose answers never arrive, counting how many decisions started and settled. */
function stalledPort() {
	const counts = { started: 0, settled: 0 };
	const port: StageDecisionPort = {
		decide() {
			counts.started += 1;
			return new Promise<StageDecisionResult>(() => {}).finally(() => {
				counts.settled += 1;
			});
		},
	};
	return { port, counts };
}

function rootRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "root",
		name: "flow",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [],
		startedAt: 1,
		...overrides,
	} as RunSnapshot;
}

function stage(name: string, overrides: Partial<StageSnapshot> = {}): StageSnapshot {
	return { id: `${name}-id`, name, status: "running", startedAt: 1, ...overrides } as StageSnapshot;
}

async function until(condition: () => boolean, attempts = 200): Promise<void> {
	for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) await sleep(5);
	assert.ok(condition(), "condition did not hold in time");
}

afterEach(() => setDurableBackend(undefined));

describe("prediction policy (#4359)", () => {
	test("one exported, frozen threshold constant holds the policy", () => {
		assert.deepEqual(POSSIBLE_STAGE_PREDICTION_THRESHOLDS, { predicted: 0.8, known: 0.8, unlikely: 0.2 });
		assert.ok(Object.isFrozen(POSSIBLE_STAGE_PREDICTION_THRESHOLDS));
		assert.equal(sdk.POSSIBLE_STAGE_PREDICTION_THRESHOLDS, POSSIBLE_STAGE_PREDICTION_THRESHOLDS);
		assert.equal(sdk.PossibleStagePredictionError, PossibleStagePredictionError);
		assert.equal(sdk.findPossibleStagePredictionError, findPossibleStagePredictionError);
	});

	test("choice questions offer only source candidates under opaque keys, plus none", () => {
		const plan = scanQuestionPlan([
			uncertainty([["review-1"], ["api", "ui"]]),
			uncertainty([]),
			uncertainty([["workflow:child-a", "workflow:child-a/draft"]], {
				code: "unresolved-child",
				line: 9,
				candidates: [{ stages: ["workflow:child-a", "workflow:child-a/draft"], source: "child-definition" }],
			}),
		]);
		assert.deepEqual(Object.keys(plan.questions), ["site0", "site1"]);
		const first = plan.questions.site0!;
		assert.equal(first.type, "choice");
		assert.deepEqual(first.criteria, {
			c0: "stage review-1",
			c1: "every one of api, ui",
			none: "none of these candidates",
		});
		assert.match(first.instructions, /site0 \(workflow\.mjs:3\)/);
		assert.match(first.instructions, /Choose only from the listed candidates/);
		assert.deepEqual(plan.questions.site1?.criteria, {
			c0: "child workflow workflow:child-a with stages workflow:child-a/draft",
			none: "none of these candidates",
		});
		assert.deepEqual([...plan.options.get("site1")!.keys()], ["c0"]);
	});

	test("at most twelve call sites are asked about", () => {
		const plan = scanQuestionPlan(Array.from({ length: 14 }, (_, index) => uncertainty([[`stage-${index}`]])));
		assert.equal(Object.keys(plan.questions).length, 12);
		assert.equal(plan.options.size, 12);
	});

	test("the scan state carries redacted call-site source and the partial scan, never input values", () => {
		const state = scanDecisionState(
			"flow",
			scanOf(
				[uncertainty([["a"]], { excerpt: "const key = 'token: sk-abcdefghijklmnop'" }), uncertainty([])],
				["known", "*"],
			),
			{ areas: ["api"], secret: "hunter2", count: 2, flag: null },
		);
		assert.deepEqual(state.knownStages, ["known", "*"]);
		assert.deepEqual(state.inputsShape, { areas: "array", count: "number", flag: "null", secret: "string" });
		assert.doesNotMatch(JSON.stringify(state), /hunter2|sk-abcdefghijklmnop/);
		const sites = state.uncertainCallSites as readonly { readonly site: string; readonly source: string }[];
		assert.equal(sites.length, 1);
		assert.equal(sites[0]?.site, "site0");
		assert.match(sites[0]?.source ?? "", /\[redacted\]/);
	});

	test("accepts a candidate at the predicted threshold, rejects one just below, and expands groups", () => {
		const plan = scanQuestionPlan([uncertainty([["review-1"], ["review"], ["api", "ui"]])]);
		const decoded = decodeScanAnswers(plan, {
			answers: { site0: { type: "choice", probabilities: { c0: 0.8, c1: 0.79, c2: 0.9, none: 0 } } },
		});
		assert.deepEqual(decoded, [
			{ path: "review-1", probability: 0.8, source: "scan" },
			{ path: "api", probability: 0.9, source: "scan" },
			{ path: "ui", probability: 0.9, source: "scan" },
		]);
	});

	test("a path two call sites accept keeps its highest probability", () => {
		const plan = scanQuestionPlan([uncertainty([["review"]]), uncertainty([["review"], ["other"]])]);
		const decoded = decodeScanAnswers(plan, {
			answers: {
				site0: { type: "choice", probabilities: { c0: 0.85 } },
				site1: { type: "choice", probabilities: { c0: 0.95, c1: 0.1 } },
			},
		});
		assert.deepEqual(decoded, [{ path: "review", probability: 0.95, source: "scan" }]);
	});

	test("every malformed scan answer is refused with a typed reason", () => {
		const plan = scanQuestionPlan([uncertainty([["review"]])]);
		const cases: readonly [StageDecisionResult, string][] = [
			[{ answers: {} }, "missing"],
			[{ answers: { site0: { type: "bool", probability: 1 } } }, "wrong-type"],
			[{ answers: { site0: { type: "choice", probabilities: { c7: 0.9 } } } }, "unknown-option"],
			[{ answers: { site0: { type: "choice", probabilities: { "review-1": 0.9 } } } }, "unknown-option"],
			[{ answers: { site0: { type: "choice", probabilities: { c0: 1.2 } } } }, "not-a-probability"],
			[{ answers: { site0: { type: "choice", probabilities: { c0: -0.1 } } } }, "not-a-probability"],
			[{ answers: { site0: { type: "choice", probabilities: { none: Number.NaN } } } }, "not-a-probability"],
		];
		for (const [result, reason] of cases) {
			assert.throws(
				() => decodeScanAnswers(plan, result),
				(error: unknown) =>
					isStageDecisionAnswerError(error) &&
					error.code === "invalid-answer" &&
					error.reason === reason &&
					error.question === "site0" &&
					error.phase === "scan",
				reason,
			);
		}
	});

	test("the target question is a yes/no question naming the path", () => {
		const question = targetQuestion("review-*");
		assert.equal(question.type, "bool");
		assert.match(question.instructions, /matches review-\*/);
		assert.equal(decodeTargetAnswer({ answers: { target: { type: "bool", probability: 0.2 } } }), 0.2);
		for (const [result, reason] of [
			[{ answers: {} }, "missing"],
			[{ answers: { target: { type: "choice", probabilities: {} } } }, "wrong-type"],
			[{ answers: { target: { type: "bool", probability: 2 } } }, "not-a-probability"],
		] as const) {
			assert.throws(
				() => decodeTargetAnswer(result),
				(error: unknown) =>
					isStageDecisionAnswerError(error) && error.reason === reason && error.phase === "target",
			);
		}
	});

	test("the closest name is the single nearest literal within two fifths of the length", () => {
		assert.equal(closestStagePath("reviwe-1", ["review-1", "summary-2"]), "review-1");
		assert.equal(closestStagePath("reveiw-api", ["review-api", "review-*"]), "review-api");
		assert.equal(closestStagePath("lnt", ["lint", "lent"]), undefined, "a tie suggests nothing");
		assert.equal(closestStagePath("lnt", ["lint", "list"]), "lint");
		assert.equal(closestStagePath("deploy", ["review-1"]), undefined);
		assert.equal(closestStagePath("review-1", ["review-1"]), undefined);
		assert.equal(closestStagePath("abcde", ["abcxy"]), "abcxy");
		assert.equal(closestStagePath("abcde", ["axyze"]), undefined);
	});

	test("wildcard-only scan entries count as known until the model accepted scan candidates", () => {
		const scanned = { possibleStages: ["*", "workflow:*", "workflow:*/*", "review-*", "lint"] };
		assert.deepEqual(knownScanEntries(scanned), scanned.possibleStages);
		assert.deepEqual(knownScanEntries({}), []);
		const sendOnly = {
			status: "ready" as const,
			targets: {},
			entries: [{ path: "x", probability: 0.9, source: "send" as const }],
		};
		assert.deepEqual(knownScanEntries({ ...scanned, stagePredictions: sendOnly }), scanned.possibleStages);
		const predicted = { ...sendOnly, entries: [{ path: "review-1", probability: 0.9, source: "scan" as const }] };
		assert.deepEqual(knownScanEntries({ ...scanned, stagePredictions: predicted }), ["review-*", "lint"]);
	});

	test("the definition hash follows sources, depth and inputs shape, not input values", () => {
		const scan = scanOf([]);
		const base = stagePredictionDefinitionHash(scan, 3, { kind: "alpha" });
		assert.equal(stagePredictionDefinitionHash(scan, 3, { kind: "beta" }), base);
		assert.notEqual(stagePredictionDefinitionHash(scan, 2, { kind: "alpha" }), base);
		assert.notEqual(stagePredictionDefinitionHash(scan, 3, { kind: 1 }), base);
		assert.notEqual(stagePredictionDefinitionHash(scan, undefined, { kind: "alpha" }), base);
		assert.notEqual(
			stagePredictionDefinitionHash({ sources: [{ file: "workflow.mjs", sha256: "b".repeat(64) }] }, 3, {
				kind: "alpha",
			}),
			base,
		);
		assert.deepEqual(inputsShape({ b: true, a: { x: 1 } }), { a: "object", b: "boolean" });
	});
});

describe("prediction errors (#4359)", () => {
	test("each class carries its code, phase, hint and retry semantics", () => {
		const unavailable = new StageDecisionUnavailableError("scan");
		assert.equal(unavailable.name, "StageDecisionUnavailableError");
		assert.equal(unavailable.code, "decision-unavailable");
		assert.equal(unavailable.retryable, false);
		assert.equal(unavailable.phase, "scan");
		assert.match(unavailable.hint, /decisionModel/);
		assert.equal(
			unavailable.message,
			"Stage-name prediction is unavailable: no decision model answered (decision-unavailable). Set decisionModel to a classifier model to predict dynamic stage names; the static scan still applies.",
		);

		const cause = Object.assign(new Error("rate limited"), { retryable: true });
		const failed = new StageDecisionFailedError("target", cause);
		assert.equal(failed.code, "decision-failed");
		assert.equal(failed.cause, cause);
		assert.equal(failed.retryable, true);
		assert.equal(new StageDecisionFailedError("target", new Error("down")).retryable, false);
		assert.doesNotMatch(failed.message, /rate limited/);

		const timeout = new StageDecisionTimeoutError("scan", 100, 105);
		assert.equal(timeout.code, "decision-timeout");
		assert.equal(timeout.retryable, true);
		assert.equal(timeout.timeoutMs, 100);
		assert.equal(timeout.elapsedMs, 105);

		const answer = new StageDecisionAnswerError("scan", "site0", "unknown-option");
		assert.equal(answer.code, "invalid-answer");
		assert.equal(answer.retryable, false);

		for (const error of [unavailable, failed, timeout, answer]) {
			assert.ok(error instanceof PossibleStagePredictionError);
			assert.ok(isPossibleStagePredictionError(error));
		}
	});

	test("guards match across realms by name and code, and the finder walks causes at most eight deep", () => {
		const foreign = { name: "StageDecisionTimeoutError", code: "decision-timeout", message: "x" };
		assert.ok(isStageDecisionTimeoutError(foreign));
		assert.ok(isPossibleStagePredictionError(foreign));
		assert.equal(isStageDecisionFailedError(foreign), false);
		assert.equal(isStageDecisionUnavailableError({ name: "StageDecisionUnavailableError" }), false);
		assert.equal(isPossibleStagePredictionError({ name: "OtherError", code: "decision-timeout" }), false);
		assert.equal(isPossibleStagePredictionError(null), false);
		assert.equal(isPossibleStagePredictionError("StageDecisionTimeoutError"), false);
		assert.ok(isStageDecisionUnavailableError(new StageDecisionUnavailableError("target")));
		assert.ok(isStageDecisionFailedError(new StageDecisionFailedError("scan", undefined)));

		const inner = new StageDecisionUnavailableError("scan");
		let chain: Error = inner;
		for (let depth = 0; depth < 7; depth += 1) chain = new Error(`wrap ${depth}`, { cause: chain });
		assert.equal(findPossibleStagePredictionError(chain), inner);
		assert.equal(findPossibleStagePredictionError(new Error("too deep", { cause: chain })), undefined);
		assert.equal(findPossibleStagePredictionError("text"), undefined);
	});
});

describe("prediction outcomes (#4359)", () => {
	const child = (overrides: Partial<RunSnapshot> = {}): RunSnapshot =>
		rootRun({
			id: "child",
			parentRunId: "root",
			parentStageId: "workflow:child-a-id",
			rootRunId: "root",
			...overrides,
		});

	function outcome(path: string, runs: readonly RunSnapshot[]): string {
		return stagePredictionOutcome(path, runs[0]!, runs, createWorkflowBoundaryHopsResolver(runs));
	}

	test("a prediction is confirmed by a started stage of any status, at any depth, by name or id", () => {
		assert.equal(
			outcome("review-1", [rootRun({ stages: [stage("review-1", { status: "completed" })] })]),
			"confirmed",
		);
		assert.equal(outcome("review-1-id", [rootRun({ stages: [stage("review-1")] })]), "confirmed");
		const runs = [
			rootRun({ stages: [stage("workflow:child-a", { status: "completed" })] }),
			child({ stages: [stage("draft", { status: "failed" })] }),
		];
		assert.equal(outcome("workflow:child-a/draft", runs), "confirmed");
		assert.equal(outcome("workflow:child-a", runs), "confirmed");
	});

	test("a prediction is unused once the root ended or every boundary it nests under ended", () => {
		assert.equal(outcome("review-1", [rootRun({ status: "completed" })]), "unused");
		assert.equal(outcome("review-1", [rootRun()]), "predicted");
		const ended = [
			rootRun({ stages: [stage("workflow:child-a", { status: "completed" })] }),
			child({ stages: [stage("draft", { status: "completed" })] }),
		];
		assert.equal(outcome("workflow:child-a/extra", ended), "unused");
		const open = [
			rootRun({ stages: [stage("workflow:child-a", { status: "running" })] }),
			child({ stages: [stage("draft")] }),
		];
		assert.equal(outcome("workflow:child-a/extra", open), "predicted");
		assert.equal(outcome("workflow:child-b/extra", ended), "predicted");
		const skipped = [rootRun({ stages: [stage("workflow:child-a", { status: "skipped" })] })];
		assert.equal(outcome("workflow:child-a/extra", skipped), "unused");
		const failed = [rootRun({ stages: [stage("workflow:child-a", { status: "failed" })] })];
		assert.equal(outcome("workflow:child-a/extra", failed), "unused");
	});

	test("status lists predictions with outcomes and the fallback reason", () => {
		const run = rootRun({
			stages: [stage("review-1")],
			stagePredictions: {
				status: "fallback",
				entries: [
					{ path: "review-1", probability: 0.95, source: "scan" },
					{ path: "summary-2", probability: 0.912, source: "send" },
				],
				targets: {},
				fallback: {
					name: "StageDecisionTimeoutError",
					code: "decision-timeout",
					hint: "Later runs ask again.",
					phase: "scan",
					retryable: true,
				},
			},
		});
		const status = stagePredictionStatus(run, [run]);
		assert.deepEqual(
			status?.entries.map((entry) => entry.outcome),
			["confirmed", "predicted"],
		);
		assert.deepEqual(formatStagePredictionStatus(status!), [
			"stage predictions: review-1 confirmed 0.95, summary-2 predicted 0.91",
			"stage predictions unavailable (decision-timeout): Later runs ask again.",
		]);
		assert.equal(stagePredictionStatus(rootRun(), [rootRun()]), undefined);
		assert.equal(
			stagePredictionStatus(rootRun({ stagePredictions: { status: "ready", entries: [], targets: {} } }), []),
			undefined,
		);
		const many = rootRun({
			stagePredictions: {
				status: "ready",
				targets: {},
				entries: Array.from({ length: 7 }, (_, index) => ({
					path: `s${index}`,
					probability: 0.9,
					source: "scan" as const,
				})),
			},
		});
		assert.deepEqual(formatStagePredictionStatus(stagePredictionStatus(many, [many])!), [
			"stage predictions: s0 predicted 0.90, s1 predicted 0.90, s2 predicted 0.90, s3 predicted 0.90, s4 predicted 0.90, +2 more",
		]);
		const summary = summarizeRunSnapshot(run, 2, { allRuns: [run] });
		assert.deepEqual(summary.stagePredictions, status);
		assert.equal(summarizeRunSnapshot(rootRun(), 2).stagePredictions, undefined);
		const content = renderWorkflowToolContent(
			{ action: "status", filter: "all", runs: [summary], snapshots: [run] } as never,
			{ action: "status" },
		);
		assert.match(content, /\n {4}stage predictions: review-1 confirmed 0\.95, summary-2 predicted 0\.91\n/);
		assert.match(content, /\n {4}stage predictions unavailable \(decision-timeout\): Later runs ask again\.\n/);
		const card = renderStatusList([run], { width: 160 });
		assert.match(card, /stage predictions: review-1 confirmed 0\.95, summary-2 predicted 0\.91/);
		assert.match(card, /stage predictions unavailable \(decision-timeout\): Later runs ask again\./);
		assert.doesNotMatch(renderStatusList([rootRun()], { width: 160 }), /stage predictions/);
	});

	test("intercom rows list predictions the scan does not, with probability and outcome", () => {
		const topology = new WorkflowTopologyIndex();
		const run = rootRun({
			possibleStages: ["review-1"],
			stages: [stage("lint", { status: "completed" })],
			stagePredictions: {
				status: "ready",
				targets: {},
				entries: [
					{ path: "review-1", probability: 0.9, source: "scan" },
					{ path: "summary-2", probability: 0.85, source: "scan" },
					{ path: "lint", probability: 0.99, source: "send" },
				],
			},
		});
		topology.refresh([run]);
		const rows = new PossibleStageRowsIndex("root", topology).rows([run], run, undefined);
		assert.deepEqual(rows, [
			{ target: "workflow:root/review-1", queuedCount: 0 },
			{ target: "workflow:root/summary-2", queuedCount: 0, prediction: "predicted", probability: 0.85 },
			{ target: "workflow:root/lint", queuedCount: 0, prediction: "confirmed", probability: 0.99 },
			{ target: "workflow:root/**", queuedCount: 0 },
		]);
	});
});

describe("stage predictor (#4359)", () => {
	function storeWithRoot(run: RunSnapshot = rootRun()) {
		const store = createStore();
		store.recordRunStart(run);
		return store;
	}

	test("a certain scan asks nothing", async () => {
		const { port, requests } = recordedPort({});
		new StagePredictor().launch({
			store: storeWithRoot(),
			runId: "root",
			workflowName: "flow",
			scan: scanOf([], ["review"]),
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await sleep(10);
		assert.equal(requests.length, 0);
	});

	test("an uncertain scan records accepted candidates once admitted, and caches them per definition", async () => {
		const { port, requests } = recordedPort({ "stage review-1": 0.93, "stage review": 0.04 });
		const predictor = new StagePredictor();
		const scan = scanOf([uncertainty([["review"], ["review-1"]])]);
		const first = storeWithRoot();
		predictor.launch({
			store: first,
			runId: "root",
			workflowName: "flow",
			scan,
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await until(() => first.run("root")?.stagePredictions !== undefined);
		assert.deepEqual(first.run("root")?.stagePredictions, {
			status: "ready",
			entries: [{ path: "review-1", probability: 0.93, source: "scan" }],
			targets: {},
		});
		assert.equal(requests.length, 1);
		assert.deepEqual(Object.keys(requests[0]!.questions), ["site0"]);

		const second = storeWithRoot();
		predictor.launch({
			store: second,
			runId: "root",
			workflowName: "flow",
			scan,
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await until(() => second.run("root")?.stagePredictions !== undefined);
		assert.equal(requests.length, 1, "the same definition hash reuses the answer");

		const third = storeWithRoot();
		predictor.launch({
			store: third,
			runId: "root",
			workflowName: "flow",
			scan,
			maxDepth: 3,
			inputs: { kind: "x" },
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await until(() => third.run("root")?.stagePredictions !== undefined);
		assert.equal(requests.length, 2, "another inputs shape is another definition hash");
	});

	test("concurrent launches of one definition share the open decision", async () => {
		const { port, counts } = stalledPort();
		const predictor = new StagePredictor();
		const scan = scanOf([uncertainty([["review"]])]);
		for (let index = 0; index < 3; index += 1) {
			predictor.launch({
				store: storeWithRoot(),
				runId: "root",
				workflowName: "flow",
				scan,
				maxDepth: 3,
				inputs: {},
				decisions: port,
				admitted: Promise.resolve(true),
			});
		}
		assert.deepEqual(counts, { started: 1, settled: 0 });
		predictor.dispose();
	});

	test("an unadmitted run records nothing", async () => {
		const { port, requests } = recordedPort({ "stage review": 0.9 });
		const store = storeWithRoot();
		new StagePredictor().launch({
			store,
			runId: "root",
			workflowName: "flow",
			scan: scanOf([uncertainty([["review"]])]),
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(false),
		});
		await until(() => requests.length === 1);
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);
	});

	async function fallbackFor(port: StageDecisionPort, deadlineMs?: number) {
		const store = storeWithRoot();
		new StagePredictor(deadlineMs === undefined ? {} : { deadlineMs }).launch({
			store,
			runId: "root",
			workflowName: "flow",
			scan: scanOf([uncertainty([["review"]])]),
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await until(() => store.run("root")?.stagePredictions !== undefined);
		return store.run("root")!.stagePredictions!;
	}

	test("each failure falls back once with its typed reason", async () => {
		const unavailable = await fallbackFor({
			decide: async () => {
				throw new StageDecisionUnavailableError("scan");
			},
		});
		assert.deepEqual(unavailable, {
			status: "fallback",
			entries: [],
			targets: {},
			fallback: {
				name: "StageDecisionUnavailableError",
				code: "decision-unavailable",
				hint: "Set decisionModel to a classifier model to predict dynamic stage names; the static scan still applies.",
				phase: "scan",
				retryable: false,
			},
		});
		const failed = await fallbackFor({
			decide: () => {
				throw Object.assign(new Error("provider down"), { code: "rate_limit", retryable: true });
			},
		});
		assert.deepEqual(failed.fallback, {
			name: "StageDecisionFailedError",
			code: "decision-failed",
			hint: "Check the decision model's provider status; the static scan still applies.",
			phase: "scan",
			retryable: true,
			cause: { name: "Error", code: "rate_limit" },
		});
		const timeout = await fallbackFor(stalledPort().port, 5);
		assert.deepEqual(timeout.fallback, {
			name: "StageDecisionTimeoutError",
			code: "decision-timeout",
			hint: "The decision model was slow; a later run of the same workflow asks again.",
			phase: "scan",
			retryable: true,
		});
		const invalid = await fallbackFor({ decide: async () => ({ answers: {} }) });
		assert.equal(invalid.fallback?.code, "invalid-answer");
		assert.equal(invalid.fallback?.retryable, false);
		const malformed = await fallbackFor({ decide: async () => ({}) as StageDecisionResult });
		assert.equal(malformed.fallback?.code, "decision-failed", "a result without answers is a failed decision");
		assert.equal(malformed.fallback?.cause?.name, "TypeError");
	});

	test("a failure is not cached: the next launch of the definition asks again", async () => {
		let calls = 0;
		const port: StageDecisionPort = {
			decide: async () => {
				calls += 1;
				throw new Error("flaky");
			},
		};
		const predictor = new StagePredictor();
		const scan = scanOf([uncertainty([["review"]])]);
		for (let launch = 0; launch < 2; launch += 1) {
			const store = storeWithRoot();
			predictor.launch({
				store,
				runId: "root",
				workflowName: "flow",
				scan,
				maxDepth: 3,
				inputs: {},
				decisions: port,
				admitted: Promise.resolve(true),
			});
			await until(() => store.run("root")?.stagePredictions?.fallback !== undefined);
		}
		assert.equal(calls, 2);
	});

	test("a cancelled prediction is not recorded as a failure", async () => {
		const store = storeWithRoot();
		const predictor = new StagePredictor();
		const { port, counts } = stalledPort();
		predictor.launch({
			store,
			runId: "root",
			workflowName: "flow",
			scan: scanOf([uncertainty([["review"]])]),
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		const request = await new Promise<void>((resolve) => setTimeout(resolve, 5));
		void request;
		assert.equal(counts.started, 1);
		predictor.dispose();
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);
	});

	test("sends outside the known set are classified from answers in hand and asked once", async () => {
		const answers = new Map<string, number>([
			["summary-2", 0.9],
			["reviwe-1", 0.1],
			["maybe", 0.5],
		]);
		const { port, requests } = recordedPort(
			{ "stage review-1": 0.95 },
			(state) => answers.get(String(state.target)) ?? 0.5,
		);
		const predictor = new StagePredictor();
		const store = storeWithRoot(rootRun({ stages: [stage("lint")] }));
		predictor.launch({
			store,
			runId: "root",
			workflowName: "flow",
			scan: scanOf([uncertainty([["review-1"]])]),
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await until(() => store.run("root")?.stagePredictions !== undefined);
		const classify = (path: string) => predictor.classifySend(store.run("root")!, path.split("/"));

		assert.deepEqual(classify("review-1"), { prediction: "predicted" });
		assert.deepEqual(classify("review-*"), { prediction: "predicted" });
		for (const path of ["summary-2", "reviwe-1", "maybe"])
			assert.deepEqual(classify(path), { prediction: "unknown" });
		assert.deepEqual(classify("summary-2"), { prediction: "unknown" }, "an open question is never asked twice");
		await until(() => Object.keys(store.run("root")?.stagePredictions?.targets ?? {}).length === 3);
		assert.equal(requests.length, 4);
		const targetRequest = requests[1]!;
		assert.equal(targetRequest.state.target, "summary-2");
		assert.deepEqual(targetRequest.state.startedStages, ["lint"]);
		assert.deepEqual(targetRequest.state.predictedStages, ["review-1"]);
		assert.deepEqual(Object.keys(targetRequest.questions), ["target"]);

		assert.deepEqual(classify("summary-2"), { prediction: "predicted" });
		assert.deepEqual(classify("reviwe-1"), { prediction: "unknown", unexpected: true, suggestion: "review-1" });
		assert.deepEqual(classify("maybe"), { prediction: "unknown" });
		assert.equal(requests.length, 4);
		assert.deepEqual(store.run("root")?.stagePredictions, {
			status: "ready",
			entries: [
				{ path: "review-1", probability: 0.95, source: "scan" },
				{ path: "summary-2", probability: 0.9, source: "send" },
			],
			targets: { "summary-2": 0.9, "reviwe-1": 0.1, maybe: 0.5 },
		});
		assert.deepEqual(
			predictor.classifySend(rootRun({ id: "unlaunched" }), ["anything"]),
			{ prediction: "unknown" },
			"a root this predictor did not launch is never asked about",
		);
	});

	test("the threshold boundaries classify sends exactly", async () => {
		for (const [probability, expected] of [
			[0.8, { prediction: "predicted" }],
			[0.79, { prediction: "unknown" }],
			[0.21, { prediction: "unknown" }],
			[0.2, { prediction: "unknown", unexpected: true }],
		] as const) {
			const { port } = recordedPort({}, () => probability);
			const predictor = new StagePredictor();
			const store = storeWithRoot();
			predictor.launch({
				store,
				runId: "root",
				workflowName: "flow",
				scan: scanOf([], ["review"]),
				maxDepth: 3,
				inputs: {},
				decisions: port,
				admitted: Promise.resolve(true),
			});
			predictor.classifySend(store.run("root")!, ["deploy"]);
			await until(() => store.run("root")?.stagePredictions?.targets.deploy !== undefined);
			assert.deepEqual(predictor.classifySend(store.run("root")!, ["deploy"]), expected, String(probability));
		}
	});

	test("a failed target question falls back once and is asked again later", async () => {
		let calls = 0;
		const predictor = new StagePredictor();
		const store = storeWithRoot();
		predictor.launch({
			store,
			runId: "root",
			workflowName: "flow",
			scan: scanOf([], ["review"]),
			maxDepth: 3,
			inputs: {},
			decisions: {
				decide: async () => {
					calls += 1;
					throw new StageDecisionUnavailableError("target");
				},
			},
			admitted: Promise.resolve(true),
		});
		predictor.classifySend(store.run("root")!, ["deploy"]);
		await until(() => store.run("root")?.stagePredictions?.fallback !== undefined);
		assert.equal(store.run("root")?.stagePredictions?.fallback?.code, "decision-unavailable");
		predictor.classifySend(store.run("root")!, ["deploy"]);
		await until(() => calls === 2);
	});
});

describe("launch and delivery never wait for a prediction (#4359)", () => {
	async function launch(name: string, decisions: StageDecisionPort | undefined, predictor: StagePredictor) {
		setDurableBackend(await createMemoryTestBackend());
		const store = createStore();
		const definition = await fixtureDefinition(name);
		const result = await dispatch(
			{ action: "run", workflow: definition.normalizedName },
			{
				registry: createRegistry([definition]),
				store,
				adapters: { prompt: { prompt: async () => "ok" } },
				resolvePossibleStageEntry: () => fixtureEntry(name),
				...(decisions === undefined ? {} : { decisions }),
				stagePredictor: predictor,
			},
		);
		return { store, result };
	}

	test("dispatch returns an admitted run while the decision it started never settles (counted)", async () => {
		const { port, counts } = stalledPort();
		const predictor = new StagePredictor();
		const { store, result } = await launch("helper-names", port, predictor);
		assert.equal(result.action, "run");
		if (result.action !== "run") return;
		assert.notEqual(result.status, "failed");
		assert.ok(result.runId);
		assert.deepEqual(counts, { started: 1, settled: 0 });
		assert.equal(store.run(result.runId)?.stagePredictions, undefined);
		predictor.dispose();
	});

	test("without a decision service nothing is predicted", async () => {
		const predictor = new StagePredictor();
		const { store, result } = await launch("helper-names", undefined, predictor);
		if (result.action !== "run") assert.fail("expected a run result");
		await sleep(20);
		assert.equal(store.run(result.runId)?.stagePredictions, undefined);
		assert.deepEqual(predictor.classifySend(store.run(result.runId)!, ["anything"]), { prediction: "unknown" });
	});

	test("a send outside the known set is queued while its question is still open", async () => {
		const { port, counts } = stalledPort();
		const predictor = new StagePredictor();
		const store = createStore();
		const scan = scanPossibleStagesFromSource(fixtureEntry("helper-names"));
		store.recordRunStart(rootRun({ id: ROOT, possibleStages: ["review"] }));
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: ROOT,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
		predictor.launch({
			store,
			runId: ROOT,
			workflowName: "helper-names",
			scan: { ...scan, uncertainties: [] },
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		const listeners = new Map<string, (payload: unknown) => void>();
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit: (event, payload) => listeners.get(event)?.(payload),
					on: (event, listener) => listeners.set(event, listener),
				},
			},
			store,
			() => true,
			predictor,
		);
		const payload: { handled: boolean; completion?: Promise<unknown> } & Record<string, unknown> = {
			handled: false,
			requestId: "request-1",
			from: { id: "sender", name: "sender", cwd: "/repo", groups: [`workflow:${ROOT}`] },
			runId: ROOT,
			target: `workflow:${ROOT}/deploy`,
			message: { id: "message-1", timestamp: 1, content: { text: "hello" } },
		};
		listeners.get("atomic:workflow-pending-stage-message")?.(payload);
		assert.deepEqual(await payload.completion, { outcome: "queued", position: 1, prediction: "unknown" });
		assert.equal(counts.started, 1);
		assert.equal(counts.settled, 0);
		const entry = store.run(ROOT)?.pendingStageMessages?.[0];
		assert.equal(entry?.sticky, true);
		assert.equal(entry?.status, "queued");
		assert.equal(entry?.prediction, "unknown");
		dispose();
		predictor.dispose();
	});

	test("a likely typo is queued plainly, then judged, and the repeat send carries the suggestion", async () => {
		const { port, requests } = recordedPort({ "stage review-1": 0.94, "stage summary-2": 0.93 }, () => 0.05);
		const predictor = new StagePredictor();
		const store = createStore();
		const scan = scanPossibleStagesFromSource(fixtureEntry("helper-names"));
		store.recordRunStart(rootRun({ id: ROOT, possibleStages: scan.stages }));
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: ROOT,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
		predictor.launch({
			store,
			runId: ROOT,
			workflowName: "helper-names",
			scan,
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await until(() => store.run(ROOT)?.stagePredictions !== undefined);
		const listeners = new Map<string, (payload: unknown) => void>();
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit: (event, payload) => listeners.get(event)?.(payload),
					on: (event, listener) => listeners.set(event, listener),
				},
			},
			store,
			() => true,
			predictor,
		);
		const sendTo = async (id: string, stagePath: string) => {
			const payload: { handled: boolean; completion?: Promise<unknown> } & Record<string, unknown> = {
				handled: false,
				requestId: `request-${id}`,
				from: { id: "sender", name: "sender", cwd: "/repo", groups: [`workflow:${ROOT}`] },
				runId: ROOT,
				target: `workflow:${ROOT}/${stagePath}`,
				message: { id, timestamp: 1, content: { text: id } },
			};
			listeners.get("atomic:workflow-pending-stage-message")?.(payload);
			return payload.completion;
		};
		assert.deepEqual(await sendTo("m1", "review-1"), { outcome: "queued", position: 1, prediction: "predicted" });
		assert.deepEqual(await sendTo("m2", "reviwe-1"), { outcome: "queued", position: 1, prediction: "unknown" });
		await until(() => store.run(ROOT)?.stagePredictions?.targets["reviwe-1"] !== undefined);
		assert.deepEqual(await sendTo("m3", "reviwe-1"), {
			outcome: "queued",
			position: 2,
			prediction: "unknown",
			unexpected: true,
			suggestion: "review-1",
		});
		assert.equal(requests.length, 2, "one scan question and one target question");
		assert.deepEqual(
			store.run(ROOT)?.pendingStageMessages?.map((entry) => [entry.message.id, entry.status, entry.prediction]),
			[
				["m1", "queued", "predicted"],
				["m2", "queued", "unknown"],
				["m3", "queued", "unknown"],
			],
		);
		dispose();
	});

	test("recording predictions re-announces the root's rows, so intercom list updates without a send", async () => {
		const { port } = recordedPort({ "stage review-1": 0.94, "stage summary-2": 0.93 });
		const predictor = new StagePredictor();
		const store = createStore();
		const scan = scanPossibleStagesFromSource(fixtureEntry("helper-names"));
		store.recordRunStart(rootRun({ id: ROOT, possibleStages: scan.stages }));
		const backend = await createMemoryTestBackend();
		await backend.commitWorkflowRegistration({
			workflowId: ROOT,
			name: "flow",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		bindStoreDurableBackend(store, backend);
		const announced: (readonly { readonly target: string; readonly prediction?: string }[])[] = [];
		const listeners = new Map<string, (payload: unknown) => void>();
		const dispose = registerPendingStageIntercomBridge(
			{
				events: {
					emit: (event, payload) => {
						if (event === "atomic:workflow-pending-stage-route" && payload.runId === ROOT) {
							announced.push(payload.possibleStages as (typeof announced)[number]);
						}
						listeners.get(event)?.(payload);
					},
					on: (event, listener) => listeners.set(event, listener),
				},
			},
			store,
			() => true,
			predictor,
		);
		await dispose.flush();
		predictor.launch({
			store,
			runId: ROOT,
			workflowName: "helper-names",
			scan,
			maxDepth: 3,
			inputs: {},
			decisions: port,
			admitted: Promise.resolve(true),
		});
		await until(() => announced.at(-1)?.some((row) => row.prediction === "predicted") === true);
		assert.deepEqual(
			announced.at(-1)?.map((row) => [row.target, row.prediction]),
			[
				[`workflow:${ROOT}/*`, undefined],
				[`workflow:${ROOT}/review-1`, "predicted"],
				[`workflow:${ROOT}/summary-2`, "predicted"],
				[`workflow:${ROOT}/**`, undefined],
			],
		);
		dispose();
	});
});

describe("the host decision service as the prediction port (#4359)", () => {
	function catalog(decide: (request: WorkflowDecisionRequest) => Promise<DecisionResult>): WorkflowModelCatalogPort {
		return { listModels: async () => [], decide: decide as WorkflowModelCatalogPort["decide"] };
	}

	test("asks decide() for probabilities within the prediction's deadline and maps its answers", async () => {
		const requests: WorkflowDecisionRequest[] = [];
		const port = stageDecisionPortFromModels(
			catalog(async (request) => {
				requests.push(request);
				return {
					answers: {
						site0: { type: "choice", choice: "c0", probabilities: { c0: 0.9, none: 0.1 }, confidence: 0.9 },
						target: { type: "bool", value: true, probability: 0.85 },
						graded: { type: "score", score: 1, confidence: 0.5 },
					},
					source: "classifier",
					model: "typesafe/jev-latest",
					responseModel: "jev",
					usage: { inputTokens: 1, outputTokens: 1 },
				} as DecisionResult<DecisionQuestions>;
			}),
		);
		assert.ok(port);
		const signal = new AbortController().signal;
		const questions = {
			site0: scanQuestionPlan([uncertainty([["review-1"]])]).questions.site0!,
			target: targetQuestion("x"),
		};
		const result = await port.decide({
			state: { workflow: "flow", absent: undefined },
			questions,
			instructions: "judge",
			deadline: 1234,
			signal,
		});
		assert.deepEqual(result, {
			answers: {
				site0: { type: "choice", probabilities: { c0: 0.9, none: 0.1 } },
				target: { type: "bool", probability: 0.85 },
			},
		});
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0], {
			state: { workflow: "flow" },
			questions,
			instructions: "judge",
			deadline: 1234,
			signal,
			requireProbabilities: true,
		});
		assert.equal(stageDecisionPortFromModels(undefined), undefined);
		assert.equal(stageDecisionPortFromModels({ listModels: async () => [] }), undefined);
	});

	test("decision errors map to typed prediction fallbacks with the original as cause", async () => {
		const fallbackOf = async (error: Error) => {
			const store = createStore();
			store.recordRunStart(rootRun());
			new StagePredictor().launch({
				store,
				runId: "root",
				workflowName: "flow",
				scan: scanOf([uncertainty([["review"]])]),
				maxDepth: 3,
				inputs: {},
				decisions: stageDecisionPortFromModels(catalog(() => Promise.reject(error)))!,
				admitted: Promise.resolve(true),
			});
			await until(() => store.run("root")?.stagePredictions !== undefined);
			return store.run("root")!.stagePredictions!.fallback;
		};
		assert.deepEqual(
			await fallbackOf(new DecisionModelUnavailableError({ reason: "no-probabilities", model: "openai/gpt" })),
			{
				name: "StageDecisionUnavailableError",
				code: "decision-unavailable",
				hint: "Set decisionModel to a classifier model to predict dynamic stage names; the static scan still applies.",
				phase: "scan",
				retryable: false,
				cause: { name: "DecisionModelUnavailableError", code: "model-unavailable" },
			},
		);
		assert.deepEqual(
			await fallbackOf(new DecisionTimeoutError({ timeoutMs: 10, elapsedMs: 11, phase: "classifier" })),
			{
				name: "StageDecisionTimeoutError",
				code: "decision-timeout",
				hint: "The decision model was slow; a later run of the same workflow asks again.",
				phase: "scan",
				retryable: true,
				cause: { name: "DecisionTimeoutError", code: "timeout" },
			},
		);
		assert.deepEqual(
			(await fallbackOf(new DecisionOutputError({ model: "typesafe/jev-latest", detail: "bad" } as never)))?.cause,
			{ name: "DecisionOutputError", code: "invalid-output" },
		);
	});

	test("the typed fallback keeps the decision error as its cause", async () => {
		const original = new DecisionModelUnavailableError({ reason: "no-probabilities" });
		const predictor = new StagePredictor();
		const store = createStore();
		store.recordRunStart(rootRun());
		const seen: unknown[] = [];
		predictor.launch({
			store,
			runId: "root",
			workflowName: "flow",
			scan: scanOf([], ["review"]),
			maxDepth: 3,
			inputs: {},
			decisions: {
				decide: async (request) => {
					try {
						return await stageDecisionPortFromModels(catalog(() => Promise.reject(original)))!.decide(request);
					} catch (error) {
						seen.push(error);
						throw error;
					}
				},
			},
			admitted: Promise.resolve(true),
		});
		predictor.classifySend(store.run("root")!, ["deploy"]);
		await until(() => store.run("root")?.stagePredictions?.fallback !== undefined);
		assert.equal(seen[0], original);
		assert.equal(store.run("root")?.stagePredictions?.fallback?.code, "decision-unavailable");
		assert.equal(store.run("root")?.stagePredictions?.entries.length, 0);
	});

	test("a chat-only decision model's fallback stays out of the status text", () => {
		const run = rootRun({
			stagePredictions: {
				status: "fallback",
				entries: [],
				targets: {},
				fallback: {
					name: "StageDecisionUnavailableError",
					code: "decision-unavailable",
					hint: "Set decisionModel.",
					phase: "scan",
					retryable: false,
				},
			},
		});
		const status = stagePredictionStatus(run, [run]);
		assert.equal(status?.fallback?.code, "decision-unavailable");
		assert.deepEqual(formatStagePredictionStatus(status!), []);
	});

	test("dispatch predicts through the host's decide() when no port is injected", async () => {
		setDurableBackend(await createMemoryTestBackend());
		const store = createStore();
		const definition = await fixtureDefinition("data-driven-loop");
		const requests: WorkflowDecisionRequest[] = [];
		const result = await dispatch(
			{ action: "run", workflow: definition.normalizedName },
			{
				registry: createRegistry([definition]),
				store,
				adapters: { prompt: { prompt: async () => "ok" } },
				resolvePossibleStageEntry: () => fixtureEntry("data-driven-loop"),
				models: catalog(async (request) => {
					requests.push(request);
					const question = request.questions.site0!;
					const group = Object.entries(question.criteria).find(
						([, text]) => text === "every one of api, ui, docs",
					)![0];
					return {
						answers: { site0: { type: "choice", choice: group, probabilities: { [group]: 0.9 } } },
						source: "classifier",
						model: "typesafe/jev-latest",
						responseModel: "jev",
						usage: { inputTokens: 1, outputTokens: 1 },
					} as DecisionResult<DecisionQuestions>;
				}),
				stagePredictor: new StagePredictor(),
			},
		);
		if (result.action !== "run") assert.fail("expected a run result");
		await until(() => store.run(result.runId)?.stagePredictions !== undefined);
		assert.deepEqual(
			store.run(result.runId)?.stagePredictions?.entries.map((entry) => entry.path),
			["api", "ui", "docs"],
		);
		assert.equal(requests[0]?.requireProbabilities, true);
		assert.equal(requests[0]?.deadline, 60_000);
		assert.match(requests[0]?.instructions ?? "", /static scan could not read/);
	});
});
