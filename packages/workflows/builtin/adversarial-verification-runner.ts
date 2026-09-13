import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { WorkflowRunContext, WorkflowSerializableValue, WorkflowTaskResult } from "../src/shared/types.js";
import {
	renderConsolidatorPrompt,
	renderRepairPrompt,
	renderWorkerPrompt,
} from "./adversarial-verification-prompts.js";
import {
	build_scoring_prompt,
	scoring_prompt_reads,
	warm_first_fan_out,
	type ScoringCandidate,
	type SharedHead,
} from "./verification-prompts.js";
import { stableArtifactRoot } from "./pattern-artifact-root.js";
import { fold_usage } from "./verification-usage.js";
import {
	decide_verification,
	normalize_criteria,
	parse_rubric,
	VERIFICATION_SCALE,
	type Criterion,
	type Criteria,
	type CriterionScore,
	type VerificationDecision,
} from "./verification-criteria.js";

export const DEFAULT_CRITERIA = {
	task_fit: "The candidate satisfies the literal task.",
	evidence: "Important claims cite observable evidence, and file findings cite file:line where applicable.",
	completeness: "Relevant validation is executed and reported with commands run and observed output, and no blocking correctness, safety, or completeness gap remains.",
};

// V2 deliberately requires every fanned-out cell to return a schema-valid score
// after its bounded re-ask wave. A missing score is loudly Indeterminate rather
// than silently narrowing the mean, and quorum is not caller-configurable.
const QUORUM_FRACTION = 1;

