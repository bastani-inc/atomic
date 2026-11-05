import {
	type DecisionQuestions,
	findDecisionError,
	isDecisionModelUnavailableError,
	isDecisionTimeoutError,
	type JsonObject,
} from "@bastani/atomic";
import {
	closestStagePath,
	decodeScanAnswers,
	decodeTargetAnswer,
	type ScanPredictions,
	scanDecisionState,
	scanQuestionPlan,
	stagePathsOverlap,
	stagePredictionDefinitionHash,
	TARGET_QUESTION_KEY,
	targetQuestion,
} from "./possible-stage-prediction.js";
import {
	isPossibleStagePredictionError,
	POSSIBLE_STAGE_PREDICTION_THRESHOLDS,
	type PossibleStagePredictionError,
	type PossibleStagePredictionPhase,
	type StageDecisionAnswer,
	StageDecisionFailedError,
	type StageDecisionPort,
	type StageDecisionQuestion,
	type StageDecisionResult,
	StageDecisionTimeoutError,
	StageDecisionUnavailableError,
} from "./possible-stage-prediction-errors.js";
import type { PossibleStagesScanResult } from "./possible-stages.js";
import type { Store } from "./store.js";
import { isTerminalRunStatus } from "./store-internal.js";
import type { RunSnapshot, RunStagePredictions } from "./store-types.js";
import type { WorkflowModelCatalogPort, WorkflowSerializableObject } from "./types.js";

/** How long one decision may take before it falls back with a typed timeout. */
const DEFAULT_DEADLINE_MS = 60_000;
const MAX_DEFINITIONS = 128;
const MAX_TARGETS_PER_DEFINITION = 256;
const MAX_ROOTS = 512;
const MAX_STATE_STAGES = 64;
const SCAN_INSTRUCTIONS =
	"A workflow's static scan could not read some of its stage names. `uncertainCallSites` holds the source around each call site a question asks about, `otherUnreadCallSites` the source of call sites with no candidates, `knownStages` the names the scan did read, and `inputsShape` the type of each run input. Judge only from this source; for each question, its listed candidates are the only names that call site can produce.";
const TARGET_INSTRUCTIONS =
	"A message was sent to a stage path this workflow run has not started. `uncertainCallSites` and `otherUnreadCallSites` hold the source of call sites whose stage names the static scan could not read, `knownStages` the names it did read, `startedStages` and `predictedStages` what the run started and is expected to start, and `inputsShape` the type of each run input. Names built at run time can produce paths that appear nowhere in this source.";

/** How a send outside the static known set relates to the decision model's predictions. */
export interface StageSendClassification {
	readonly prediction: "predicted" | "unknown";
	/** The model's yes-probability was at or below the `unlikely` threshold. */
	readonly unexpected?: true;
	/** The single closest known stage path, when one is close enough. */
	readonly suggestion?: string;
}

export interface StagePredictionLaunch {
	readonly store: Store;
	readonly runId: string;
	readonly workflowName: string;
	readonly scan: PossibleStagesScanResult;
	readonly maxDepth: number | undefined;
	readonly inputs: WorkflowSerializableObject;
	readonly decisions: StageDecisionPort;
	/** Settles with whether startup admission succeeded; predictions are recorded only on an admitted run. */
	readonly admitted: Promise<boolean>;
}

interface DefinitionAnswers {
	scan?: Promise<ScanPredictions>;
	readonly targets: Map<string, Promise<number>>;
	readonly settledTargets: Map<string, number>;
}

interface RootContext {
	readonly store: Store;
	readonly definitionHash: string;
	readonly decisions: StageDecisionPort;
	readonly state: WorkflowSerializableObject;
	readonly knownPaths: readonly string[];
}

export interface StagePredictorOptions {
	readonly deadlineMs?: number;
}

/**
 * Asks the decision model, off the critical path, which stage names an uncertain workflow will produce and whether a
 * send outside the known set is expected. Answers are cached per definition hash; nothing here is ever awaited by
 * launch or delivery, and every failure falls back to the static known set with one typed reason on the root run.
 */
export class StagePredictor {
	private readonly deadlineMs: number;
	private readonly definitions = new Map<string, DefinitionAnswers>();
	private readonly roots = new Map<string, RootContext>();
	private readonly disposed = new AbortController();

	constructor(options: StagePredictorOptions = {}) {
		this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	}

	/** Start predicting for a freshly launched root run. Returns at once; the work never blocks the caller. */
	launch(input: StagePredictionLaunch): void {
		const definitionHash = stagePredictionDefinitionHash(input.scan, input.maxDepth, input.inputs);
		const state = scanDecisionState(input.workflowName, input.scan, input.inputs);
		this.remember(input.runId, {
			store: input.store,
			definitionHash,
			decisions: input.decisions,
			state,
			knownPaths: input.scan.stages,
		});
		const plan = scanQuestionPlan(input.scan);
		if (plan.options.size === 0) return;
		const answers = this.definition(definitionHash);
		let pending = answers.scan;
		if (pending === undefined) {
			const asked = this.ask("scan", input.decisions, state, plan.questions, SCAN_INSTRUCTIONS).then((result) =>
				decodeScanAnswers(plan, result),
			);
			answers.scan = asked;
			pending = asked;
			asked.then(undefined, () => {
				answers.scan = undefined;
			});
		}
		const recorded = pending.then(
			async (entries) => {
				if (await input.admitted) this.mergeEntries(input.store, input.runId, entries);
			},
			async (error: unknown) => {
				if (await input.admitted) this.recordFallback(input.store, input.runId, "scan", error);
			},
		);
		recorded.catch(reportUnrecorded);
	}

