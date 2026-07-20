export function renderGeneratorPrompt(task: string, ordinal: number): string {
  return `<role>\nYou independently generate candidate ${ordinal}; do not imitate or assume other candidates.\n</role>\n\n<objective>\n${task}\n</objective>\n\n<requirements>\nProduce one distinct, concrete candidate. Explain its value, constraints, risks, and how it can be evaluated.\n</requirements>\n\n<output_format>\nA self-contained candidate artifact with title, proposal, rationale, risks, and evaluation evidence.\n</output_format>`;
}

export function renderFilterPrompt(task: string, candidatePaths: readonly string[], shortlistSize: number): string {
  return `<role>\nYou deduplicate and filter independently generated candidates.\n</role>\n\n<objective>\nSelect at most ${shortlistSize} strongest candidates for: ${task}\n</objective>\n\n<artifacts>\nRead every candidate: ${candidatePaths.join(", ")}\n</artifacts>\n\n<rubric>\nFirst collapse substantively equivalent candidates. Then score fit to the task, feasibility, evidence, distinctiveness, and risk. Near-duplicates must not gain weight by repetition. Record every discarded candidate and a concrete reason.\n</rubric>\n\n<output_format>\nCall structured_output with shortlist (candidate artifact paths in ranked order) and discarded entries containing path and reason.\n</output_format>`;
}

export function renderJudgePrompt(task: string, filterPath: string, shortlistSize: number): string {
  return `<role>\nYou independently judge the filtered shortlist against the explicit rubric.\n</role>\n\n<objective>\nReturn at most ${shortlistSize} ranked candidate paths that best satisfy: ${task}\n</objective>\n\n<artifacts>\nRead the filter report at ${filterPath} and every candidate path it references.\n</artifacts>\n\n<rubric>\nCheck task fit, feasibility, evidence, distinctiveness, and material risk. Do not restore a duplicate merely because it is phrased differently.\n</rubric>\n\n<output_format>\nCall structured_output with shortlist and rationale.\n</output_format>`;
}

export function renderFinalShortlistPrompt(task: string, decisionPath: string): string {
  return `<role>\nYou present a concise, actionable final shortlist.\n</role>\n\n<objective>\nSummarize the selected candidates for: ${task}\n</objective>\n\n<artifact>\nRead the authoritative selection at ${decisionPath}; follow its order and do not add candidates.\n</artifact>\n\n<output_format>\nRanked markdown shortlist with candidate path, differentiator, evidence, tradeoffs, and recommended next evaluation.\n</output_format>`;
}
