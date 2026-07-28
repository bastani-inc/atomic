type PromptSection = readonly [tag: string, content: string];

const GROUNDED_REPORTING = "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";
const READABLE_REPORT = "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background and repetition. Use complete, readable sentences rather than compressed fragments.";

function taggedPrompt(sections: readonly PromptSection[]): string {
  return sections
    .map(([tag, content]) => `<${tag}>\n${content.trim()}\n</${tag}>`)
    .join("\n\n");
}

export function renderTournamentAttemptPrompt(task: string, attempt: number): string {
  return taggedPrompt([
    ["role", "You are an independent solution author competing on solution quality."],
    ["attempt", `Produce attempt ${attempt} without assuming another attempt's approach or conclusions.`],
    ["success_criteria", "A judge can evaluate this artifact directly against correctness, completeness, evidence, and task fit."],
    ["requirements", [
      "Deliver a complete, self-contained solution rather than commentary about how to solve it.",
      "Ground important claims in observable evidence or executable checks.",
      "State assumptions, limitations, and validation performed.",
      "Optimize for correctness and usefulness, not length.",
      GROUNDED_REPORTING,
    ].join("\n")],
    ["stop_rules", "Stop when the solution is complete, supported, validated where practical, and its residual risks are stated."],
    ["output_format", `Markdown with Solution, Evidence and validation, Assumptions, and Residual risks. ${READABLE_REPORT}`],
    ["objective", task],
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
    ["candidates", [
      `First presentation: ${options.firstLabel} at ${options.firstPath}`,
      `Second presentation: ${options.secondLabel} at ${options.secondPath}`,
      "Read both files completely before deciding.",
    ].join("\n")],
    ["role", "You are an impartial pairwise judge. Evaluate only the supplied artifacts."],
    ["rubric", [
      "1. Correctness: satisfies the task without material errors.",
      "2. Completeness: covers required outcomes and important edge cases.",
      "3. Evidence: supports claims with observable evidence or checks.",
      "4. Task fit: is directly usable and avoids irrelevant work.",
    ].join("\n")],
    ["decision_rules", [
      "Choose exactly one presented candidate; do not merge or rewrite them.",
      "Ignore presentation order, writing length, and stylistic polish unless they affect the rubric.",
      "Cite observable evidence from both artifacts and give concise criteria-based justification.",
      GROUNDED_REPORTING,
    ].join("\n")],
    ["success_criteria", "The selected winner is traceable to short rubric-grounded evidence from both candidates."],
    ["stop_rules", "Stop after selecting one candidate and supporting the choice against every rubric criterion."],
    ["output_format", `Return only the required structured decision with winner, rationale, and evidence. ${READABLE_REPORT}`],
    ["objective", options.task],
  ]);
}

export function renderBracketReducerPrompt(options: {
  readonly task: string;
  readonly bracketPath: string;
  readonly winnerLabel: string;
  readonly winnerPath: string;
}): string {
  return taggedPrompt([
    ["artifacts", [
      `Bracket ledger: ${options.bracketPath}`,
      `Winning artifact (${options.winnerLabel}): ${options.winnerPath}`,
      "Read both files before reporting.",
    ].join("\n")],
    ["role", "You are the tournament bracket reducer and final reporter."],
    ["requirements", [
      "Return the winning solution faithfully; do not silently combine losing material into it.",
      "Summarize why it advanced using the recorded pairwise rationale and evidence.",
      "Call out bracket byes and any limitations recorded by judges.",
      "Cite the bracket ledger and winning artifact paths.",
      GROUNDED_REPORTING,
    ].join("\n")],
    ["success_criteria", "A reader can use the winning solution and audit every comparison that selected it."],
    ["stop_rules", "Stop after faithfully presenting the winner and an auditable decision trail, including byes and limitations."],
    ["output_format", `Markdown with Winner, Winning solution, Decision trail, Evidence, and Residual risks. ${READABLE_REPORT}`],
    ["objective", options.task],
  ]);
}
