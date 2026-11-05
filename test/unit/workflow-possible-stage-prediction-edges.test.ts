import assert from "node:assert/strict";
import { join } from "node:path";
import type { DecisionQuestions, DecisionResult } from "@bastani/atomic";
import { afterEach, describe, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { currentWorkflowSessionRunState } from "../../packages/workflows/src/extension/adopt-session-run-state.js";
import { dispatch } from "../../packages/workflows/src/extension/dispatcher.js";
import { createWorkflowExtensionRuntimeState } from "../../packages/workflows/src/extension/extension-runtime-state.js";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { summarizeRunSnapshot } from "../../packages/workflows/src/extension/workflow-status-summary.js";
import { inspectRun } from "../../packages/workflows/src/runs/background/run-inspect.js";
import type { WorkflowDecisionRequest } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createWorkflowBoundaryHopsResolver } from "../../packages/workflows/src/shared/pending-stage-status.js";
import {
	closestStagePath,
	decodeScanAnswers,
	formatStagePredictionStatus,
	knownScanEntries,
	scanDecisionState,
	scanQuestionPlan,
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
	PossibleStagePredictionError,
	StageDecisionAnswerError,
	StageDecisionFailedError,
	type StageDecisionPort,
	type StageDecisionRequest,
	type StageDecisionResult,
	StageDecisionTimeoutError,
	StageDecisionUnavailableError,
} from "../../packages/workflows/src/shared/possible-stage-prediction-errors.js";
import { StagePredictor } from "../../packages/workflows/src/shared/possible-stage-predictor.js";
import {
	PossibleStageRowsIndex,
	WorkflowTopologyIndex,
} from "../../packages/workflows/src/shared/possible-stage-rows.js";
import type {
	PossibleStagesScanResult,
	PossibleStageUncertainty,
} from "../../packages/workflows/src/shared/possible-stages.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	RunSnapshot,
	RunStagePredictions,
	StageSnapshot,
} from "../../packages/workflows/src/shared/store-types.js";
import type {
	WorkflowDefinition,
	WorkflowModelCatalogPort,
	WorkflowRuntimeConfig,
} from "../../packages/workflows/src/shared/types.js";
import { renderRunDetail } from "../../packages/workflows/src/tui/run-detail.js";
import { renderStatusList } from "../../packages/workflows/src/tui/status-list.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { moduleDir, sleep } from "../helpers/runtime.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

const FIXTURES = join(moduleDir(import.meta.url), "..", "fixtures", "possible-stage-prediction");
const fixtureEntry = (name: string): string => join(FIXTURES, name, "workflow.mjs");

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

function scanOf(
	uncertainties: readonly PossibleStageUncertainty[],
	stages: readonly string[] = ["*"],
	digest = "a",
): PossibleStagesScanResult {
	return {
		stages,
		hasTrackedNodes: true,
		warnings: [],
		uncertainties,
		wildcardsWithoutUncertainty: [],
		sources: [{ file: "workflow.mjs", sha256: digest }],
	};
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
	return {
		id: `${name}-id`,
		name,
		status: "running",
		startedAt: 1,
		parentIds: [],
		toolEvents: [],
		...overrides,
	} as StageSnapshot;
}

function storeWith(run: RunSnapshot = rootRun()) {
	const store = createStore();
	store.recordRunStart(run);
	return store;
}

async function until(condition: () => boolean, attempts = 400): Promise<void> {
	for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) await sleep(5);
	assert.ok(condition(), "condition did not hold in time");
}

/** Answers every choice option with `choice` and every yes/no question with `yes`, recording each request. */
function answeringPort(
	choice: (text: string) => number,
	yes: (state: StageDecisionRequest["state"]) => number = () => 0.5,
) {
	const requests: StageDecisionRequest[] = [];
	const port: StageDecisionPort = {
		async decide(request) {
			requests.push(request);
			const answers: Record<string, StageDecisionResult["answers"][string]> = {};
			for (const [key, question] of Object.entries(request.questions)) {
				answers[key] =
					question.type === "bool"
						? { type: "bool", probability: yes(request.state) }
						: {
								type: "choice",
								probabilities: Object.fromEntries(
									Object.entries(question.criteria).map(([option, text]) => [option, choice(text)]),
								),
							};
			}
			return { answers };
		},
	};
	return { port, requests };
}

/** A port whose decisions settle only when the test resolves them, in request order. */
function deferredPort() {
	const pending: {
		request: StageDecisionRequest;
		resolve: (result: StageDecisionResult) => void;
		reject: (error: Error) => void;
	}[] = [];
	const port: StageDecisionPort = {
		decide: (request) => new Promise((resolve, reject) => pending.push({ request, resolve, reject })),
	};
	return { port, pending };
}

function launch(
	predictor: StagePredictor,
	store: ReturnType<typeof createStore>,
	decisions: StageDecisionPort,
	scan: PossibleStagesScanResult,
	runId = "root",
	admitted = Promise.resolve(true),
): void {
	predictor.launch({ store, runId, workflowName: "flow", scan, maxDepth: 3, inputs: {}, decisions, admitted });
}

afterEach(() => {
	setDurableBackend(undefined);
	vi.restoreAllMocks();
});

