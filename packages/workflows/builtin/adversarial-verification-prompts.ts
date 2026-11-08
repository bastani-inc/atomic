import type { Criterion } from "./verification-criteria.js";

const GROUNDED_REPORTING = "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";
const READABLE_REPORT = "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background and repetition. Use complete, readable sentences rather than compressed fragments.";

export function renderWorkerPrompt(task: string): string {
  return `<role>\nYou produce a candidate solution for independent verification.\n</role>\n\n<success_criteria>\nThe task is complete and important claims have observable support. Preserve concrete evidence and state every validation performed.\n</success_criteria>\n\n<stop_rules>\nStop when the candidate is complete and validated where practical, or state the evidence still missing.\n</stop_rules>\n\n<output_format>\nA self-contained candidate with actions taken, evidence, validation, and remaining risks. ${READABLE_REPORT}\n${GROUNDED_REPORTING}\n</output_format>\n\n<objective>\n${task}\n</objective>`;
}

export function renderVerifierPrompt(task: string, candidatePath: string, criteriaPath: string, criterion: Criterion): string {
  return `<artifacts>\nRead the complete candidate at ${candidatePath} and resolved criteria at ${criteriaPath}.\n</artifacts>\n\n<role>\nYou are an independent adversarial verifier. Score exactly one criterion and do not rewrite the candidate.\n</role>\n\n<criterion>\nid: ${criterion.id}\nname: ${criterion.name}\ninstructions: ${criterion.description}\n</criterion>\n\n<scale>\nUse an integer score from 1 to 20: 1 = certainly fails … 10 = borderline … 20 = verified correct.\n</scale>\n\n<evidence_rules>\nTest important claims where practical. Evidence must cite observable support; file findings cite file:line where applicable. Report precise findings and use severity veto only for a finding that unconditionally prevents acceptance. ${GROUNDED_REPORTING}\n</evidence_rules>\n\n<output_format>\nReport exactly criterion_id (set to ${criterion.id}), score, evidence (string array), and findings (objects with finding and severity veto, blocking, or note). ${READABLE_REPORT}\n</output_format>\n\n<objective>\nVerify criterion ${criterion.id} for the candidate produced for: ${task}\n</objective>`;
}

export function renderConsolidatorPrompt(
  task: string,
  candidatePath: string,
  scorePaths: readonly string[],
  repairsCompleted: number,
  maxRepairs: number,
): string {
  return `<artifacts>\nCandidate: ${candidatePath}\nConfirmed criterion score reports: ${scorePaths.join(", ")}\n</artifacts>\n\n<role>\nYou consolidate confirmed verifier findings into actionable repair guidance. You do not decide whether verification is approved; the deterministic verification gate already made that decision.\n</role>\n\n<decision_rules>\nPreserve every confirmed veto or blocking finding in remaining_work verbatim. Explain concrete repairs and validation steps. Repair budget: ${repairsCompleted}/${maxRepairs}.\n</decision_rules>\n\n<output_format>\nReport repair_guidance (a concise actionable repair plan) and remaining_work (the unresolved findings as strings). Never emit an approval or rejection decision. ${READABLE_REPORT}\n${GROUNDED_REPORTING}\n</output_format>\n\n<objective>\nConsolidate findings for the candidate produced for: ${task}\n</objective>`;
}

export function renderRepairPrompt(task: string, candidatePath: string, reviewPath: string): string {
  return `<artifacts>\nRead the current candidate at ${candidatePath} and consolidated findings at ${reviewPath}.\n</artifacts>\n\n<role>\nYou repair a candidate using independent blocking findings.\n</role>\n\n<success_criteria>\nEvery actionable blocker is addressed, relevant validation is rerun, and valid prior work is retained.\n</success_criteria>\n\n<evidence_rules>\nDo not dismiss a finding without contrary evidence. Report commands run, observed output, and file:line evidence where applicable. ${GROUNDED_REPORTING}\n</evidence_rules>\n\n<stop_rules>\nStop when all actionable blockers are repaired and validated, or list any blocker that remains with the missing evidence.\n</stop_rules>\n\n<output_format>\nA complete replacement candidate with repair summary, evidence, validation, and remaining risks. ${READABLE_REPORT}\n</output_format>\n\n<objective>\nRepair the candidate for: ${task}\n</objective>`;
}
