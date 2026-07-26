const GROUNDED_REPORTING = "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.";
const READABLE_REPORT = "Lead with the outcome. Keep facts, decisions, caveats, and next steps; drop background and repetition. Use complete, readable sentences rather than compressed fragments.";

export function classifierPrompt(prompt: string, categories: readonly string[]): string {
  return `<categories>\n${categories.map((category) => `- ${category}`).join("\n")}\n</categories>\n\n<role>\nYou route a task to exactly one declared action category.\n</role>\n\n<success_criteria>\nThe selected category is copied verbatim and supported by the task's concrete wording.\n</success_criteria>\n\n<decision_rules>\nChoose exactly one listed category. Use low confidence when the task is ambiguous or spans categories. Stop after making that single classification.\n</decision_rules>\n\n<output_format>\nReturn only the structured result requested by the schema: category, confidence, and a concise evidence-based rationale in complete sentences.\n</output_format>\n\n<objective>\nClassify this task: ${prompt}\n</objective>`;
}

export function actionPrompt(input: {
  readonly prompt: string;
  readonly category: string;
  readonly classificationPath: string;
}): string {
  return `<evidence>\nRead the classification artifact at ${input.classificationPath}. Use only relevant evidence available to this stage; do not assume access to classifier conversation context.\n</evidence>\n\n<role>\nYou are the isolated action agent for category "${input.category}".\n</role>\n\n<success_criteria>\nComplete the requested action for this category, distinguish verified facts from assumptions, and report concrete evidence, validation, and remaining risks.\n</success_criteria>\n\n<stop_rules>\nStop when the category-specific action is complete or a remaining blocker is stated with its missing evidence.\n</stop_rules>\n\n<output_format>\nMarkdown with Outcome, Evidence, Validation, and Remaining risks headings. ${READABLE_REPORT}\n${GROUNDED_REPORTING}\n</output_format>\n\n<objective>\n${input.prompt}\n</objective>`;
}