describe("prediction questions and answers at their edges (#4359)", () => {
	test("a child candidate without scanned stages is described by its boundary alone", () => {
		const plan = scanQuestionPlan(
			scanOf([
				uncertainty([], {
					code: "unresolved-child",
					candidates: [{ stages: ["workflow:child-x"], source: "child-definition" }],
				}),
			]),
		);
		assert.equal(plan.questions.site0?.type, "choice");
		assert.deepEqual(plan.questions.site0?.criteria, {
			c0: "child workflow workflow:child-x",
			none: "none of these candidates",
		});
	});

	test("a child candidate lists every scanned stage it brings", () => {
		const plan = scanQuestionPlan(
			scanOf([
				uncertainty([], {
					code: "unresolved-child",
					candidates: [{ stages: ["workflow:c", "workflow:c/a", "workflow:c/b"], source: "child-definition" }],
				}),
			]),
		);
		assert.deepEqual(plan.questions.site0?.criteria, {
			c0: "child workflow workflow:c with stages workflow:c/a, workflow:c/b",
			none: "none of these candidates",
		});
	});

	test("the state keeps at most 64 known stages, 12 asked call sites and 12 others, which carry no question key", () => {
		const stages = Array.from({ length: 70 }, (_, index) => `stage-${index}`);
		const asked = Array.from({ length: 14 }, (_, index) => uncertainty([[`s${index}`]], { line: index + 1 }));
		const unasked = Array.from({ length: 12 }, (_, index) => uncertainty([], { line: 100 + index }));
		const state = scanDecisionState("flow", scanOf([...asked, ...unasked], stages), {});
		assert.deepEqual(state.knownStages, stages.slice(0, 64));
		assert.equal((state.uncertainCallSites as readonly unknown[]).length, 12);
		const others = state.otherUnreadCallSites as readonly Record<string, unknown>[];
		assert.deepEqual(
			others.map((site) => site.line),
			[13, 14, ...Array.from({ length: 10 }, (_, index) => 100 + index)],
		);
		assert.ok(others.every((site) => !("site" in site)));
		assert.deepEqual(others[0], {
			code: "unresolved-name",
			file: "workflow.mjs",
			line: 13,
			boundary: "",
			source: "await ctx.task(name(1))",
		});
	});

	test("a probability of exactly 1 is accepted; text, missing or misplaced probabilities are refused", () => {
		const plan = scanQuestionPlan(scanOf([uncertainty([["review"]])]));
		assert.deepEqual(decodeScanAnswers(plan, { answers: { site0: { type: "choice", probabilities: { c0: 1 } } } }), {
			entries: [{ path: "review", probability: 1, source: "scan" }],
			resolvedPlaceholders: [],
		});
		const refusals: readonly [unknown, string][] = [
			[{ type: "choice", probabilities: { c0: "0.9" } }, "not-a-probability"],
			[{ type: "choice" }, "wrong-type"],
			[{ type: "choice", probabilities: null }, "wrong-type"],
			[{ type: "bool", probabilities: { c0: 0.9 } }, "wrong-type"],
		];
		for (const [answer, reason] of refusals) {
			assert.throws(
				() => decodeScanAnswers(plan, { answers: { site0: answer as never } }),
				(error: unknown) => isStageDecisionAnswerError(error) && error.reason === reason,
				JSON.stringify(answer),
			);
		}
	});

	test("the target question spells out what yes and no mean", () => {
		assert.deepEqual(targetQuestion("deploy").criteria, {
			true: "Yes: a stage this run starts will match the path.",
			false: "No: no stage will match; the path is likely a typo or a stale name.",
		});
	});

	test("the closest name prefers the single nearest of several close names", () => {
		assert.equal(closestStagePath("abcdef", ["abxdxf", "abcdxf"]), "abcdxf");
		assert.equal(closestStagePath("abcdef", ["abcdxf", "abcdyf"]), undefined);
		assert.equal(closestStagePath("abcdef", []), undefined);
	});

	test("a scan prediction keeps every wildcard it did not resolve", () => {
		const predicted: RunStagePredictions = {
			status: "ready",
			targets: {},
			entries: [{ path: "y", probability: 0.9, source: "scan" }],
			resolvedPlaceholders: ["*"],
		};
		assert.deepEqual(
			knownScanEntries({
				possibleStages: ["*", "workflow:*", "workflow:*/lint", "lint"],
				stagePredictions: predicted,
			}),
			["workflow:*", "workflow:*/lint", "lint"],
		);
	});
});

