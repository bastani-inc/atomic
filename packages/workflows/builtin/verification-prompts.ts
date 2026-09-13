/**
 * Prefix-cache-aware verification prompts and warm-first fan-out.
 *
 * A scoring-family prompt is always `SHARED HEAD ‖ VARYING TAIL`: the head
 * contains the task statement, ground-truth note, candidate bodies (or read
 * references when the family is too large), and scale anchors, in that order.
 * The tail contains only the criterion name and description plus the output
 * format instruction. Keeping this ordering invariant means sibling criteria
 * can share the provider's cached prefix byte-for-byte.
 *
 * A pathless candidate is valid while the whole family is inline. If any body
 * exceeds the inline bound, every candidate must provide its caller-bound path;
 * this layer refuses the family rather than inventing a read path.
 */
import type {
	WorkflowParallelOptions,
	WorkflowRunContext,
	WorkflowTaskResult,
	WorkflowTaskStep,
} from "../src/shared/types.js";
import type { Criterion } from "./verification-criteria.js";
import { VERIFICATION_SCALE } from "./verification-criteria.js";

/** Maximum UTF-8 byte length of one candidate body eligible for inlining. */
export const MAX_INLINE_CANDIDATE_BYTES = 32 * 1024;

export interface ScoringCandidate {
	/**
	 * Optional only while every candidate body is inline. An oversized family
	 * requires a caller-bound path for every candidate; paths are preserved
	 * verbatim and are never synthesized.
	 */
	readonly path?: string;
	readonly body: string;
}

export interface SharedHead {
	readonly task: string;
	readonly groundTruthNote: string;
	readonly candidates: readonly ScoringCandidate[];
	readonly scaleAnchors?: string;
	readonly outputFormat?: string;
}

export interface WarmFirstFanOutOptions extends WorkflowParallelOptions {
	/** Maximum number of distinct prefixes warmed at once. */
	readonly warmConcurrency?: number;
}

export type WarmFirstFanOutContext = Pick<WorkflowRunContext, "parallel">;

const DEFAULT_WARM_CONCURRENCY = 4;
const DEFAULT_OUTPUT_FORMAT =
	"Call structured_output with criterion_id, score (1–20), evidence, and findings containing finding and severity.";

function inlineCandidates(head: SharedHead): boolean {
	return head.candidates.every(
		(candidate) => Buffer.byteLength(candidate.body, "utf8") <= MAX_INLINE_CANDIDATE_BYTES,
	);
}

function fallbackReadPaths(head: SharedHead): readonly string[] | undefined {
	if (inlineCandidates(head)) return undefined;
	const paths: string[] = [];
	for (const [index, candidate] of head.candidates.entries()) {
		if (candidate.path === undefined) {
			throw new TypeError(
				`Oversized candidate family requires a caller-bound path for every candidate; candidate ${index + 1} has no path.`,
			);
		}
		paths.push(candidate.path);
	}
	return paths;
}

function candidateSection(head: SharedHead, readPaths: readonly string[] | undefined): string {
	return head.candidates
		.map((candidate, index) => {
			if (readPaths === undefined) {
				return `<candidate index="${index + 1}">\n${candidate.body}\n</candidate>`;
			}
			return `<candidate index="${index + 1}" source="read">\nRead candidate from ${readPaths[index]!}.\n</candidate>`;
		})
		.join("\n");
}

/**
 * Return candidate paths required by the read fallback.
 *
 * The whole family switches together: either every body is in the shared head,
 * or every candidate is named as a caller-provided read. Order and duplicate
 * paths are kept; an oversized pathless family throws instead of guessing.
 */
export function scoring_prompt_reads(head: SharedHead): readonly string[] {
	return fallbackReadPaths(head) ?? [];
}

/**
 * Build one scoring prompt with a byte-identical shared head and criterion tail.
 * Candidate bodies are measured in UTF-8 bytes, not JavaScript code units. If
 * any body exceeds `MAX_INLINE_CANDIDATE_BYTES`, no body is inlined for the
 * family, preserving the same head for every sibling criterion.
 */
