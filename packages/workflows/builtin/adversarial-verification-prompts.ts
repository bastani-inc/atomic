export function renderWorkerPrompt(task: string): string {
  return `<role>\nYou produce a candidate solution for independent verification.\n</role>\n\n<objective>\n${task}\n</objective>\n\n<requirements>\nComplete the task, preserve concrete evidence, and state every validation performed. Do not claim success without observable support.\n</requirements>\n\n<output_format>\nA self-contained candidate with actions taken, evidence, validation, and remaining risks.\n</output_format>`;
}

export function renderVerifierPrompt(task: string, candidatePath: string, rubricPath: string): string {
  return `<role>\nYou are an independent adversarial verifier. Find blockers; do not rewrite the candidate.\n</role>\n\n<objective>\nVerify the candidate against the task and rubric. Task: ${task}\n</objective>\n\n<artifacts>\nRead the complete candidate at ${candidatePath} and rubric at ${rubricPath}.\n</artifacts>\n\n<requirements>\nTest important claims where practical. A pass requires concrete evidence for every rubric item. Report precise blocking findings; absence of evidence is not evidence of correctness.\n</requirements>\n\n<output_format>\nCall structured_output with verdict (pass or fail), evidence, and blocking_findings.\n</output_format>`;
}

export function renderReducerPrompt(task: string, candidatePath: string, verifierPaths: readonly string[], repairsCompleted: number, maxRepairs: number): string {
  return `<role>\nYou reduce independent verification reports into one deterministic next action.\n</role>\n\n<objective>\nDecide whether the candidate for ${task} is accepted, rejected, or needs repair.\n</objective>\n\n<artifacts>\nCandidate: ${candidatePath}\nVerifier reports: ${verifierPaths.join(", ")}\n</artifacts>\n\n<decision_rules>\nAccept only when all material rubric requirements have pass evidence. Request repair when findings are actionable and repair budget remains (${repairsCompleted}/${maxRepairs}). Reject when evidence proves the candidate cannot satisfy the task or the repair budget is exhausted. Preserve unresolved blockers verbatim.\n</decision_rules>\n\n<output_format>\nCall structured_output with decision (accept, reject, or repair), rationale, and remaining_work.\n</output_format>`;
}

export function renderRepairPrompt(task: string, candidatePath: string, reviewPath: string): string {
  return `<role>\nYou repair a candidate using independent blocking findings.\n</role>\n\n<objective>\nRepair the candidate for: ${task}\n</objective>\n\n<artifacts>\nRead the current candidate at ${candidatePath} and reducer report at ${reviewPath}.\n</artifacts>\n\n<requirements>\nAddress every actionable blocker, rerun relevant validation, and retain valid prior work. Do not dismiss a finding without contrary evidence.\n</requirements>\n\n<output_format>\nA complete replacement candidate with repair summary, evidence, validation, and remaining risks.\n</output_format>`;
}
