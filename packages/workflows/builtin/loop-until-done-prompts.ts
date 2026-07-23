type PromptSection = readonly [tag: string, content: string];

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
    .join("\n\n");
}

export function renderIterationPrompt(options: {
  readonly task: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly ledgerPath: string;
}): string {
  return taggedPrompt([
    ["role", "You are the active worker in a bounded evidence-driven completion loop."],
    ["objective", options.task],
    ["iteration", `${options.iteration} of ${options.maxIterations}`],
    ["progress_ledger", `Read ${options.ledgerPath} first. It is the durable source of truth for attempted work, findings, failures, validation evidence, and remaining work.`],
    ["requirements", [
      "Select the highest-value unfinished item supported by the ledger and current state.",
      "Perform concrete work; do not merely restate the objective or ledger.",
      "Avoid repeating failed approaches unless new evidence justifies the retry.",
      "Run the strongest practical validation for the work completed in this iteration.",
      "Report exactly what changed, evidence gathered, failures encountered, and what remains.",
    ].join("\n")],
    ["success_criteria", "This iteration makes measurable progress or supplies decisive evidence that the explicit objective is complete."],
    ["output_format", "Markdown with Work performed, Changes, Validation evidence, New findings, Failures, and Remaining work."],
  ]);
}

export function renderEvaluationPrompt(options: {
  readonly task: string;
  readonly iteration: number;
  readonly ledgerPath: string;
  readonly iterationPath: string;
}): string {
  return taggedPrompt([
    ["role", "You are an independent completion evaluator. Judge evidence, not the worker's confidence."],
    ["objective", options.task],
    ["artifacts", [
      `Durable progress ledger: ${options.ledgerPath}`,
      `Current iteration artifact: ${options.iterationPath}`,
      "Read both files before deciding.",
    ].join("\n")],
    ["stop_condition", [
      "Set done=true only when the objective is fully satisfied and current validation evidence proves it.",
      "Set done=false when any required behavior, validation, cleanup, or evidence remains missing or uncertain.",
      "Do not invent requirements beyond the objective.",
    ].join("\n")],
    ["evidence_rules", [
      "List concrete validation evidence supporting the decision.",
      "Record new findings and failures distinctly.",
      "When incomplete, state actionable remaining work for the next iteration.",
      "Return the required structured decision.",
    ].join("\n")],
    ["success_criteria", `The iteration ${options.iteration} decision is reproducible from cited artifact evidence.`],
  ]);
}

export function renderCompletionPrompt(options: {
  readonly task: string;
  readonly ledgerPath: string;
  readonly iterationPath: string;
}): string {
  return taggedPrompt([
    ["role", "You are the final completion reporter."],
    ["objective", options.task],
    ["artifacts", `Read the complete ledger at ${options.ledgerPath} and final iteration artifact at ${options.iterationPath}.`],
    ["requirements", [
      "Summarize the delivered outcome without adding unsupported claims.",
      "Cite the validation evidence that satisfied the stop condition.",
      "List artifact paths needed to audit the work.",
      "Report residual risks even when no work remains.",
    ].join("\n")],
    ["success_criteria", "The final report is concise, evidence-backed, and independently auditable from the ledger."],
    ["output_format", "Markdown with Outcome, Evidence, Artifacts, Residual risks, and Remaining work (None)."],
  ]);
}