describe("prediction outcomes at their edges (#4359)", () => {
	const child = (id: string, parentRunId: string, parentStageId: string, stages: StageSnapshot[]) =>
		rootRun({ id, parentRunId, parentStageId, rootRunId: "root", stages });

	test("a nested prediction stays pending while the root runs, even once its innermost boundary ended", () => {
		const runs = [
			rootRun({ stages: [stage("workflow:a", { status: "running" })] }),
			child("child-a", "root", "workflow:a-id", [stage("workflow:b", { status: "completed" })]),
			child("child-b", "child-a", "workflow:b-id", [stage("draft", { status: "completed" })]),
		];
		const hopsOf = createWorkflowBoundaryHopsResolver(runs);
		assert.equal(stagePredictionOutcome("workflow:a/workflow:b/extra", runs[0]!, runs, hopsOf), "predicted");
		assert.equal(
			stagePredictionOutcome("workflow:a/workflow:b/extra", { status: "completed" }, runs, hopsOf),
			"unused",
		);
		assert.equal(stagePredictionOutcome("workflow:a/workflow:b/draft", runs[0]!, runs, hopsOf), "confirmed");
	});

	test("a prediction stays pending beside open and ended boundaries; runs without lineage are skipped", () => {
		const runs = [
			rootRun({
				stages: [
					stage("workflow:a", { id: "a-1", status: "completed" }),
					stage("workflow:a", { id: "a-2", status: "running" }),
				],
			}),
			rootRun({ id: "orphan", stages: [stage("extra")] }),
		];
		const hopsOf = (runId: string) => (runId === "orphan" ? undefined : []);
		assert.equal(stagePredictionOutcome("workflow:a/extra", runs[0]!, runs, hopsOf), "predicted");
		assert.equal(stagePredictionOutcome("extra", runs[0]!, runs, hopsOf), "predicted");
	});

	test("status reads only the root's own invocation, omits an absent fallback, and counts what it leaves out", () => {
		const entries = Array.from({ length: 5 }, (_, index) => ({
			path: `s${index}`,
			probability: 0.9,
			source: "scan" as const,
		}));
		const run = rootRun({ stagePredictions: { status: "ready", entries, targets: {} } });
		const other = rootRun({ id: "other-root", stages: [stage("s0")] });
		const status = stagePredictionStatus(run, [run, other]);
		assert.deepEqual(status, { entries: entries.map((entry) => ({ ...entry, outcome: "predicted" })) });
		assert.deepEqual(formatStagePredictionStatus(status), [
			"stage predictions: s0 predicted 0.90, s1 predicted 0.90, s2 predicted 0.90, s3 predicted 0.90, s4 predicted 0.90",
		]);
		assert.deepEqual(formatStagePredictionStatus(undefined), []);
	});

	test("a status summary without other runs still confirms predictions from the run's own stages", () => {
		const run = rootRun({
			stages: [stage("review-1")],
			stagePredictions: {
				status: "ready",
				entries: [{ path: "review-1", probability: 0.9, source: "scan" }],
				targets: {},
			},
		});
		assert.equal(summarizeRunSnapshot(run, 2).stagePredictions?.entries[0]?.outcome, "confirmed");
		assert.equal("stagePredictions" in summarizeRunSnapshot(rootRun(), 2), false);
	});

	test("the status card truncates a long prediction line inside the card's margin", () => {
		const run = rootRun({
			stagePredictions: {
				status: "ready",
				targets: {},
				entries: Array.from({ length: 5 }, (_, index) => ({
					path: `a-rather-long-predicted-stage-name-${index}`,
					probability: 0.9,
					source: "scan" as const,
				})),
			},
		});
		const lines = renderStatusList([run], { width: 60 }).split("\n");
		const prediction = lines.find((line) => line.includes("stage predictions"));
		assert.equal(prediction, "│   stage predictions: a-rather-long-predicted-stage\u001b[0m…\u001b[0m      │");
		assert.equal(visibleWidth(prediction), 60);
	});
});

describe("the run detail's predictions (#4359)", () => {
	test("a run's detail lists its predictions and a failed prediction, and nothing when it has none", () => {
		const store = storeWith(
			rootRun({
				stages: [stage("review-1")],
				stagePredictions: {
					status: "fallback",
					targets: {},
					entries: [
						{ path: "review-1", probability: 0.95, source: "scan" },
						{ path: "summary-2", probability: 0.9, source: "scan" },
					],
					fallback: {
						name: "StageDecisionTimeoutError",
						code: "decision-timeout",
						hint: "Later runs ask again.",
						phase: "target",
						retryable: true,
					},
				},
			}),
		);
		const inspected = inspectRun("root", { store, now: 2 });
		if (!inspected.ok) assert.fail("expected the run");
		assert.deepEqual(
			inspected.detail.stagePredictions?.entries.map((entry) => [entry.path, entry.outcome]),
			[
				["review-1", "confirmed"],
				["summary-2", "predicted"],
			],
		);
		const text = renderRunDetail(inspected.detail, { now: 2, width: 160 });
		assert.match(text, /predictions\s+review-1 confirmed 0\.95, summary-2 predicted 0\.90/);
		assert.match(text, /predictions\s+unavailable \(decision-timeout\): Later runs ask again\./);

		const plain = inspectRun("plain", { store: storeWith(rootRun({ id: "plain" })), now: 2 });
		if (!plain.ok) assert.fail("expected the run");
		assert.equal("stagePredictions" in plain.detail, false);
		assert.doesNotMatch(renderRunDetail(plain.detail, { now: 2, width: 160 }), /predictions/);
	});
});

describe("prediction rows at their edges (#4359)", () => {
	test("a prediction the scan already names gets no row of its own, even once that stage is live", () => {
		const run = rootRun({
			possibleStages: ["lint"],
			stages: [stage("lint", { pendingStageDeliveryAvailable: true })],
			stagePredictions: {
				status: "ready",
				entries: [{ path: "lint", probability: 0.95, source: "send" }],
				targets: {},
			},
		});
		const topology = new WorkflowTopologyIndex();
		topology.refresh([run]);
		assert.deepEqual(new PossibleStageRowsIndex("root", topology).rows([run], run, undefined), [
			{ target: "workflow:root/**", queuedCount: 0 },
		]);
	});

	test("a row's prediction and probability changes reach the announced row", () => {
		const topology = new WorkflowTopologyIndex();
		const index = new PossibleStageRowsIndex("root", topology);
		const predictions = (probability: number): RunStagePredictions => ({
			status: "ready",
			targets: {},
			entries: [{ path: "deploy", probability, source: "send" }],
		});
		const first = rootRun({ stagePredictions: predictions(0.85) });
		topology.refresh([first]);
		assert.deepEqual(index.rows([first], first, undefined)[0], {
			target: "workflow:root/deploy",
			queuedCount: 0,
			prediction: "predicted",
			probability: 0.85,
		});
		const reprobed = rootRun({ stagePredictions: predictions(0.95) });
		topology.refresh([reprobed]);
		assert.equal(index.rows([reprobed], reprobed, undefined)[0]?.probability, 0.95);
		const started = rootRun({ stages: [stage("deploy")], stagePredictions: predictions(0.95) });
		topology.refresh([started]);
		assert.equal(index.rows([started], started, undefined)[0]?.prediction, "confirmed");
	});
});

