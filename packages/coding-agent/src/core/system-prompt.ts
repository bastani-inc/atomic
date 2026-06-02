/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

const DEFAULT_PROMPT_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "ask_user_question",
  "todo",
] as const;

export interface SystemPromptModel {
  /** Provider identifier for the selected model. */
  provider: string;
  /** Stable provider-specific model identifier. */
  id: string;
  /** Human-readable model name, when available. */
  name?: string;
}

export interface BuildSystemPromptOptions {
  /** Custom system prompt (replaces default). */
  customPrompt?: string;
  /** Tools to include in prompt. Default: [read, bash, edit, write, ask_user_question, todo] */
  selectedTools?: string[];
  /** Tool names explicitly excluded by the caller and omitted from generated guidance. */
  excludedTools?: string[];
  /** Optional one-line tool snippets keyed by tool name. */
  toolSnippets?: Record<string, string>;
  /** Additional guideline bullets appended to the default system prompt guidelines. */
  promptGuidelines?: string[];
  /** Text to append to system prompt. */
  appendSystemPrompt?: string;
  /** Working directory. */
  cwd: string;
  /** Currently selected model, used for model-aware prompt metadata. */
  selectedModel?: SystemPromptModel;
  /** Current reasoning/thinking level for the selected model. */
  selectedThinkingLevel?: string;
  /** Pre-loaded context files. */
  contextFiles?: Array<{ path: string; content: string }>;
  /** Pre-loaded skills. */
  skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    selectedTools,
    excludedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    selectedModel,
    selectedThinkingLevel,
    contextFiles: providedContextFiles,
    skills: providedSkills,
  } = options;
  const resolvedCwd = cwd;
  const promptCwd = resolvedCwd.replace(/\\/g, "/");

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const date = `${year}-${month}-${day}`;

  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
  const modelName =
    selectedModel?.name?.trim() || selectedModel?.id || "unknown";
  const modelReasoningLevel = selectedThinkingLevel?.trim() || "off";

  const contextFiles = providedContextFiles ?? [];
  const skills = providedSkills ?? [];
  const explicitlyExcludedTools = new Set(excludedTools ?? []);
  const isPromptToolAvailable = (name: string): boolean =>
    (!selectedTools || selectedTools.includes(name)) &&
    !explicitlyExcludedTools.has(name);

  if (customPrompt) {
    let prompt = customPrompt;

    if (appendSection) {
      prompt += appendSection;
    }

    // Append project context files
    if (contextFiles.length > 0) {
      prompt += "\n\n# Project Context\n\n";
      prompt += "Project-specific instructions and guidelines:\n\n";
      for (const { path: filePath, content } of contextFiles) {
        prompt += `<context_file path=\"${filePath}\">\n${content}\n</context_file>\n\n`;
      }
    }

    // Append skills section (only if read tool is available)
    if (isPromptToolAvailable("read") && skills.length > 0) {
      prompt += formatSkillsForPrompt(skills);
    }

    // Add model metadata, date, and working directory last
    prompt += `\nModel name (used for commit attribution): ${modelName}`;
    prompt += `\nModel reasoning level: ${modelReasoningLevel}`;
    prompt += `\nCurrent date: ${date}`;
    prompt += `\nCurrent working directory: ${promptCwd}`;

    return prompt;
  }

  // Get absolute paths to documentation and examples
  const readmePath = getReadmePath();
  const docsPath = getDocsPath();
  const examplesPath = getExamplesPath();

  // Build tools list based on selected tools.
  // A tool appears in Available tools only when the caller provides a one-line snippet.
  const tools = (selectedTools ?? DEFAULT_PROMPT_TOOLS).filter(
    (name) => !explicitlyExcludedTools.has(name),
  );
  const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools
          .map((name) => `- ${name}: ${toolSnippets![name]}`)
          .join("\n")
      : "(none)";

  // Build guidelines based on which tools are actually available
  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (guideline: string): void => {
    if (guidelinesSet.has(guideline)) {
      return;
    }
    guidelinesSet.add(guideline);
    guidelinesList.push(guideline);
  };

  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");
  const hasRead = tools.includes("read");

  // File exploration guidelines
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }

  for (const guideline of promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) {
      addGuideline(normalized);
    }
  }

  // Always include these
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  const askUserQuestionGuidance = explicitlyExcludedTools.has(
    "ask_user_question",
  )
    ? ""
    : "- Always ask clarifying questions if the user's request is ambiguous or lacks necessary details. NEVER make assumptions about what the user wants. If you find yourself circling in thought and asking what the user \"really\" wants, stop and ask the user for clarification using the ask_user_question tool if available. It's better to clarify intent rather than to guess.\n- **Asking the user is a strict requirement**: Whenever you need to ask the user anything — a clarification, a decision, a choice between options, a confirmation, or any yes/no question — you MUST ask it by calling the `ask_user_question` tool. Never pose a question to the user as plain assistant text. Every question you direct to the user goes through `ask_user_question`; writing the question in prose instead of calling the tool is not allowed.";
  const todoGuidance = explicitlyExcludedTools.has("todo")
    ? ""
    : "- **To-do management**: If the user has a complex task that can be broken down into actionable steps, use the `todo` tool to create a task list before proceeding. This ensures clarity and alignment with the user's goals and that you have a way to track your work and ensure you are meeting the user's expectations.";

  const subagentGuidance = explicitlyExcludedTools.has("subagent")
    ? ""
    : `- **Subagent Orchestration**:
  - To avoid draining your context window, prefer to use subagents for complex tasks all non-trivial operations should be delegated to subagents.
  - You should delegate running bash commands (particularly ones that are likely to produce lots of output) such as investigating with the \`aws\` CLI, using the \`gh\` CLI, digging through logs to \`bash\` subagents.
  - You should use separate subagents for separate tasks, and you may launch them in parallel, but do not delegate multiple tasks that are likely to have significant overlap to separate subagents.
  - Sometimes subagents will take a long time. DO NOT attempt to do the job yourself while waiting for the subagent to respond Instead, use the time to plan out your next steps.
  - **Debugging**: When a user asks about debugging, spawn a debugger subagent first.
    - Do not attempt to debug or analyze code yourself without first consulting the debugger subagent.
    - Explain the debugger's insights to the user clearly and concisely.
    - Once the user confirms, implement the necessary code changes based on those insights.
    - If the user has follow-up questions, spawn additional debugger and research subagents as needed.`;

  const workflowGuidance = explicitlyExcludedTools.has("workflow")
    ? ""
    : `- **Workflows**: Use the \`workflow\` tool for existing named workflows and for repeatable, inspectable, resumable, or multi-stage processes; use direct \`task\`, \`tasks\`, or \`chain\` workflow calls for one-off tracked work when that is useful.
  - For unfamiliar named workflows, discover with \`action: "list"\`, inspect with \`action: "get"\` or \`action: "inputs"\`, and run with \`action: "run"\`, \`workflow\`, and validated \`inputs\`; do not invent workflow names or input keys.
  - Once you run a workflow with the workflow tool, end your current turn and wait for the next user input or lifecycle notice.
    - You will automatically be alerted of key lifecycle events like start, finish, failure; do not attempt to track its progress yourself or read its logs or stages unless the user asks you to or you need to check in on it to get information for the next step.
    - If the user needs information from the workflow run, use \`status\`, \`stages\`, or \`stage\` calls to get targeted information instead of trying to read everything.
    - Offer to help the user on another task instead of anxiously polling or help the user run another workflow if they need.
    - Use run-control and messaging actions (\`send\`, \`pause\`, \`resume\`, \`interrupt\`, \`kill\`) only when needed to answer prompts, steer a stage, resume or interrupt paused work, or respond to user requests/control signals.
  - For transcripts, avoid reading whole session transcripts at once. Use \`stages\` or \`stage\` to get \`sessionFile\`/\`transcriptPath\`, quote the exact path without rewriting separators (preserve Windows backslashes), search it with \`rg\`/\`grep\`, and read small relevant ranges; use \`transcript\` with explicit \`tail\` or \`limit\` only for quick recent-context checks.
  - If a user asks to create or edit a workflow, use the create-spec skill when available and ask detailed clarifying questions until you understand its purpose, inputs, stages, handoffs, validation, and success criteria. Then read the workflow docs/examples and implement the workflow from the created spec directly as a TypeScript definition. After you implement the workflow, reload it to access it and run it with test inputs to validate it works as intended before presenting it to the user.
    - Tip: when designing workflows, implement it in a way that you pass information from stage to stage by writing it to a file or artifact (either deterministic or model-driven), pass the path with \`reads\`, and explicitly prompt the downstream agent with wording like \`Read the file at <path>...\`; do not inject large \`previous\` payloads or session history into the next prompt unless explicitly requested to.
  - If you run \`ralph\` or \`goal\` workflow, define an objective that includes tight scope, concrete and verifiable done criteria, and validation steps; then monitor progress as above instead of doing parallel implementation yourself.`;

  let prompt = `You are an expert coding assistant operating named Atomic, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}
${askUserQuestionGuidance}
${todoGuidance}
${subagentGuidance}
${workflowGuidance}

Atomic documentation (read only when the user asks about customizing Atomic itself, its SDK, creating workflows, packages, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- Docs/examples references above must be resolved against these absolute roots; e.g. docs/foo.md means ${docsPath}/foo.md and examples/bar means ${examplesPath}/bar.
- When asked about: atomic workflows (docs/workflows.md), extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), atomic packages (docs/packages.md)
- When working on Atomic topics, read the docs and examples, and follow .md cross-references before implementing
- Always read Atomic .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

  if (appendSection) {
    prompt += appendSection;
  }

  // Append project context files
  if (contextFiles.length > 0) {
    prompt += "\n\n# Project Context\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<context_file path=\"${filePath}\">\n${content}\n</context_file>\n\n`;
    }
  }

  // Append skills section (only if read tool is available)
  if (hasRead && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  // Add model metadata, date, and working directory last
  prompt += `\nModel name (used for commit attribution): ${modelName}`;
  prompt += `\nModel reasoning level: ${modelReasoningLevel}`;
  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;

  return prompt;
}
