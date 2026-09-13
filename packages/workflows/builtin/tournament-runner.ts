import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { WorkflowInputValues, WorkflowRunContext, WorkflowSerializableObject, WorkflowSerializableValue, WorkflowTaskResult, WorkflowTaskStep } from "../src/shared/types.js";
import { accumulate, plan_comparisons, rank_candidates, select_pivots, soft_win, type Preference, type ScoringJob } from "./selection-math.js";
import { build_scoring_prompt, scoring_prompt_reads, warm_first_fan_out, type ScoringCandidate, type SharedHead } from "./verification-prompts.js";
import { normalize_criteria, parse_rubric, VERIFICATION_SCALE, type Criterion, type CriterionInput } from "./verification-criteria.js";
import { DEFAULT_TOURNAMENT_CRITERIA, renderComparisonsReducerPrompt, renderTournamentAttemptPrompt } from "./tournament-prompts.js";
import { stableArtifactRoot } from "./pattern-artifact-root.js";
import { fold_usage, type UsageTotals } from "./verification-usage.js";

const judgeScoreSchema = Type.Object({
	criterion_id: Type.String(),
	score_a: Type.Integer({ minimum: VERIFICATION_SCALE.min, maximum: VERIFICATION_SCALE.max }),
	score_b: Type.Integer({ minimum: VERIFICATION_SCALE.min, maximum: VERIFICATION_SCALE.max }),
	evidence: Type.Array(Type.String()),
}, { additionalProperties: false });

const JUDGE_GROUND_TRUTH_NOTE = "No external ground truth is supplied; score each presented solution against the task and criterion.";
const JUDGE_OUTPUT_FORMAT =
	"Return only JSON with criterion_id (string), score_a (integer 1–20 for presented slot 1), score_b (integer 1–20 for presented slot 2), and evidence (array of strings).";

type TournamentCriteriaInput = string | Record<string, string> | readonly string[] | readonly CriterionInput[];
type TournamentInputs = WorkflowInputValues & { readonly prompt: string; readonly num_attempts: number; readonly max_concurrency: number; readonly n_evaluations: number; readonly pivots: number; readonly seed: number; readonly criteria?: TournamentCriteriaInput; readonly models?: readonly string[] };

type Entrant = { readonly label: string; readonly path: string; readonly body: string };
type JudgeReport = { readonly criterion_id: string; readonly score_a: number; readonly score_b: number; readonly evidence: readonly string[] };
type ComparisonRecord = { a: number; b: number; phase: "ring" | "pivot"; criterion_id: string; rep: number; swapped: boolean; score_a?: number; score_b?: number; p_ab?: number; invalid?: true; judge_artifact_path: string };
type ScoredComparisonRecord = ComparisonRecord & { score_a: number; score_b: number };
type PairRecord = { a: number; b: number; phase: "ring" | "pivot"; valid_reports: number; mean_score_a?: number; mean_score_b?: number; p_ab: number; invalid?: true };
type JudgeStage = { readonly job: ScoringJob; readonly name: string; readonly path: string; readonly slot1: number; readonly slot2: number; readonly step: WorkflowTaskStep };

function serializableObject(
	value: WorkflowSerializableValue | undefined,
): WorkflowSerializableObject | undefined {
	if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
	return value as WorkflowSerializableObject;
}

function stringArray(value: WorkflowSerializableValue | undefined): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function judgeReport(value: WorkflowSerializableValue | undefined): JudgeReport | undefined {
	const object = serializableObject(value);
	if (object === undefined) return undefined;
	const criterionId = object.criterion_id;
	const scoreA = object.score_a;
	const scoreB = object.score_b;
	const evidence = object.evidence;
	if (
		typeof criterionId !== "string" ||
		typeof scoreA !== "number" ||
		!Number.isInteger(scoreA) ||
		scoreA < VERIFICATION_SCALE.min ||
		scoreA > VERIFICATION_SCALE.max ||
		typeof scoreB !== "number" ||
		!Number.isInteger(scoreB) ||
		scoreB < VERIFICATION_SCALE.min ||
		scoreB > VERIFICATION_SCALE.max ||
		!stringArray(evidence)
	) return undefined;
	return { criterion_id: criterionId, score_a: scoreA, score_b: scoreB, evidence };
}