describe("the store's prediction record (#4359)", () => {
	test("recording for a missing run is ignored, and a change names its run", () => {
		const store = storeWith();
		const changes: unknown[] = [];
		store.subscribeInvalidation((change) => changes.push(change));
		store.recordRunStagePredictions?.("missing", { status: "ready", entries: [], targets: {} });
		store.recordRunStagePredictions?.("root", { status: "ready", entries: [], targets: {} });
		assert.deepEqual(store.run("root")?.stagePredictions, { status: "ready", entries: [], targets: {} });
		assert.ok(JSON.stringify(changes).includes('"runId":"root"'), JSON.stringify(changes));
	});
});

describe("stage predictor at its edges (#4359)", () => {
	test("a scan with only a wildcard and no uncertain call site asks nothing", async () => {
		const { port, requests } = answeringPort(() => 0.9);
		launch(new StagePredictor(), storeWith(), port, scanOf([], ["review", "*"]));
		await sleep(10);
		assert.equal(requests.length, 0);
	});

	test("an unadmitted run records no fallback either", async () => {
		let calls = 0;
		const store = storeWith();
		launch(
			new StagePredictor(),
			store,
			{
				decide: async () => {
					calls += 1;
					throw new StageDecisionUnavailableError("scan");
				},
			},
			scanOf([uncertainty([["review"]])]),
			"root",
			Promise.resolve(false),
		);
		await until(() => calls === 1);
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);
	});

	test("a later run of the same definition is classified from the cached answers, with suggestions from its scan", async () => {
		const answers = new Map([
			["deploy/now", 0.8],
			["reviwe-1", 0.1],
		]);
		const { port, requests } = answeringPort(
			() => 0,
			(state) => answers.get(String(state.target)) ?? 0.5,
		);
		const predictor = new StagePredictor();
		const scan = scanOf([], ["review-1", "review-*"]);
		const first = storeWith();
		launch(predictor, first, port, scan);
		predictor.classifySend(first.run("root")!, ["deploy", "now"]);
		predictor.classifySend(first.run("root")!, ["reviwe-1"]);
		await until(() => Object.keys(first.run("root")?.stagePredictions?.targets ?? {}).length === 2);
		assert.deepEqual(first.run("root")?.stagePredictions?.targets, { "deploy/now": 0.8, "reviwe-1": 0.1 });
		assert.deepEqual(first.run("root")?.stagePredictions?.status, "ready");
		assert.deepEqual(first.run("root")?.stagePredictions?.entries, [
			{ path: "deploy/now", probability: 0.8, source: "send" },
		]);

		const second = storeWith(rootRun({ id: "second" }));
		launch(predictor, second, port, scan, "second");
		assert.deepEqual(predictor.classifySend(second.run("second")!, ["deploy", "now"]), { prediction: "predicted" });
		const fresh = rootRun({ id: "second" });
		assert.deepEqual(predictor.classifySend(fresh, ["reviwe-1"]), {
			prediction: "unknown",
			unexpected: true,
			suggestion: "review-1",
		});
		assert.equal(requests.length, 2, "the second run asked nothing");
	});

	test("a target question carries the run's started stages, at most 64, and no predictions when there are none", async () => {
		const { port, requests } = answeringPort(() => 0);
		const predictor = new StagePredictor();
		const stages = Array.from({ length: 70 }, (_, index) => stage(`stage-${index}`));
		const store = storeWith(rootRun({ stages }));
		launch(predictor, store, port, scanOf([], ["review"]));
		predictor.classifySend(store.run("root")!, ["deploy"]);
		await until(() => requests.length === 1);
		assert.deepEqual(
			requests[0]?.state.startedStages,
			stages.slice(0, 64).map((entry) => entry.name),
		);
		assert.deepEqual(requests[0]?.state.predictedStages, []);
		assert.equal(requests[0]?.state.target, "deploy");
	});

	test("at most 256 targets of one definition are asked about", async () => {
		const { port, counts } = (() => {
			const counts = { started: 0 };
			return {
				counts,
				port: {
					decide: () => {
						counts.started += 1;
						return new Promise<StageDecisionResult>(() => {});
					},
				} satisfies StageDecisionPort,
			};
		})();
		const predictor = new StagePredictor();
		const store = storeWith();
		launch(predictor, store, port, scanOf([], ["review"]));
		for (let index = 0; index < 257; index += 1) predictor.classifySend(store.run("root")!, [`target-${index}`]);
		assert.equal(counts.started, 256);
		predictor.dispose();
	});

	test("disposing aborts open decisions with a cancellation that is never recorded", async () => {
		const { port, pending } = deferredPort();
		const predictor = new StagePredictor();
		const store = storeWith();
		launch(predictor, store, port, scanOf([uncertainty([["review"]])]));
		assert.equal(pending.length, 1);
		const signal = pending[0]!.request.signal;
		assert.equal(signal.aborted, false);
		predictor.dispose();
		assert.equal(signal.aborted, true);
		assert.equal((signal.reason as DOMException).name, "AbortError");
		assert.equal((signal.reason as DOMException).message, "Stage prediction was disposed");
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);
	});

	test("a port that rejects on cancellation is still treated as cancelled", async () => {
		const predictor = new StagePredictor();
		const store = storeWith();
		let rejected = false;
		launch(
			predictor,
			store,
			{
				decide: (request) =>
					new Promise((_, reject) =>
						request.signal.addEventListener("abort", () => {
							rejected = true;
							reject(new Error("the port gave up"));
						}),
					),
			},
			scanOf([uncertainty([["review"]])]),
		);
		predictor.dispose();
		await until(() => rejected);
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);
	});

	test("a disposed predictor records nothing for a later launch, even when the port answers", async () => {
		const { port, requests } = answeringPort(() => 0.95);
		const predictor = new StagePredictor();
		predictor.dispose();
		const store = storeWith();
		launch(predictor, store, port, scanOf([uncertainty([["review"]])]));
		await until(() => requests.length === 1);
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);
	});

	test("the deadline aborts the decision with a typed timeout measured from the start", async () => {
		const { port, pending } = deferredPort();
		const store = storeWith();
		const before = Date.now();
		launch(new StagePredictor({ deadlineMs: 20 }), store, port, scanOf([uncertainty([["review"]])]));
		const signal = pending[0]!.request.signal;
		await until(() => signal.aborted);
		const reason = signal.reason as StageDecisionTimeoutError;
		assert.ok(isStageDecisionTimeoutError(reason));
		assert.equal(reason.timeoutMs, 20);
		assert.ok(reason.elapsedMs >= 15 && reason.elapsedMs <= Date.now() - before + 5, String(reason.elapsedMs));
		assert.equal(reason.phase, "scan");
		await until(() => store.run("root")?.stagePredictions?.fallback !== undefined);
		assert.equal(store.run("root")?.stagePredictions?.fallback?.code, "decision-timeout");
	});

	test("a decision that settles in time leaves its signal alone after the deadline", async () => {
		const { port, requests } = answeringPort(() => 0.95);
		const store = storeWith();
		launch(new StagePredictor({ deadlineMs: 20 }), store, port, scanOf([uncertainty([["review"]])]));
		await until(() => store.run("root")?.stagePredictions !== undefined);
		await sleep(40);
		assert.equal(requests[0]?.signal.aborted, false);
	});

	test("the definition cache keeps the newest 128 definitions", async () => {
		const { port, requests } = answeringPort(() => 0.95);
		const predictor = new StagePredictor();
		const store = storeWith();
		const scanFor = (index: number) => scanOf([uncertainty([["review"]])], ["*"], `digest-${index}`);
		const settle = async (index: number) => {
			const before = requests.length;
			launch(predictor, store, port, scanFor(index));
			await sleep(0);
			return requests.length - before;
		};
		for (let index = 0; index < 128; index += 1) await settle(index);
		await until(() => requests.length === 128);
		assert.equal(await settle(0), 0, "128 definitions fit");
		assert.equal(await settle(128), 1);
		await sleep(5);
		assert.equal(await settle(0), 1, "the oldest definition was evicted");
	});

	test("the predictor remembers the newest 512 roots", () => {
		const { port, requests } = answeringPort(() => 0);
		const predictor = new StagePredictor();
		const store = createStore();
		for (let index = 0; index < 513; index += 1) {
			launch(predictor, store, port, scanOf([], ["review"], `d${index}`), `run-${index}`);
		}
		predictor.classifySend(rootRun({ id: "run-0" }), ["deploy"]);
		assert.equal(requests.length, 0, "the oldest root is forgotten");
		predictor.classifySend(rootRun({ id: "run-1" }), ["deploy"]);
		assert.equal(requests.length, 1);
	});

	test("a prediction for a run the store no longer holds is dropped quietly", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { port, pending } = deferredPort();
		const store = storeWith();
		launch(new StagePredictor(), store, port, scanOf([uncertainty([["review"]])]));
		store.removeRun("root");
		pending[0]!.resolve({ answers: { site0: { type: "choice", probabilities: { c0: 0.9 } } } });
		await sleep(10);
		assert.equal(warn.mock.calls.length, 0);
	});

	test("a failed or malformed target answer falls back with the target phase and its cause", async () => {
		for (const [settle, cause] of [
			[
				(entry: ReturnType<typeof deferredPort>["pending"][number]) => entry.reject(new Error("down")),
				{ name: "Error" },
			],
			[
				(entry: ReturnType<typeof deferredPort>["pending"][number]) => entry.resolve({} as StageDecisionResult),
				{ name: "TypeError" },
			],
		] as const) {
			const { port, pending } = deferredPort();
			const predictor = new StagePredictor();
			const store = storeWith();
			launch(predictor, store, port, scanOf([], ["review"]));
			predictor.classifySend(store.run("root")!, ["deploy"]);
			settle(pending[0]!);
			await until(() => store.run("root")?.stagePredictions?.fallback !== undefined);
			assert.deepEqual(store.run("root")?.stagePredictions?.fallback, {
				name: "StageDecisionFailedError",
				code: "decision-failed",
				hint: "Check the decision model's provider status; the static scan still applies.",
				phase: "target",
				retryable: false,
				cause,
			});
		}
	});

	test("a malformed scan answer falls back with the scan phase and a cause without a code", async () => {
		const { port, pending } = deferredPort();
		const store = storeWith();
		launch(new StagePredictor(), store, port, scanOf([uncertainty([["review"]])]));
		pending[0]!.resolve({} as StageDecisionResult);
		await until(() => store.run("root")?.stagePredictions?.fallback !== undefined);
		assert.deepEqual(store.run("root")?.stagePredictions?.fallback?.phase, "scan");
		assert.deepEqual(store.run("root")?.stagePredictions?.fallback?.cause, { name: "TypeError" });
	});

	test("a target answer is not recorded into a store without a prediction record", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const store = storeWith();
		(store as { recordRunStagePredictions?: unknown }).recordRunStagePredictions = undefined;
		const predictor = new StagePredictor();
		const { port, requests } = answeringPort(
			() => 0,
			() => 0.95,
		);
		launch(predictor, store, port, scanOf([], ["review"]));
		predictor.classifySend(store.run("root")!, ["deploy"]);
		await until(() => requests.length === 1);
		await sleep(10);
		predictor.classifySend(store.run("root")!, ["deploy"]);
		assert.equal(warn.mock.calls.length, 0);
	});

	test("a store without a prediction record is left alone", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const store = storeWith();
		(store as { recordRunStagePredictions?: unknown }).recordRunStagePredictions = undefined;
		const predictor = new StagePredictor();
		const { port } = answeringPort(
			() => 0.95,
			() => 0.95,
		);
		launch(predictor, store, port, scanOf([uncertainty([["review"]])]));
		launch(
			predictor,
			store,
			{ decide: async () => Promise.reject(new Error("down")) },
			scanOf([uncertainty([["x"]])], ["*"], "other"),
		);
		predictor.classifySend(store.run("root")!, ["deploy"]);
		await sleep(20);
		assert.equal(warn.mock.calls.length, 0);
	});

	test("a store that cannot record is reported once per failed write", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const store = storeWith();
		store.recordRunStagePredictions = () => {
			throw new Error("store is closed");
		};
		launch(new StagePredictor(), store, answeringPort(() => 0.95).port, scanOf([uncertainty([["review"]])]));
		await until(() => warn.mock.calls.length === 1);
		assert.equal(
			warn.mock.calls[0]?.[0],
			"atomic-workflows: a stage prediction could not be recorded: store is closed",
		);
	});

	test("scan answers merge after earlier send answers without replacing them", async () => {
		const { port, pending } = deferredPort();
		const predictor = new StagePredictor();
		const store = storeWith();
		launch(predictor, store, port, scanOf([uncertainty([["x"], ["y"]])]));
		predictor.classifySend(store.run("root")!, ["x"]);
		const [scanQuestion, targetAsk] = pending;
		targetAsk!.resolve({ answers: { target: { type: "bool", probability: 0.85 } } });
		await until(() => store.run("root")?.stagePredictions?.entries.length === 1);
		scanQuestion!.resolve({ answers: { site0: { type: "choice", probabilities: { c0: 0.9, c1: 0.95 } } } });
		await until(() => store.run("root")?.stagePredictions?.entries.length === 2);
		assert.deepEqual(store.run("root")?.stagePredictions?.entries, [
			{ path: "x", probability: 0.85, source: "send" },
			{ path: "y", probability: 0.95, source: "scan" },
		]);
		assert.equal(store.run("root")?.stagePredictions?.status, "ready");
	});

	test("a send answer for a path the scan already predicted adds no duplicate entry", async () => {
		const { port, pending } = deferredPort();
		const predictor = new StagePredictor();
		const store = storeWith();
		launch(predictor, store, port, scanOf([uncertainty([["x"]])]));
		predictor.classifySend(store.run("root")!, ["x"]);
		const [scanQuestion, targetAsk] = pending;
		scanQuestion!.resolve({ answers: { site0: { type: "choice", probabilities: { c0: 0.9 } } } });
		await until(() => store.run("root")?.stagePredictions?.entries.length === 1);
		targetAsk!.resolve({ answers: { target: { type: "bool", probability: 0.99 } } });
		await until(() => store.run("root")?.stagePredictions?.targets.x === 0.99);
		assert.deepEqual(store.run("root")?.stagePredictions?.entries, [{ path: "x", probability: 0.9, source: "scan" }]);
	});

	test("a scan answer after a fallback keeps the fallback status, and the first fallback wins", async () => {
		const { port, pending } = deferredPort();
		const predictor = new StagePredictor();
		const store = storeWith();
		launch(predictor, store, port, scanOf([uncertainty([["x"]])]));
		predictor.classifySend(store.run("root")!, ["first"]);
		predictor.classifySend(store.run("root")!, ["second"]);
		const [scanQuestion, first, second] = pending;
		first!.resolve({ answers: {} });
		await until(() => store.run("root")?.stagePredictions?.fallback !== undefined);
		second!.reject(new Error("provider down"));
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions?.fallback?.code, "invalid-answer");
		assert.equal(store.run("root")?.stagePredictions?.fallback?.phase, "target");
		scanQuestion!.resolve({ answers: { site0: { type: "choice", probabilities: { c0: 0.9 } } } });
		await until(() => store.run("root")?.stagePredictions?.entries.length === 1);
		assert.equal(store.run("root")?.stagePredictions?.status, "fallback");
	});

	test("repeating a send with the same answer does not touch the store again", async () => {
		const { port } = answeringPort(
			() => 0,
			() => 0.5,
		);
		const predictor = new StagePredictor();
		const store = storeWith();
		launch(predictor, store, port, scanOf([], ["review"]));
		predictor.classifySend(store.run("root")!, ["maybe"]);
		await until(() => store.run("root")?.stagePredictions?.targets.maybe === 0.5);
		let invalidations = 0;
		store.subscribeInvalidation(() => {
			invalidations += 1;
		});
		predictor.classifySend(store.run("root")!, ["maybe"]);
		predictor.classifySend(store.run("root")!, ["maybe"]);
		assert.equal(invalidations, 0);
	});
});