	/**
	 * Classify a send the static known set does not cover, from answers already in hand; never waits. An unjudged
	 * target is asked in the background, so a later send (or a later run of the same definition) sees the answer.
	 */
	classifySend(rootRun: RunSnapshot, targetSegments: readonly string[]): StageSendClassification {
		const predicted = rootRun.stagePredictions?.entries ?? [];
		if (predicted.some((entry) => stagePathsOverlap(targetSegments, entry.path))) return { prediction: "predicted" };
		const context = this.roots.get(rootRun.id);
		if (context === undefined) return { prediction: "unknown" };
		const path = targetSegments.join("/");
		const answers = this.definition(context.definitionHash);
		const probability = answers.settledTargets.get(path);
		if (probability === undefined) {
			this.askTarget(context, answers, rootRun, path);
			return { prediction: "unknown" };
		}
		this.recordTarget(context.store, rootRun.id, path, probability);
		if (probability >= POSSIBLE_STAGE_PREDICTION_THRESHOLDS.known) return { prediction: "predicted" };
		if (probability > POSSIBLE_STAGE_PREDICTION_THRESHOLDS.unlikely) return { prediction: "unknown" };
		const suggestion = closestStagePath(path, [
			...context.knownPaths,
			...predicted.map((entry) => entry.path),
			...rootRun.stages.map((stage) => stage.name),
		]);
		return { prediction: "unknown", unexpected: true, ...(suggestion === undefined ? {} : { suggestion }) };
	}

	/** Abort every open decision; nothing is recorded for a cancelled one. The owning session calls it on shutdown. */
	dispose(): void {
		this.disposed.abort(new DOMException("Stage prediction was disposed", "AbortError"));
	}

	private askTarget(context: RootContext, answers: DefinitionAnswers, rootRun: RunSnapshot, path: string): void {
		if (answers.targets.has(path)) return;
		if (answers.targets.size >= MAX_TARGETS_PER_DEFINITION) return;
		const state: WorkflowSerializableObject = {
			...context.state,
			target: path,
			startedStages: rootRun.stages.slice(0, MAX_STATE_STAGES).map((stage) => stage.name),
			predictedStages: (rootRun.stagePredictions?.entries ?? []).map((entry) => entry.path),
		};
		const asked = this.ask(
			"target",
			context.decisions,
			state,
			{ [TARGET_QUESTION_KEY]: targetQuestion(path) },
			TARGET_INSTRUCTIONS,
		).then(decodeTargetAnswer);
		answers.targets.set(path, asked);
		const runId = rootRun.id;
		const recorded = asked.then(
			(probability) => {
				answers.settledTargets.set(path, probability);
				this.recordTarget(context.store, runId, path, probability);
			},
			(error: unknown) => {
				answers.targets.delete(path);
				this.recordFallback(context.store, runId, "target", error);
			},
		);
		recorded.catch(reportUnrecorded);
	}

	private async ask(
		phase: PossibleStagePredictionPhase,
		decisions: StageDecisionPort,
		state: WorkflowSerializableObject,
		questions: Readonly<Record<string, StageDecisionQuestion>>,
		instructions: string,
	): Promise<StageDecisionResult> {
		const deadline = new AbortController();
		const startedAt = Date.now();
		const timer = setTimeout(
			() => deadline.abort(new StageDecisionTimeoutError(phase, this.deadlineMs, Date.now() - startedAt)),
			this.deadlineMs,
		);
		timer.unref();
		const signal = AbortSignal.any([deadline.signal, this.disposed.signal]);
		try {
			const decided = decisions.decide({
				state,
				questions,
				instructions,
				deadline: this.deadlineMs,
				signal,
			});
			return await new Promise<StageDecisionResult>((resolve, reject) => {
				const onAbort = (): void => reject(signal.reason);
				if (signal.aborted) onAbort();
				signal.addEventListener("abort", onAbort);
				decided.then(resolve, reject);
			});
		} catch (error) {
			// A cancellation stays a cancellation; the deadline's own reason is already a typed timeout.
			if (this.disposed.signal.aborted) throw this.disposed.signal.reason;
			if (isPossibleStagePredictionError(error)) throw error;
			if (isDecisionModelUnavailableError(error)) throw new StageDecisionUnavailableError(phase, { cause: error });
			if (isDecisionTimeoutError(error)) {
				throw new StageDecisionTimeoutError(phase, error.timeoutMs, error.elapsedMs, { cause: error });
			}
			throw new StageDecisionFailedError(phase, error);
		} finally {
			clearTimeout(timer);
		}
	}

