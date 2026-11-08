import { Type } from "typebox";
import type {
	WorkflowRunContext,
	WorkflowSerializableValue,
	WorkflowTaskResult,
} from "../src/shared/types.js";
import {
	build_scoring_prompt,
	scoring_prompt_reads,
	type ScoringCandidate,
	type SharedHead,
} from "./verification-prompts.js";
import { VERIFICATION_SCALE } from "./verification-criteria.js";
import type {
	ConsolidatableFinding,
	ConsolidatedFinding,
} from "./review-convergence.js";

/** Confidence values strictly below this threshold can enter re-verification. */
export const DEFAULT_REVERIFY_THRESHOLD = 0.7;

const STANDARD_CONFIRM_THRESHOLD = 10;
const REQUIRED_CONFIRM_THRESHOLD = 6;
const DEFAULT_REPEATS = 3;
const REVERIFY_QUESTION =
	"Assess this specific finding against the code it cites: is it a real, objective-relevant, currently-unresolved blocker?";

/** The finding fields needed by the re-verification door. */
export type ReverifiableFinding = ConsolidatableFinding & {
	readonly body?: string;
	readonly confidence_score?: number;
};

export type ReverifiableConsolidatedFinding = ConsolidatedFinding<ReverifiableFinding>;

export type ReverifyResult = {
	readonly verdict: "confirmed" | "demoted";
	readonly meanScore: number;
	readonly perRepeat: readonly (number | null)[];
	readonly evidence: readonly string[];
};

/** Audit evidence retained alongside the original consolidated finding. */
export type ReverifyAuditEntry<F extends ReverifiableFinding = ReverifiableFinding> = {
	readonly finding: ConsolidatedFinding<F>;
	readonly verdict: ReverifyResult["verdict"];
	readonly meanScore: number;
	readonly perRepeat: readonly (number | null)[];
	readonly evidence: readonly string[];
};

export type ReverifyContext = Pick<WorkflowRunContext, "task">;

export type ReverifyBatchResult<F extends ReverifiableFinding = ReverifiableFinding> = {
	readonly batch: readonly ConsolidatedFinding<F>[];
	readonly audits: readonly ReverifyAuditEntry<F>[];
};

export type ReverifyBatchInput<F extends ReverifiableFinding = ReverifiableFinding> = {
	readonly batch: readonly ConsolidatedFinding<F>[];
	readonly context: {
		readonly objective: string;
		readonly candidateRefs: readonly string[];
	};
	readonly repeats?: number;
	readonly threshold?: number;
};