describe("dispatch wiring at its edges (#4359)", () => {
	const config: WorkflowRuntimeConfig = {
		maxDepth: 1,
		defaultConcurrency: 4,
		persistRuns: false,
		statusFile: false,
		resumeInFlight: "ask",
	};

	async function definitionOf(name: string): Promise<WorkflowDefinition> {
		const module = (await import(fixtureEntry(name))) as {
			default: (factory: typeof workflow) => WorkflowDefinition;
		};
		return module.default(workflow);
	}

	test("the scan follows the configured nesting depth", async () => {
		setDurableBackend(await createMemoryTestBackend());
		const definition = await definitionOf("dynamic-children");
		const { port, requests } = answeringPort(() => 0);
		await dispatch(
			{ action: "run", workflow: definition.normalizedName },
			{
				registry: createRegistry([definition]),
				store: createStore(),
				adapters: { prompt: { prompt: async () => "ok" } },
				resolvePossibleStageEntry: () => fixtureEntry("dynamic-children"),
				config,
				decisions: port,
				stagePredictor: new StagePredictor(),
			},
		);
		await until(() => requests.length === 1);
		const question = requests[0]!.questions.site0;
		assert.equal(question?.type, "choice");
		assert.deepEqual(Object.values(question?.criteria ?? {}), [
			"child workflow workflow:child-alpha",
			"child workflow workflow:child-beta",
			"none of these candidates",
		]);
	});

	test("without a scan nothing is asked, and the injected predictor owns the launched root", async () => {
		setDurableBackend(await createMemoryTestBackend());
		const definition = await definitionOf("helper-names");
		const { port, requests } = answeringPort(
			() => 0,
			() => 0.5,
		);
		const unscanned = await dispatch(
			{ action: "run", workflow: definition.normalizedName },
			{
				registry: createRegistry([definition]),
				store: createStore(),
				adapters: { prompt: { prompt: async () => "ok" } },
				decisions: port,
				stagePredictor: new StagePredictor(),
			},
		);
		assert.equal(unscanned.action === "run" && unscanned.status !== "failed", true);
		await sleep(10);
		assert.equal(requests.length, 0);

		const predictor = new StagePredictor();
		const store = createStore();
		const result = await dispatch(
			{ action: "run", workflow: definition.normalizedName },
			{
				registry: createRegistry([definition]),
				store,
				adapters: { prompt: { prompt: async () => "ok" } },
				resolvePossibleStageEntry: () => fixtureEntry("helper-names"),
				decisions: port,
				stagePredictor: predictor,
			},
		);
		if (result.action !== "run") assert.fail("expected a run result");
		await until(() => requests.length === 1);
		predictor.classifySend(store.run(result.runId)!, ["deploy"]);
		await until(() => requests.length === 2);
		assert.equal(requests[1]?.state.target, "deploy");
	});
});