	private definition(definitionHash: string): DefinitionAnswers {
		let answers = this.definitions.get(definitionHash);
		if (answers === undefined) {
			answers = { targets: new Map(), settledTargets: new Map() };
			this.definitions.set(definitionHash, answers);
			if (this.definitions.size > MAX_DEFINITIONS) {
				this.definitions.delete(this.definitions.keys().next().value!);
			}
		}
		return answers;
	}

	private remember(runId: string, context: RootContext): void {
		this.roots.set(runId, context);
		if (this.roots.size > MAX_ROOTS) this.roots.delete(this.roots.keys().next().value!);
	}

	/** The run's predictions so far, or `undefined` once the run is gone or ended: an ended run records nothing more. */
	private current(store: Store, runId: string): RunStagePredictions | undefined {
		const run = store.run(runId);
		if (run === undefined || isTerminalRunStatus(run.status)) return undefined;
		return run.stagePredictions ?? { status: "ready", entries: [], targets: {} };
	}

	private mergeEntries(store: Store, runId: string, predictions: ScanPredictions): void {
		const current = this.current(store, runId);
		if (current === undefined) return;
		const merged = new Map(current.entries.map((entry) => [entry.path, entry]));
		for (const entry of predictions.entries) if (!merged.has(entry.path)) merged.set(entry.path, entry);
		store.recordRunStagePredictions?.(runId, {
			...current,
			entries: [...merged.values()],
			resolvedPlaceholders: [
				...new Set([...(current.resolvedPlaceholders ?? []), ...predictions.resolvedPlaceholders]),
			],
		});
	}

	private recordTarget(store: Store, runId: string, path: string, probability: number): void {
		const current = this.current(store, runId);
		if (current === undefined || current.targets[path] === probability) return;
		const expected = probability >= POSSIBLE_STAGE_PREDICTION_THRESHOLDS.known;
		store.recordRunStagePredictions?.(runId, {
			...current,
			targets: { ...current.targets, [path]: probability },
			entries:
				expected && !current.entries.some((entry) => entry.path === path)
					? [...current.entries, { path, probability, source: "send" }]
					: current.entries,
		});
	}

	private recordFallback(store: Store, runId: string, phase: PossibleStagePredictionPhase, error: unknown): void {
		if ((error as { readonly name?: unknown }).name === "AbortError") return;
		if (decisionModelGivesNoProbabilities(error)) return;
		const current = this.current(store, runId);
		if (current === undefined || current.fallback !== undefined) return;
		const failure: PossibleStagePredictionError = isPossibleStagePredictionError(error)
			? error
			: new StageDecisionFailedError(phase, error);
		const cause = failure.cause as { readonly name?: unknown; readonly code?: unknown } | undefined;
		store.recordRunStagePredictions?.(runId, {
			...current,
			status: "fallback",
			fallback: {
				name: failure.name,
				code: failure.code,
				hint: failure.hint,
				phase: failure.phase,
				retryable: failure.retryable,
				...(typeof cause?.name === "string"
					? { cause: { name: cause.name, ...(typeof cause.code === "string" ? { code: cause.code } : {}) } }
					: {}),
			},
		});
	}
}

/**
 * A chat decision model answers without probabilities, so it cannot predict stage names. That is a setup choice, not a
 * failure, so nothing is recorded, as readiness decisions do.
 */
function decisionModelGivesNoProbabilities(error: unknown): boolean {
	const decision = findDecisionError(error);
	return isDecisionModelUnavailableError(decision) && decision.reason === "no-probabilities";
}

/**
 * The host's decision service as a stage-prediction port. Every answer must carry probabilities, so a decision model
 * that cannot give them (a chat model) rejects with `DecisionModelUnavailableError` instead of spending a chat turn.
 * `undefined` when the host has no decision service.
 */
export function stageDecisionPortFromModels(
	models: WorkflowModelCatalogPort | undefined,
): StageDecisionPort | undefined {
	const decide = models?.decide?.bind(models);
	if (decide === undefined) return undefined;
	return {
		async decide(request) {
			const result = await decide({
				state: JSON.parse(JSON.stringify(request.state)) as JsonObject,
				questions: request.questions as DecisionQuestions,
				instructions: request.instructions,
				deadline: request.deadline,
				signal: request.signal,
				requireProbabilities: true,
			});
			const answers: Record<string, StageDecisionAnswer> = {};
			for (const [key, answer] of Object.entries(result.answers)) {
				if (answer.type === "choice") {
					answers[key] = {
						type: "choice",
						probabilities: answer.probabilities as Readonly<Record<string, number>>,
					};
				} else if (answer.type === "bool") {
					answers[key] = { type: "bool", probability: answer.probability as number };
				}
			}
			return { answers };
		},
	};
}

function reportUnrecorded(error: unknown): void {
	console.warn(
		`atomic-workflows: a stage prediction could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
	);
}
