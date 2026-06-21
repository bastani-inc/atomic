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
  const shouldIncludeAskUserFallbackGuidance =
    selectedTools !== undefined &&
    tools.length > 0 &&
    !tools.includes("ask_user_question") &&
    !explicitlyExcludedTools.has("ask_user_question");

  // File exploration guidelines
  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  }
  if (shouldIncludeAskUserFallbackGuidance) {
    addGuideline("Clarify ambiguous requirements using the ask_user_question tool if available.");
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

  let prompt = `You are an expert coding assistant operating named Atomic, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}
- Prefer using your effective-liteparse skill in case you need to work with PDFs

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