describe("prediction errors at their edges (#4359)", () => {
	test("the family base is a non-retryable typed error of its own", () => {
		const base = new PossibleStagePredictionError("decision-failed", "target", "message", "hint");
		assert.equal(base.name, "PossibleStagePredictionError");
		assert.equal(base.retryable, false);
		assert.equal(base.phase, "target");
		assert.ok(isPossibleStagePredictionError(base));
		assert.equal(isStageDecisionFailedError(base), false);
	});

	test("each concrete error renders its message and hint", () => {
		const failed = new StageDecisionFailedError("scan", new Error("x"));
		assert.equal(
			failed.message,
			"Stage-name prediction failed in the decision model (decision-failed). Check the decision model's provider status; the static scan still applies.",
		);
		assert.equal(failed.hint, "Check the decision model's provider status; the static scan still applies.");
		const timeout = new StageDecisionTimeoutError("target", 100, 120);
		assert.equal(
			timeout.message,
			"Stage-name prediction timed out after 120 ms of 100 ms (decision-timeout). The decision model was slow; a later run of the same workflow asks again.",
		);
		const answer = new StageDecisionAnswerError("scan", "site0", "missing");
		assert.equal(
			answer.message,
			"Stage-name prediction refused the answer to site0: missing (invalid-answer). The answer was discarded; the static scan still applies.",
		);
		assert.equal(answer.hint, "The answer was discarded; the static scan still applies.");
	});

	test("every family name is recognized by name and code, and each concrete guard by its own name", () => {
		for (const name of [
			"PossibleStagePredictionError",
			"StageDecisionUnavailableError",
			"StageDecisionFailedError",
			"StageDecisionTimeoutError",
			"StageDecisionAnswerError",
		]) {
			assert.ok(isPossibleStagePredictionError({ name, code: "x" }), name);
		}
		assert.ok(
			isStageDecisionUnavailableError({ name: "StageDecisionUnavailableError", code: "decision-unavailable" }),
		);
		assert.ok(isStageDecisionFailedError({ name: "StageDecisionFailedError", code: "decision-failed" }));
		assert.ok(isStageDecisionAnswerError({ name: "StageDecisionAnswerError", code: "invalid-answer" }));
		assert.equal(isStageDecisionAnswerError({ name: "StageDecisionFailedError", code: "decision-failed" }), false);
		assert.equal(isPossibleStagePredictionError(undefined), false);
		assert.equal(isStageDecisionTimeoutError(undefined), false);
	});

	test("the cause finder stops at a primitive cause", () => {
		assert.equal(findPossibleStagePredictionError(new Error("outer", { cause: "text" })), undefined);
		assert.equal(findPossibleStagePredictionError(new Error("outer", { cause: null })), undefined);
	});
});