const criterionScoreSchema = Type.Object({
	criterion_id: Type.String(),
	score: VERIFICATION_SCALE.schema,
	evidence: Type.Array(Type.String()),
	findings: Type.Array(Type.Object({
		finding: Type.String(),
		severity: Type.Union([Type.Literal("veto"), Type.Literal("blocking"), Type.Literal("note")]),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
const consolidatorSchema = Type.Object({
	repair_guidance: Type.String(),
	remaining_work: Type.Array(Type.String()),
}, { additionalProperties: false });

type CriterionScoreReport = {
	readonly criterion_id: string;
	readonly score: number;
	readonly evidence: readonly string[];
	readonly findings: readonly {
		readonly finding: string;
		readonly severity: "veto" | "blocking" | "note";
	}[];
};
type ConsolidatedReport = {
	readonly repair_guidance: string;
	readonly remaining_work: readonly string[];
};
type Inputs = {
	readonly task: string;
	readonly verifier_count: number;
	readonly max_repairs: number;
	readonly criteria?: string | Record<string, string>;
	readonly accept_mean?: number;
	readonly reask_limit?: number;
};
export type AdversarialVerificationResult = {
	readonly approved: boolean;
	readonly mean_score: number;
	readonly score_table_path: string;
	readonly repairs_completed: number;
	readonly candidate_path: string;
	readonly review_report_path: string;
	readonly remaining_work: string[];
};

type VerificationCell = {
	readonly criterion: Criterion;
	readonly verifierIndex: number;
	readonly name: string;
	readonly artifactPath: string;
};
type ValidResult = {
	readonly cell: VerificationCell;
	readonly report: CriterionScoreReport;
	readonly artifactPath: string;
};
type InvalidArtifact = {
	readonly invalid: true;
	readonly stage: string;
};

function isRecord(value: WorkflowSerializableValue): value is Record<string, WorkflowSerializableValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, WorkflowSerializableValue>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every((key) => key in value);
}

function isStringArray(value: WorkflowSerializableValue | undefined): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: WorkflowSerializableValue): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isCriterionFinding(value: WorkflowSerializableValue): boolean {
	return isRecord(value)
		&& hasOnlyKeys(value, ["finding", "severity"])
		&& typeof value.finding === "string"
		&& (value.severity === "veto" || value.severity === "blocking" || value.severity === "note");
}

function isCriterionScore(value: WorkflowSerializableValue | undefined, criterionId: string): value is CriterionScoreReport {
	return value !== undefined
		&& isRecord(value)
		&& hasOnlyKeys(value, ["criterion_id", "score", "evidence", "findings"])
		&& value.criterion_id === criterionId
		&& typeof value.score === "number"
		&& Number.isInteger(value.score)
		&& value.score >= VERIFICATION_SCALE.min
		&& value.score <= VERIFICATION_SCALE.max
		&& isStringArray(value.evidence)
		&& Array.isArray(value.findings)
		&& value.findings.every(isCriterionFinding);
}

function isConsolidatedReport(value: WorkflowSerializableValue | undefined): value is ConsolidatedReport {
	return value !== undefined
		&& isRecord(value)
		&& hasOnlyKeys(value, ["repair_guidance", "remaining_work"])
		&& typeof value.repair_guidance === "string"
		&& isStringArray(value.remaining_work);
}

function structured<T extends WorkflowSerializableValue>(
	value: WorkflowSerializableValue | undefined,
	guard: (candidate: WorkflowSerializableValue | undefined) => candidate is T,
): T | undefined {
	return guard(value) ? value : undefined;
}

function resolveCriteria(value: WorkflowSerializableValue | undefined): Criteria {
	if (value === undefined) {
		return { groundTruthNote: "", criteria: normalize_criteria(DEFAULT_CRITERIA) };
	}
	if (typeof value === "string") return parse_rubric(value);
	if (isStringRecord(value)) return { groundTruthNote: "", criteria: normalize_criteria(value) };
	throw new TypeError("criteria must be a criteria.md string or a record of criterion descriptions");
}

function renderCriteriaMarkdown(criteria: Criteria): string {
	const lines = ["# Verification criteria"];
	if (criteria.groundTruthNote.length > 0) lines.push("## Ground Truth Note", criteria.groundTruthNote);
	lines.push("## Criteria");
	for (const item of criteria.criteria) {
		lines.push(`### ${item.name} {#${item.id}}`, item.description);
	}
	return `${lines.join("\n\n")}\n`;
}

function meanScore(scores: readonly CriterionScoreReport[]): number {
	if (scores.length === 0) return 0;
	return scores.reduce((total, score) => total + score.score, 0) / scores.length;
}

function toCriterionScore(report: CriterionScoreReport): CriterionScore {
	return {
		criterionId: report.criterion_id,
		score: report.score,
		evidence: report.evidence,
		findings: report.findings,
	};
}

function findingText(decision: Extract<VerificationDecision, { kind: "repair" }>): string[] {
	return decision.findings.map((finding) => finding.finding);
}

function quorumEvidence(missing: number, invalidCount: number, expectedCount: number, reaskLimit: number): string {
	return `Quorum failure: ${missing} of ${expectedCount} criterion scores remain missing after ${reaskLimit} re-ask wave(s); ${invalidCount} report attempts were invalid or missing.`;
}

function stageName(cell: VerificationCell, reaskWave: number): string {
	return reaskWave === 0 ? cell.name : `${cell.name}-reask-${reaskWave}`;
}

function verifierOutputFormat(criterionId: string): string {
	return `Call structured_output with criterion_id (set to ${criterionId}), score (1–20), evidence (string array), and findings containing finding and severity (veto, blocking, or note).`;
}

function scoreStep(
	cell: VerificationCell,
	reaskWave: number,
	head: SharedHead,
	criteriaPath: string,
) {
	const promptHead: SharedHead = {
		...head,
		outputFormat: verifierOutputFormat(cell.criterion.id),
	};
	return {
		name: stageName(cell, reaskWave),
		prompt: build_scoring_prompt(promptHead, cell.criterion),
		context: "fresh" as const,
		reads: [criteriaPath, ...scoring_prompt_reads(promptHead)],
		schema: criterionScoreSchema,
	};
}

async function writeInvalid(path: string, stage: string): Promise<void> {
	const marker: InvalidArtifact = { invalid: true, stage };
	await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`);
}

export async function runAdversarialVerification(ctx: WorkflowRunContext<Inputs>): Promise<AdversarialVerificationResult> {
	const root = await stableArtifactRoot(ctx, "adversarial-verification");
	const criteriaPath = join(root, "criteria.md");
	const candidatePath = join(root, "candidate.md");
	const resolvedCriteria = resolveCriteria(ctx.inputs.criteria);
	await writeFile(criteriaPath, renderCriteriaMarkdown(resolvedCriteria));
	await ctx.task("worker", { prompt: renderWorkerPrompt(ctx.inputs.task), context: "fresh", output: candidatePath, outputMode: "file-only" });

	const verifierCount = ctx.inputs.verifier_count ?? 3;
	const maxRepairs = ctx.inputs.max_repairs ?? 2;
	const acceptMean = ctx.inputs.accept_mean ?? 14;
	const reaskLimit = Math.max(0, Math.floor(ctx.inputs.reask_limit ?? 1));
	const expectedCount = resolvedCriteria.criteria.length * verifierCount;
	let repairsCompleted = 0;
	let consecutiveIndeterminate = 0;
	let finalDecision: VerificationDecision;
	let finalMean = 0;
	let scoreTablePath: string;
	let reviewReportPath: string;
	let remainingWork: string[] = [];

	for (let round = 0; ; round += 1) {
		const candidateBody = await readFile(candidatePath, "utf8");
		const scoringHead: SharedHead = {
			task: ctx.inputs.task,
			groundTruthNote: resolvedCriteria.groundTruthNote,
			candidates: [{ path: candidatePath, body: candidateBody } satisfies ScoringCandidate],
			scaleAnchors: VERIFICATION_SCALE.anchors,
		};
		const cells: VerificationCell[] = [];
		for (const criterion of resolvedCriteria.criteria) {
			for (let index = 0; index < verifierCount; index += 1) {
				const name = `verifier-${round}-${criterion.id}-${index + 1}`;
				cells.push({
					criterion,
					verifierIndex: index + 1,
					name,
					artifactPath: join(root, `verification-${round}-${criterion.id}-${index + 1}.json`),
				});
			}
		}

		const runWave = async (
			pending: readonly VerificationCell[],
			reaskWave: number,
		): Promise<{ readonly valid: readonly ValidResult[]; readonly invalid: readonly VerificationCell[]; readonly results: readonly WorkflowTaskResult[] }> => {
			if (pending.length === 0) return { valid: [], invalid: [], results: [] };
			const reports = await warm_first_fan_out(
				ctx,
				pending.map((cell) => scoreStep(cell, reaskWave, scoringHead, criteriaPath)),
				() => scoringHead,
				{ concurrency: Math.min(pending.length, 4), failFast: false, possibleStageNames: ["verifier-*-*-*", "verifier-*-*-*-reask-*"] },
			);
			const byName = new Map<string, (typeof reports)[number]>();
			for (const report of reports) {
				const name = report.name ?? report.stageName;
				if (name !== undefined) byName.set(name, report);
			}
			const valid: ValidResult[] = [];
			const invalid: VerificationCell[] = [];
			for (const cell of pending) {
				const report = byName.get(stageName(cell, reaskWave));
				const artifactPath = reaskWave === 0
					? cell.artifactPath
					: cell.artifactPath.replace(/\.json$/, `-reask-${reaskWave}.json`);
				if (isCriterionScore(report?.structured, cell.criterion.id)) {
					await writeFile(artifactPath, `${JSON.stringify(report.structured, null, 2)}\n`);
					valid.push({ cell, report: report.structured, artifactPath });
				} else {
					await writeInvalid(artifactPath, stageName(cell, reaskWave));
					invalid.push(cell);
				}
			}
			return { valid, invalid, results: reports };
		};

		const roundResults: WorkflowTaskResult[] = [];
		let pending = [...cells];
		const validResults: ValidResult[] = [];
		let invalidCount = 0;
		for (let reaskWave = 0; reaskWave <= reaskLimit; reaskWave += 1) {
			const wave = await runWave(pending, reaskWave);
			roundResults.push(...wave.results);
			validResults.push(...wave.valid);
			invalidCount += wave.invalid.length;
			pending = [...wave.invalid];
			if (pending.length === 0) break;
		}

		const validReportsByCell = new Map(validResults.map((item) => [item.cell.name, item.report]));
		const scoreReports = cells.flatMap((cell) => {
			const report = validReportsByCell.get(cell.name);
			return report === undefined ? [] : [report];
		});
		const scores = scoreReports.map(toCriterionScore);
		const roundResult = { scores, invalidCount, expectedCount };
		const decision = decide_verification(roundResult, { acceptMean, quorumFraction: QUORUM_FRACTION });
		finalDecision = decision;
		finalMean = meanScore(scoreReports);
		scoreTablePath = join(root, `verification-summary-${round}.json`);
		reviewReportPath = join(root, `review-${round}.json`);
		const summary = {
			scores: scoreReports,
			mean: finalMean,
			invalidCount,
			decision,
			usage: fold_usage(roundResults),
		};

		if (decision.kind === "accept") {
			remainingWork = [];
			await writeFile(scoreTablePath, `${JSON.stringify(summary, null, 2)}\n`);
			await writeFile(reviewReportPath, `${JSON.stringify({ decision, remaining_work: [] }, null, 2)}\n`);
			break;
		}

		if (decision.kind === "indeterminate") {
			consecutiveIndeterminate += 1;
			remainingWork = [quorumEvidence(decision.missing, invalidCount, expectedCount, reaskLimit)];
			await writeFile(scoreTablePath, `${JSON.stringify(summary, null, 2)}\n`);
			await writeFile(reviewReportPath, `${JSON.stringify({ decision, evidence: remainingWork, remaining_work: remainingWork }, null, 2)}\n`);
			if (consecutiveIndeterminate >= 2) break;
			continue;
		}

		consecutiveIndeterminate = 0;
		const confirmedFindings = findingText(decision);
		const scorePaths = validResults.map((item) => item.artifactPath);
		const consolidated = await ctx.task(`consolidate-findings-${round}`, {
			prompt: renderConsolidatorPrompt(ctx.inputs.task, candidatePath, scorePaths, repairsCompleted, maxRepairs),
			context: "fresh",
			reads: [candidatePath, criteriaPath, ...scorePaths],
			schema: consolidatorSchema,
		});
		const fallbackRemaining = confirmedFindings.length > 0
			? confirmedFindings
			: [`Mean score ${decision.mean} is below the acceptance threshold ${acceptMean}.`];
		const consolidatedReport: ConsolidatedReport = structured(consolidated.structured, isConsolidatedReport)
			?? { repair_guidance: "Confirmed verifier findings require repair.", remaining_work: fallbackRemaining };
		remainingWork = fallbackRemaining;
		await writeFile(scoreTablePath, `${JSON.stringify(summary, null, 2)}\n`);
		await writeFile(reviewReportPath, `${JSON.stringify({ ...consolidatedReport, remaining_work: remainingWork }, null, 2)}\n`);

		if (repairsCompleted >= maxRepairs) break;
		repairsCompleted += 1;
		await ctx.task(`repair-${repairsCompleted}`, {
			prompt: renderRepairPrompt(ctx.inputs.task, candidatePath, reviewReportPath),
			context: "fresh",
			reads: [candidatePath, reviewReportPath],
			output: candidatePath,
			outputMode: "file-only",
		});
	}

	return {
		approved: finalDecision.kind === "accept",
		mean_score: finalMean,
		score_table_path: scoreTablePath,
		repairs_completed: repairsCompleted,
		candidate_path: candidatePath,
		review_report_path: reviewReportPath,
		remaining_work: finalDecision.kind === "accept" ? [] : remainingWork,
	};
}
