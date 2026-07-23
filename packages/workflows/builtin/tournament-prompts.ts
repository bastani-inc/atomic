type PromptSection = readonly [tag: string, content: string];

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
    .join("\n\n");
}

export function renderTournamentAttemptPrompt(task: string, attempt: number): string {
  return taggedPrompt([
    ["role", "You are an independent solution author competing on solution quality."],
    ["objective", task],
    ["attempt", `Produce attempt ${attempt} without assuming another attempt's approach or conclusions.`],
    ["requirements", [
      "Deliver a complete, self-contained solution rather than commentary about how to solve it.",
      "Ground important claims in observable evidence, concrete reasoning, or executable checks.",
      "State assumptions, limitations, and validation performed.",
      "Optimize for correctness and usefulness, not length.",
    ].join("\n")],
    ["success_criteria", "A judge can evaluate this artifact directly against correctness, completeness, evidence, and task fit."],
    ["output_format", "Markdown with Solution, Evidence and validation, Assumptions, and Residual risks."],
  ]);
}

export function renderPairwiseJudgePrompt(options: {
  readonly task: string;
  readonly firstLabel: string;
  readonly secondLabel: string;
  readonly firstPath: string;
  readonly secondPath: string;
}): string {
  return taggedPrompt([
    ["role", "You are an impartial pairwise judge. Evaluate only the supplied artifacts."],
    ["objective", options.task],
    ["candidates", [
      `First presentation: ${options.firstLabel} at ${options.firstPath}`,
      `Second presentation: ${options.secondLabel} at ${options.secondPath}`,
      "Read both files completely before deciding.",
    ].join("\n")],
    ["rubric", [
      "1. Correctness: satisfies the task without material errors.",
      "2. Completeness: covers required outcomes and important edge cases.",
      "3. Evidence: supports claims with concrete reasoning or checks.",
      "4. Task fit: is directly usable and avoids irrelevant work.",
    ].join("\n")],
    ["decision_rules", [
      "Choose exactly one presented candidate; do not merge or rewrite them.",
      "Ignore presentation order, writing length, and stylistic polish unless they affect the rubric.",
      "Cite observable evidence from both artifacts and give a concise rationale.",
      "Return the required structured decision.",
    ].join("\n")],
    ["success_criteria", "The selected winner is traceable to short rubric-grounded evidence from both candidates."],
  ]);
}

export function renderBracketReducerPrompt(options: {
  readonly task: string;
  readonly bracketPath: string;
  readonly winnerLabel: string;
  readonly winnerPath: string;
}): string {
  return taggedPrompt([
    ["role", "You are the tournament bracket reducer and final reporter."],
    ["objective", options.task],
    ["artifacts", [
      `Bracket ledger: ${options.bracketPath}`,
      `Winning artifact (${options.winnerLabel}): ${options.winnerPath}`,
      "Read both files before reporting.",
    ].join("\n")],
    ["requirements", [
      "Return the winning solution faithfully; do not silently combine losing material into it.",
      "Summarize why it advanced using the recorded pairwise rationale and evidence.",
      "Call out bracket byes and any limitations recorded by judges.",
      "Cite the bracket ledger and winning artifact paths.",
    ].join("\n")],
    ["success_criteria", "A reader can use the winning solution and audit every comparison that selected it."],
    ["output_format", "Markdown with Winner, Winning solution, Decision trail, Evidence, and Residual risks."],
  ]);
}
