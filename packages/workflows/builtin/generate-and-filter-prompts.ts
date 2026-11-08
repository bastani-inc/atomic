import type { ScoringCandidate, SharedHead } from "./verification-prompts.js";
import { build_scoring_prompt, scoring_prompt_reads } from "./verification-prompts.js";

const GROUNDED_REPORTING = "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";
const READABLE_REPORT = "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background and repetition. Use complete, readable sentences rather than compressed fragments.";

export interface RenderedJudgePrompt {
	readonly prompt: string;
	readonly reads: readonly string[];
}

export function renderGeneratorPrompt(task: string, ordinal: number): string {
  return `<role>\nYou independently generate candidate ${ordinal}; do not imitate or assume other candidates.\n</role>\n\n<success_criteria>\nOne distinct, concrete candidate states its value, constraints, risks, and how it can be evaluated.\n</success_criteria>\n\n<stop_rules>\nStop after one self-contained, evaluable candidate; do not add alternatives.\n</stop_rules>\n\n<output_format>\nA candidate artifact with title, proposal, criteria-based rationale, risks, and evaluation evidence. ${READABLE_REPORT}\n${GROUNDED_REPORTING}\n</output_format>\n\n<objective>\n${task}\n</objective>`;
}

export function renderFilterPrompt(task: string, candidatePaths: readonly string[], shortlistSize: number): string {
  return `<artifacts>\nRead every candidate: ${candidatePaths.join(", ")}\n</artifacts>\n\n<role>\nYou deduplicate and filter independently generated candidates.\n</role>\n\n<rubric>\nFirst collapse substantively equivalent candidates. Then score fit to the task, feasibility, evidence, distinctiveness, and risk. Near-duplicates must not gain weight by repetition. Record every discarded candidate and a concrete reason.\n</rubric>\n\n<success_criteria>\nAt most ${shortlistSize} strongest distinct candidates remain, ranked by the rubric, and every discarded candidate has a concrete reason.\n</success_criteria>\n\n<stop_rules>\nStop after every candidate is shortlisted once or recorded as discarded.\n</stop_rules>\n\n<output_format>\nReport shortlist (candidate artifact paths in ranked order) and discarded entries containing path and a concise, criteria-based reason.\n</output_format>\n\n<objective>\nSelect at most ${shortlistSize} strongest candidates for: ${task}\n</objective>`;
}

export function renderJudgePrompt(
	task: string,
	filterPath: string,
	shortlistSize: number,
	candidates: readonly ScoringCandidate[] = [],
): RenderedJudgePrompt {
	const head: SharedHead = {
		task: `Rank at most ${shortlistSize} distinct candidate paths for: ${task}.`,
		groundTruthNote: `Read the filter report at ${filterPath} and every candidate path it references before judging.`,
		candidates,
		outputFormat: "Report shortlist (candidate paths in ranked order) and rationale (a concise, criteria-based explanation).",
	};
	const prompt = build_scoring_prompt(head, {
		id: "filtered_shortlist",
		name: "Filtered shortlist",
		description: "Check task fit, feasibility, evidence, distinctiveness, and material risk; do not restore a duplicate merely because it is phrased differently.",
	});
	return { prompt, reads: [filterPath, ...scoring_prompt_reads(head)] };
}
export function renderFinalShortlistPrompt(task: string, decisionPath: string): string {
  return `<artifact>\nRead the authoritative selection at ${decisionPath}; follow its order and do not add candidates.\n</artifact>\n\n<role>\nYou present a concise, actionable final shortlist so the reader can choose the next evaluation without reading the selection session.\n</role>\n\n<success_criteria>\nEvery selected candidate appears once in authoritative order with its differentiator, evidence, tradeoffs, and recommended next evaluation.\n</success_criteria>\n\n<stop_rules>\nStop after presenting every selected candidate once; do not add or reorder candidates.\n</stop_rules>\n\n<output_format>\nRanked markdown shortlist with candidate path, differentiator, evidence, tradeoffs, and recommended next evaluation. ${READABLE_REPORT}\n${GROUNDED_REPORTING}\n</output_format>\n\n<objective>\nSummarize the selected candidates for: ${task}\n</objective>`;
}