function resultFor(
	results: readonly WorkflowTaskResult[],
	stageName: string,
): WorkflowTaskResult | undefined {
	return results.find((result) => result.stageName === stageName || result.name === stageName);
}

function scoredComparison(record: ComparisonRecord): record is ScoredComparisonRecord {
	return typeof record.score_a === "number" && typeof record.score_b === "number" && record.invalid !== true;
}

function stageName(job: ScoringJob): string {
	return `judge-${job.a}-${job.b}-${job.criterionId}-r${job.rep}`;
}

function criterionSlug(id: string): string {
	const slug = id
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 40)
		.replace(/_+$/g, "");
	return slug || "criterion";
}

function judgeArtifactPath(judgesDir: string, job: ScoringJob, criterionIndex: number): string {
	const filename = `judge-${job.a}-${job.b}-c${criterionIndex}-${criterionSlug(job.criterionId)}-r${job.rep}.json`;
	const root = resolve(judgesDir);
	const path = resolve(judgesDir, filename);
	const fromRoot = relative(root, path);
	if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
		throw new Error(`tournament: judge artifact escaped its directory: ${path}`);
	}
	return path;
}

function tournamentCriteria(input: TournamentCriteriaInput | undefined): readonly Criterion[] {
	if (input === undefined) return normalize_criteria(DEFAULT_TOURNAMENT_CRITERIA);
	if (typeof input === "string") return parse_rubric(input).criteria;
	return normalize_criteria(input);
}

function modelAssignment(
	entrants: readonly Entrant[],
	models: readonly string[] | undefined,
): Record<string, string> | undefined {
	if (models === undefined) return undefined;
	const assignment: Record<string, string> = {};
	if (models.length === 0) return assignment;
	for (const [index, entrant] of entrants.entries()) assignment[entrant.label] = models[index % models.length]!;
	return assignment;
}

