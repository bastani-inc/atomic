export function classifierPrompt(prompt: string, categories: readonly string[]): string {
  return `<role>\nYou route a task to exactly one declared action category.\n</role>\n\n<objective>\nClassify this task: ${prompt}\n</objective>\n\n<categories>\n${categories.map((category) => `- ${category}`).join("\n")}\n</categories>\n\n<requirements>\nChoose a category verbatim from the list. Base confidence on concrete wording in the task. Use low confidence when the task is ambiguous or spans categories. Provide a concise evidence-based rationale. Return only the structured result requested by the schema.\n</requirements>`;
}

export function actionPrompt(input: {
  readonly prompt: string;
  readonly category: string;
  readonly classificationPath: string;
}): string {
  return `<role>\nYou are the isolated action agent for category "${input.category}".\n</role>\n\n<objective>\n${input.prompt}\n</objective>\n\n<evidence>\nRead the classification artifact at ${input.classificationPath}. Use only relevant evidence available to this stage; do not assume access to classifier conversation context.\n</evidence>\n\n<success_criteria>\nComplete the requested action for this category, distinguish verified facts from assumptions, and report concrete evidence, validation, and remaining risks.\n</success_criteria>\n\n<output_format>\nMarkdown with Outcome, Evidence, Validation, and Remaining risks headings.\n</output_format>`;
}
