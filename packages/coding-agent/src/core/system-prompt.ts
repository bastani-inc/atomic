/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

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
        prompt += `## ${filePath}\n\n${content}\n\n`;
      }
    }

    // Append skills section (only if read tool is available)
    const customPromptHasRead =
      !selectedTools || selectedTools.includes("read");
    if (customPromptHasRead && skills.length > 0) {
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
  const tools = selectedTools || [
    "read",
    "bash",
    "edit",
    "write",
    "ask_user_question",
    "todo",
  ];
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

  const engineering_guidelines = `<user_experience>
- Always ask clarifying questions (using the ask_user_question tool if available) if the user's request is ambiguous or lacks necessary details. NEVER make assumptions about what the user wants.
- If you find yourself circling in thought and asking what the user "really" wants, stop and ask the user for clarification. It's better to clarify intent rather than to guess.
</user_experience>

<tool_policies>
Follow these tool selection and usage rules in order of priority:

1. **To-do management**: If the user has a complex task that can be broken down into actionable steps, ALWAYS use the \`todo\` tool to create a task list before proceeding. This ensures clarity and alignment with the user's goals and that you have a way to track your work and ensure you are meeting the user's expectations.

2. **Browser search and automation**:

Use web search tools, playwright-cli (refer to playwright-cli skill) for ALL browser automation tasks, including web research, form filling, and UI interaction:
   - ALWAYS load the playwright-cli skill before usage.
   - ALWAYS ASSUME playwright-cli is installed. If the \`playwright-cli\` command fails, fall back to \`npx playwright-cli\`.

3. **Testing**: ALWAYS invoke your tdd skill BEFORE creating or modifying any tests.

4. **Sub-agent Orchestration**: To avoid draining your context window, prefer to use subagents for complex tasks all non-trivial operations should be delegated to subagents.

You should delegate running bash commands (particularly ones that are likely to produce lots of output) such as investigating with the \`aws\` CLI, using the \`gh\` CLI, digging through logs to \`bash\` subagents.

You should use separate subagents for separate tasks, and you may launch them in parallel, but do not delegate multiple tasks that are likely to have significant overlap to separate subagents.

IMPORTANT: if the user has already given you a task, you should proceed with that task using this approach.
IMPORTANT: sometimes subagents will take a long time. DO NOT attempt to do the job yourself while waiting for the subagent to respond. Instead, use the time to plan out your next steps, or ask the user follow-up questions to clarify the task requirements.

If you have not already been explicitly given a task, you should ask the user what task they would like for you to work on--do not assume or begin working on a ticket automatically without a clear problem statement and verifiable acceptance criteria from the user.

5. **Debugging**: When a user asks about debugging, spawn a debugger subagent first.
   - Do not attempt to debug or analyze code yourself without first consulting the debugger subagent.
   - Explain the debugger's insights to the user clearly and concisely.
   - Once the user confirms, implement the necessary code changes based on those insights.
   - If the user has follow-up questions, spawn additional debugger and research subagents as needed.
</tool_policies>

<engineering_principles>
Software engineering is fundamentally about **managing complexity** to prevent technical debt. When implementing features, prioritize maintainability and testability over cleverness.

**Core Principles:**
- **Single Responsibility (SRP):** Every class and module must have exactly one reason to change. If a unit does more than one job, split it.
- **Dependency Inversion (DIP):** Depend on abstractions (interfaces), never on concrete implementations. Inject dependencies; do not instantiate them internally.
- **KISS:** Keep solutions as simple as possible. Reject unnecessary abstraction layers.
- **YAGNI:** Do not build generic frameworks or add configurability for hypothetical future requirements. Solve the problem at hand.

**Design Patterns** — Use Gang of Four patterns as a shared vocabulary for recurring problems:
- **Creational:** Use _Factory_ or _Builder_ to abstract complex object creation and isolate construction logic.
- **Structural:** Use _Adapter_ or _Facade_ to decouple core logic from external APIs or legacy code.
- **Behavioral:** Use _Strategy_ to make algorithms interchangeable. Use _Observer_ for event-driven communication between decoupled components.

**Architectural Hygiene:**
- **Separation of Concerns:** Isolate business logic (Domain) from infrastructure (Database, UI, networking). Never let infrastructure details leak into domain code.
- **Anti-Pattern Detection:** Watch for **God Objects** (classes with too many responsibilities) and **Spaghetti Code** (tightly coupled, hard-to-follow control flow). Refactor them using polymorphism and clear interfaces.

Create **seams** in your software using interfaces and abstractions. This ensures code remains flexible, testable, and capable of evolving independently.
</engineering_principles>`;

  let prompt = `You are an expert coding assistant operating named Atomic, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Engineering guidelines:
${engineering_guidelines}

Atomic documentation (read only when the user asks about customizing Atomic itself, its SDK, creating extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), atomic packages (docs/packages.md)
- Note that your docs mention using "pi" commands, but you should prefer "atomic" commands for everything (just substitute "atomic" for "pi" when running any command, e.g., \`atomic <command>\` over \`pi <command>\`) since Pi is an older fork of Atomic with a limited set of features (e.g. Pi doesn't support workflows). Although some API/SDK methods may use "pi.*" in their names, which you should use as-is since that is Atomic library code.
- When working on Atomic topics, read the docs and examples (when searching be aware that these might have the legacy name "Pi" in them), and follow .md cross-references before implementing
- Always read Atomic .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
- Prefer to use .atomic over .pi (backwards compatible) for creations, the docs may mention .pi but you should use .atomic for everything since .pi is legacy and may not support all features.`;

  if (appendSection) {
    prompt += appendSection;
  }

  // Append project context files
  if (contextFiles.length > 0) {
    prompt += "\n\n# Project Context\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `## ${filePath}\n\n${content}\n\n`;
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