function combineUsage(totals: readonly UsageTotals[]): UsageTotals {
	const combined = {
		calls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
	for (const total of totals) {
		combined.calls += total.calls;
		combined.input += total.input;
		combined.output += total.output;
		combined.cacheRead += total.cacheRead;
		combined.cacheWrite += total.cacheWrite;
		combined.cost += total.cost;
		combined.turns += total.turns;
	}
	const cacheDenominator = combined.input + combined.cacheRead;
	return {
		...combined,
		cacheHitRate: cacheDenominator === 0 ? 0 : combined.cacheRead / cacheDenominator,
	};
}

export async function runTournament(ctx: WorkflowRunContext<TournamentInputs>) {
	const artifactDir = await stableArtifactRoot(ctx, "tournament");
	const attemptsDir = join(artifactDir, "attempts");
	const numAttempts = ctx.inputs.num_attempts ?? 4;
	const maxConcurrency = ctx.inputs.max_concurrency ?? 4;
	const nEvaluations = ctx.inputs.n_evaluations ?? 2;
	const pivotCount = ctx.inputs.pivots ?? 1;
	const seed = ctx.inputs.seed ?? 0;
	const judgesDir = join(artifactDir, "judges");
	await mkdir(attemptsDir, { recursive: true });
	await mkdir(judgesDir, { recursive: true });

	const attemptArtifactPaths = Array.from({ length: numAttempts }, (_, index) =>
		join(attemptsDir, `attempt-${index + 1}.md`));
	const models = ctx.inputs.models;
	const attemptResults = await ctx.parallel(
		attemptArtifactPaths.map((path, index) => ({
			name: `attempt-${index + 1}`,
			prompt: renderTournamentAttemptPrompt(ctx.inputs.prompt, index + 1),
			context: "fresh" as const,
			output: path,
			outputMode: "file-only" as const,
			...(models !== undefined && models.length > 0 ? { model: models[index % models.length] } : {}),
		})),
		{ concurrency: maxConcurrency, failFast: true },
	);

	const entrants: Entrant[] = await Promise.all(attemptArtifactPaths.map(async (path, index) => ({
		label: `attempt-${index + 1}`,
		path,
		body: await readFile(path, "utf8"),
	})));
	const criteria = tournamentCriteria(ctx.inputs.criteria);
	const criterionIds = criteria.map((criterion) => criterion.id);
	const plan = plan_comparisons({
		n: entrants.length,
		pivots: pivotCount,
		repeats: nEvaluations,
		seed,
	});
	const weights = Array.from({ length: entrants.length }, () => 0);
	const counts = Array.from({ length: entrants.length }, () => 0);
	const comparisons: ComparisonRecord[] = [];
	const pairs: PairRecord[] = [];
	const judgeArtifactPaths: string[] = [];
	let executed = 0;

	const runPhase = async (
		phase: "ring" | "pivot",
		jobs: readonly ScoringJob[],
	): Promise<{ readonly preferences: readonly Preference[]; readonly results: readonly WorkflowTaskResult[] }> => {
		const stages: JudgeStage[] = jobs.map((job) => {
			const slot1 = job.swapped ? job.b : job.a;
			const slot2 = job.swapped ? job.a : job.b;
			const first = entrants[slot1]!;
			const second = entrants[slot2]!;
			const head: SharedHead = {
				task: ctx.inputs.prompt,
				groundTruthNote: JUDGE_GROUND_TRUTH_NOTE,
				candidates: [
					{ path: first.path, body: first.body },
					{ path: second.path, body: second.body },
				] satisfies readonly ScoringCandidate[],
				scaleAnchors: VERIFICATION_SCALE.anchors,
				outputFormat: JUDGE_OUTPUT_FORMAT,
			};
			const name = stageName(job);
			const criterionIndex = criterionIds.indexOf(job.criterionId);
			const path = judgeArtifactPath(judgesDir, job, criterionIndex);
			judgeArtifactPaths.push(path);
			return {
				job,
				name,
				path,
				slot1,
				slot2,
				step: {
					name,
					prompt: build_scoring_prompt(head, criteria.find((criterion) => criterion.id === job.criterionId)!),
					context: "fresh" as const,
					reads: scoring_prompt_reads(head),
					schema: judgeScoreSchema,
				},
			};
		});
		if (stages.length === 0) return { preferences: [], results: [] };
		executed += stages.length;
		const results = await warm_first_fan_out(
			ctx,
			stages.map((stage) => stage.step),
			(_step, index) => `${stages[index]!.slot1}:${stages[index]!.slot2}`,
			{ concurrency: maxConcurrency, failFast: false, possibleStageNames: ["judge-*-*-*-r*"] },
		);
		const phaseResults = [...results];
		for (const stage of stages) {
			let report = judgeReport(resultFor(results, stage.name)?.structured);
			if (report === undefined) {
				executed += 1;
				const retried = await ctx.task(`${stage.name}-reask`, {
					prompt: `${stage.step.prompt}\nThe previous report was invalid. Return the required JSON schema exactly once.`,
					context: "fresh",
					reads: stage.step.reads,
					schema: judgeScoreSchema,
				});
				phaseResults.push(retried);
				report = judgeReport(retried.structured);
			}
			if (report === undefined) {
				await writeFile(stage.path, `${JSON.stringify({ invalid: true }, null, 2)}\n`);
				comparisons.push({
					a: stage.job.a,
					b: stage.job.b,
					phase,
					criterion_id: stage.job.criterionId,
					rep: stage.job.rep,
					swapped: stage.job.swapped,
					invalid: true,
					judge_artifact_path: stage.path,
				});
				continue;
			}
			await writeFile(stage.path, `${JSON.stringify(report, null, 2)}\n`);
			const scoreA = stage.job.swapped ? report.score_b : report.score_a;
			const scoreB = stage.job.swapped ? report.score_a : report.score_b;
			comparisons.push({
				a: stage.job.a,
				b: stage.job.b,
				phase,
				criterion_id: stage.job.criterionId,
				rep: stage.job.rep,
				swapped: stage.job.swapped,
				score_a: scoreA,
				score_b: scoreB,
				p_ab: soft_win(scoreA, scoreB),
				judge_artifact_path: stage.path,
			});
		}

		const phaseRecords = comparisons.filter((record) => record.phase === phase);
		const grouped = new Map<string, ComparisonRecord[]>();
		for (const record of phaseRecords) {
			const key = `${record.a}:${record.b}`;
			const group = grouped.get(key);
			if (group === undefined) grouped.set(key, [record]);
			else group.push(record);
		}
		const preferences: Preference[] = [];
		for (const records of grouped.values()) {
			const first = records[0]!;
			const valid = records.filter(scoredComparison);
			if (valid.length === 0) {
				pairs.push({ a: first.a, b: first.b, phase, valid_reports: 0, p_ab: 0.5, invalid: true });
				preferences.push({ a: first.a, b: first.b, p: 0.5 });
				continue;
			}
			const meanScoreA = valid.reduce((sum, record) => sum + record.score_a, 0) / valid.length;
			const meanScoreB = valid.reduce((sum, record) => sum + record.score_b, 0) / valid.length;
			const p = soft_win(meanScoreA, meanScoreB);
			pairs.push({
				a: first.a,
				b: first.b,
				phase,
				valid_reports: valid.length,
				mean_score_a: meanScoreA,
				mean_score_b: meanScoreB,
				p_ab: p,
			});
			preferences.push({ a: first.a, b: first.b, p });
		}
		return { preferences, results: phaseResults };
	};

	const ringJobs = plan.jobs(plan.ring, criterionIds);
	const ringPhase = await runPhase("ring", ringJobs);
	accumulate(ringPhase.preferences, weights, counts);
	const pivotIndices = select_pivots(weights, counts, pivotCount);
	const pivotJobs = plan.jobs(plan.pivotRounds(pivotIndices), criterionIds);
	const pivotPhase = await runPhase("pivot", pivotJobs);
	accumulate(pivotPhase.preferences, weights, counts);
	const ranking = rank_candidates(weights, counts).map((entry) => ({
		label: entrants[entry.index]!.label,
		index: entry.index,
		meanPreference: entry.meanPreference,
	}));
	const outputRanking = ranking.map(({ label, meanPreference }) => ({ label, meanPreference }));
	const budgetPivots = Math.min(pivotCount, entrants.length);
	// Planned units are judge jobs: scheduled directed pairs × criteria × evaluations.
	const comparisonBudget =
		(entrants.length + budgetPivots * (entrants.length - budgetPivots) + (budgetPivots * (budgetPivots - 1)) / 2) *
		criteria.length * nEvaluations;
	const comparisonPath = join(artifactDir, "comparisons.json");
	const assignment = modelAssignment(entrants, models);
	const phaseUsage = {
		attempts: fold_usage(attemptResults),
		ring: fold_usage(ringPhase.results),
		pivots: fold_usage(pivotPhase.results),
	};
	const baseLedger = {
		task: ctx.inputs.prompt,
		seed,
		params: {
			n: entrants.length,
			pivots: pivotCount,
			n_evaluations: nEvaluations,
			criteria,
		},
		comparisons,
		pairs,
		w: weights,
		c: counts,
		ranking,
		// Budget units are judge stages: planned jobs versus dispatched jobs, including re-asks in executed.
		budget: { planned: comparisonBudget, executed },
		...(assignment === undefined ? {} : { model_assignment: assignment }),
	};
	const writeLedger = async (reducerUsage: UsageTotals): Promise<void> => {
		const usage = {
			...phaseUsage,
			reducer: reducerUsage,
			total: combineUsage([phaseUsage.attempts, phaseUsage.ring, phaseUsage.pivots, reducerUsage]),
		};
		await writeFile(comparisonPath, `${JSON.stringify({ ...baseLedger, usage }, null, 2)}\n`);
	};
	await writeLedger(fold_usage([]));

	const winner = ranking[0]!;
	const winnerEntrant = entrants[winner.index]!;
	const resultPath = join(artifactDir, "winner.md");
	const reducer = await ctx.task("comparisons-reducer", {
		prompt: renderComparisonsReducerPrompt({
			task: ctx.inputs.prompt,
			comparisonsPath: comparisonPath,
			ranking: outputRanking,
			winnerLabel: winner.label,
			winnerPath: winnerEntrant.path,
		}),
		context: "fresh",
		reads: [comparisonPath, winnerEntrant.path, ...judgeArtifactPaths],
		output: resultPath,
		outputMode: "file-only",
	});
	await writeLedger(fold_usage([reducer]));

	return {
		result: reducer.text,
		winner: winner.label,
		winner_artifact_path: winnerEntrant.path,
		result_path: resultPath,
		attempt_artifact_paths: attemptArtifactPaths,
		judge_artifact_paths: judgeArtifactPaths,
		comparisons_path: comparisonPath,
		ranking: outputRanking,
		seed,
		artifact_dir: artifactDir,
	};
}