const reverifySchema = Type.Object(
	{
		score: VERIFICATION_SCALE.schema,
		evidence: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

type ReverifyReport = {
	readonly score: number;
	readonly evidence: readonly string[];
};

function isRecord(value: WorkflowSerializableValue | undefined): value is Record<string, WorkflowSerializableValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: WorkflowSerializableValue | undefined): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseReport(result: WorkflowTaskResult): ReverifyReport | undefined {
	if (!isRecord(result.structured)) return undefined;
	const score = result.structured.score;
	if (
		typeof score !== "number" ||
		!Number.isInteger(score) ||
		score < VERIFICATION_SCALE.min ||
		score > VERIFICATION_SCALE.max
	) {
		return undefined;
	}
	const evidence = result.structured.evidence;
	return {
		score,
		evidence: isStringArray(evidence) ? evidence : [],
	};
}

function requiredByObjective(finding: ReverifiableConsolidatedFinding): boolean {
	return finding.finding.objective_alignment === "required_by_objective";
}

/**
 * Pure eligibility predicate. Missing confidence is deliberately ineligible:
 * an absent graded signal is doubt, and doubt remains blocking.
 */
export function is_reverifiable(
	finding: ReverifiableConsolidatedFinding,
	threshold = DEFAULT_REVERIFY_THRESHOLD,
): boolean {
	const confidence = finding.finding.confidence_score;
	return (
		finding.blocking &&
		finding.reviewers.length === 1 &&
		typeof confidence === "number" &&
		Number.isFinite(confidence) &&
		confidence < threshold &&
		finding.finding.objective_alignment !== "beyond_objective" &&
		finding.finding.objective_alignment !== "contradicts_objective"
	);
}

function readPaths(
	finding: ReverifiableConsolidatedFinding,
	candidateRefs: readonly string[],
): readonly string[] {
	const codePath = finding.finding.code_location?.absolute_file_path;
	return [
		...(codePath === undefined ? [] : [codePath]),
		...candidateRefs,
	];
}

function promptFor(
	finding: ReverifiableConsolidatedFinding,
	context: ReverifyBatchInput["context"],
): { readonly prompt: string; readonly reads: readonly string[] } {
	const codePath = finding.finding.code_location?.absolute_file_path;
	const candidate: ScoringCandidate = {
		...(codePath === undefined ? {} : { path: codePath }),
		body: [
			`Title: ${finding.finding.title}`,
			`Body: ${finding.finding.body ?? ""}`,
			`Code location: ${codePath ?? "not supplied"}`,
		].join("\n"),
	};
	const head: SharedHead = {
		task: `${REVERIFY_QUESTION}\n\nObjective:\n${context.objective}`,
		groundTruthNote: `The objective is the contract. Verify the finding against observed code, not reviewer narration.`,
		candidates: [candidate],
		outputFormat: "Report score (an integer from 1 to 20) and evidence (an array of observed, concise reasons).",
	};
	const prompt = build_scoring_prompt(head, {
		id: "finding_reverification",
		name: "Finding re-verification",
		description: REVERIFY_QUESTION,
	});
	return {
		prompt,
		reads: [
			...readPaths(finding, context.candidateRefs),
			...scoring_prompt_reads(head),
		],
	};
}

async function runRepeat(
	ctx: ReverifyContext,
	finding: ReverifiableConsolidatedFinding,
	context: ReverifyBatchInput["context"],
	stageName: string,
): Promise<ReverifyReport | undefined> {
	try {
		const rendered = promptFor(finding, context);
		const options = {
			prompt: rendered.prompt,
			context: "fresh" as const,
			reads: rendered.reads,
			schema: reverifySchema,
		};
		return parseReport(await ctx.task(stageName, options));
	} catch {
		return undefined;
	}
}

/**
 * Re-score one eligible finding in K independent fresh contexts.
 *
 * A zero-valid-repeat mean is the deterministic sentinel `0`, matching the
 * verification criteria module's empty-mean convention. It never authorizes a
 * demotion because the quorum checks below require at least one valid score.
 */
export async function reverify_finding(
	ctx: ReverifyContext,
	input: {
		readonly finding: ReverifiableConsolidatedFinding;
		readonly context: {
			readonly objective: string;
			readonly candidateRefs: readonly string[];
		};
		repeats?: number;
		threshold?: number;
	},
): Promise<ReverifyResult> {
	if (!is_reverifiable(input.finding, input.threshold)) {
		throw new Error("Cannot re-verify an ineligible finding.");
	}

	const repeatCount = Number.isFinite(input.repeats) && input.repeats !== undefined
		? Math.max(0, Math.floor(input.repeats))
		: DEFAULT_REPEATS;
	const perRepeat: Array<number | null> = [];
	const evidence: string[] = [];
	const validScores: number[] = [];
	for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
		let report = await runRepeat(ctx, input.finding, input.context, `reverify-${repeat}`);
		if (report === undefined) {
			report = await runRepeat(ctx, input.finding, input.context, `reverify-${repeat}-reask`);
		}
		if (report === undefined) {
			perRepeat.push(null);
			evidence.push(
				`Re-verification repeat ${repeat} was invalid after one re-ask; doubt defaults to confirmed.`,
			);
			continue;
		}
		perRepeat.push(report.score);
		validScores.push(report.score);
		if (report.evidence.length === 0) {
			evidence.push(`Re-verification repeat ${repeat} scored ${report.score}/20.`);
		} else {
			evidence.push(...report.evidence);
		}
	}

	const meanScore = validScores.length === 0
		? 0
		: validScores.reduce((total, score) => total + score, 0) / validScores.length;
	const validCount = validScores.length;
	const requiredQuorum = Math.ceil(repeatCount / 2);
	const demoted = requiredByObjective(input.finding)
		? repeatCount > 0 && validCount === repeatCount && meanScore < REQUIRED_CONFIRM_THRESHOLD
		: validCount > 0 && validCount >= requiredQuorum && meanScore < STANDARD_CONFIRM_THRESHOLD;
	return {
		verdict: demoted ? "demoted" : "confirmed",
		meanScore,
		perRepeat,
		evidence,
	};
}

function auditKey<F extends ReverifiableFinding>(finding: ConsolidatedFinding<F>): string {
	return JSON.stringify([
		finding.finding.code_location?.absolute_file_path ?? "",
		finding.finding.title,
		finding.reviewers,
	]);
}

/** Apply only evidence-backed demotions; the original finding remains present. */
export function apply_reverify_results<F extends ReverifiableFinding>(
	batch: readonly ConsolidatedFinding<F>[],
	audits: readonly ReverifyAuditEntry<F>[],
): ReverifyBatchResult<F> {
	const demoted = new Set(
		audits
			.filter((audit) => audit.verdict === "demoted")
			.map((audit) => auditKey(audit.finding)),
	);
	return {
		batch: batch.map((entry) =>
			demoted.has(auditKey(entry)) ? { ...entry, blocking: false } : entry,
		),
		audits,
	};
}

/** Re-verify only eligible entries and return the batch plus durable audit data. */
export async function reverify_consolidated_batch<F extends ReverifiableFinding>(
	ctx: ReverifyContext,
	input: ReverifyBatchInput<F>,
): Promise<ReverifyBatchResult<F>> {
	const audits: ReverifyAuditEntry<F>[] = [];
	for (const entry of input.batch) {
		if (!is_reverifiable(entry, input.threshold)) continue;
		const result = await reverify_finding(ctx, {
			finding: entry,
			context: input.context,
			repeats: input.repeats,
			threshold: input.threshold,
		});
		audits.push({ finding: entry, ...result });
	}
	return apply_reverify_results(input.batch, audits);
}