describe("the session that launches runs owns their predictions (#4359)", () => {
	function sessionState(store: ReturnType<typeof createStore>) {
		const handlers = new Map<string, (() => unknown)[]>();
		const pi = {
			on(event: string, handler: () => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;
		const state = createWorkflowExtensionRuntimeState(pi, {} as never, {
			runState: { ...currentWorkflowSessionRunState(), store },
		});
		const shutdown = async () => {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler();
		};
		return { state, shutdown };
	}

	test("session shutdown aborts the open decision and records nothing; the next session predicts", async () => {
		const store = storeWith();
		const first = sessionState(store);
		const { port, pending } = deferredPort();
		launch(first.state.stagePredictor, store, port, scanOf([uncertainty([["review"]])]));
		await until(() => pending.length === 1);
		assert.equal(pending[0]!.request.signal.aborted, false);
		await first.shutdown();
		assert.equal(pending[0]!.request.signal.aborted, true);
		pending[0]!.resolve({ answers: { site0: { type: "choice", probabilities: { c0: 0.95 } } } });
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);

		const next = sessionState(store);
		assert.notEqual(next.state.stagePredictor, first.state.stagePredictor);
		launch(next.state.stagePredictor, store, answeringPort(() => 0.95).port, scanOf([uncertainty([["review"]])]));
		await until(() => store.run("root")?.stagePredictions !== undefined);
		assert.deepEqual(
			store.run("root")?.stagePredictions?.entries.map((entry) => entry.path),
			["review"],
		);
		await next.shutdown();
	});

	test("answers and failures that arrive after the run ended are dropped quietly", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const store = storeWith();
		const predictor = new StagePredictor();
		const { port, pending } = deferredPort();
		launch(predictor, store, port, scanOf([uncertainty([["review"]])]));
		await until(() => pending.length === 1);
		predictor.classifySend(store.run("root")!, ["deploy"]);
		predictor.classifySend(store.run("root")!, ["lint"]);
		await until(() => pending.length === 3);
		store.recordRunEnd("root", "completed");
		pending[0]!.resolve({ answers: { site0: { type: "choice", probabilities: { c0: 0.95 } } } });
		pending[1]!.reject(new Error("provider down"));
		pending[2]!.resolve({ answers: { target: { type: "bool", probability: 0.95 } } });
		await sleep(10);
		assert.equal(store.run("root")?.stagePredictions, undefined);
		assert.equal(warn.mock.calls.length, 0);
		predictor.dispose();
	});

	test("dispatch without a predictor launches the run and asks nothing", async () => {
		setDurableBackend(await createMemoryTestBackend());
		const module = (await import(fixtureEntry("helper-names"))) as {
			default: (factory: typeof workflow) => WorkflowDefinition;
		};
		const definition = module.default(workflow);
		const { port, requests } = answeringPort(() => 0.95);
		const store = createStore();
		const result = await dispatch(
			{ action: "run", workflow: definition.normalizedName },
			{
				registry: createRegistry([definition]),
				store,
				adapters: { prompt: { prompt: async () => "ok" } },
				resolvePossibleStageEntry: () => fixtureEntry("helper-names"),
				decisions: port,
			},
		);
		if (result.action !== "run") assert.fail("expected a run result");
		assert.notEqual(result.status, "failed");
		await sleep(10);
		assert.equal(requests.length, 0);
		assert.equal(store.run(result.runId)?.stagePredictions, undefined);
	});

	test("a session runtime launches predictions into the predictor it was given", async () => {
		const store = createStore();
		bindStoreDurableBackend(store, await createMemoryTestBackend());
		const module = (await import(fixtureEntry("helper-names"))) as {
			default: (factory: typeof workflow) => WorkflowDefinition;
		};
		const definition = module.default(workflow);
		const predictor = new StagePredictor();
		const requests: WorkflowDecisionRequest[] = [];
		const runtime = createExtensionRuntime({
			registry: createRegistry([definition]),
			store,
			adapters: { prompt: { prompt: async () => "ok" } },
			resolvePossibleStageEntry: () => fixtureEntry("helper-names"),
			stagePredictor: predictor,
			models: {
				listModels: async () => [],
				decide: (async (request: WorkflowDecisionRequest) => {
					requests.push(request);
					return {
						answers: {
							site0: { type: "choice", choice: "c1", probabilities: { c1: 0.9 } },
							site1: { type: "choice", choice: "c1", probabilities: { c1: 0.9 } },
						},
						source: "classifier",
						model: "typesafe/jev-latest",
						responseModel: "jev",
						usage: { inputTokens: 1, outputTokens: 1 },
					} as DecisionResult<DecisionQuestions>;
				}) as WorkflowModelCatalogPort["decide"],
			},
		});
		const result = await runtime.dispatch({ action: "run", workflow: definition.normalizedName });
		if (result.action !== "run") assert.fail("expected a run result");
		await until(() => store.run(result.runId)?.stagePredictions !== undefined);
		assert.equal(requests.length, 1);
		assert.deepEqual(predictor.classifySend(store.run(result.runId)!, ["review-1"]), { prediction: "predicted" });
		predictor.dispose();
	});

	test("the target question allows names built at run time; the scan question keeps each site's candidates closed", async () => {
		const store = storeWith();
		const predictor = new StagePredictor();
		const { port, requests } = answeringPort(() => 0.95);
		launch(predictor, store, port, scanOf([uncertainty([["review"]])]));
		await until(() => store.run("root")?.stagePredictions !== undefined);
		predictor.classifySend(store.run("root")!, ["deploy"]);
		await until(() => requests.length === 2);
		assert.match(requests[0]!.instructions, /its listed candidates are the only names that call site can produce/);
		assert.match(requests[1]!.instructions, /Names built at run time can produce paths that appear nowhere/);
		assert.doesNotMatch(requests[1]!.instructions, /only names/);
		predictor.dispose();
	});
});