export function build_scoring_prompt(head: SharedHead, criterion: Criterion): string {
	const readPaths = fallbackReadPaths(head);
	const sharedHead = [
		"<scoring_head>",
		"<task_statement>",
		head.task,
		"</task_statement>",
		"<ground_truth_note>",
		head.groundTruthNote,
		"</ground_truth_note>",
		"<candidates>",
		candidateSection(head, readPaths),
		"</candidates>",
		"<scale_anchors>",
		head.scaleAnchors ?? VERIFICATION_SCALE.anchors,
		"</scale_anchors>",
	].join("\n");
	const varyingTail = [
		"<criterion>",
		`<name>${criterion.name}</name>`,
		`<description>${criterion.description}</description>`,
		"</criterion>",
		"<output_format>",
		head.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
		"</output_format>",
	].join("\n");
	return `${sharedHead}\n\n${varyingTail}`;
}

function boundedConcurrency(
	stepCount: number,
	phaseCap: number | undefined,
	inheritedCap: number | undefined,
): number {
	return Math.min(stepCount, phaseCap ?? stepCount, inheritedCap ?? stepCount);
}

/**
 * Run one warm step per prefix, then release the remaining steps. Prefix keys
 * are caller-owned; first-seen order is deterministic. Warm failures are
 * observed without fail-fast, and the second phase is always attempted before
 * the warm error is rethrown. Successful results are returned in input order.
 */
export async function warm_first_fan_out<K>(
	ctx: WarmFirstFanOutContext,
	steps: readonly WorkflowTaskStep[],
	prefixKeyOf: (step: WorkflowTaskStep, index: number) => K,
	options: WarmFirstFanOutOptions = {},
): Promise<WorkflowTaskResult[]> {
	const warmIndices: number[] = [];
	const restIndices: number[] = [];
	const seen = new Set<K>();
	for (const [index, step] of steps.entries()) {
		const prefixKey = prefixKeyOf(step, index);
		if (seen.has(prefixKey)) restIndices.push(index);
		else {
			seen.add(prefixKey);
			warmIndices.push(index);
		}
	}

	const { warmConcurrency, ...parallelOptions } = options;
	const inheritedConcurrency = parallelOptions.concurrency;
	const resultsByIndex = new Map<number, WorkflowTaskResult>();
	let warmFailure: Error | undefined;
	if (warmIndices.length > 0) {
		const warmSteps = warmIndices.map((index) => steps[index]!);
		try {
			const warmResults = await ctx.parallel(warmSteps, {
				...parallelOptions,
				concurrency: boundedConcurrency(
					warmSteps.length,
					warmConcurrency ?? DEFAULT_WARM_CONCURRENCY,
					inheritedConcurrency,
				),
				failFast: false,
				possibleStageNames: options.possibleStageNames,
			});
			for (const [resultIndex, result] of warmResults.entries()) {
				const originalIndex = warmIndices[resultIndex];
				if (originalIndex !== undefined) resultsByIndex.set(originalIndex, result);
			}
		} catch (error) {
			warmFailure = error instanceof Error ? error : new Error(String(error));
		}
	}

	if (restIndices.length > 0) {
		const restSteps = restIndices.map((index) => steps[index]!);
		const restResults = await ctx.parallel(restSteps, {
			...parallelOptions,
			concurrency: boundedConcurrency(restSteps.length, undefined, inheritedConcurrency),
			possibleStageNames: options.possibleStageNames,
		});
		for (const [resultIndex, result] of restResults.entries()) {
			const originalIndex = restIndices[resultIndex];
			if (originalIndex !== undefined) resultsByIndex.set(originalIndex, result);
		}
	}

	if (warmFailure !== undefined) throw warmFailure;
	return steps
		.map((_, index) => resultsByIndex.get(index))
		.filter((result): result is WorkflowTaskResult => result !== undefined);
}
