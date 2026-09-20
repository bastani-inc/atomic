/**
 * System prompt construction and project context loading
 */

import { getSystemMessageText } from "@bastani/pi-ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

const DEFAULT_PROMPT_TOOLS = ["read", "bash", "edit", "write", "find", "search", "ask_user_question", "todo"] as const;

export interface SystemPromptModel {
	/** Provider identifier for the selected model. */
	provider: string;
	/** Stable provider-specific model identifier. */
	id: string;
	/** Human-readable model name, when available. */
	name?: string;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write, find, search, ask_user_question, todo] */
	selectedTools?: string[];
	/** Tool names explicitly excluded by the caller and omitted from generated guidance. */
	excludedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name. */
	sections?: Record<string, string>;
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

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
export type SystemPromptSections = Record<string, string>;

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? DEFAULT_PROMPT_TOOLS)],
		toolSnippets: { ...(input.toolSnippets ?? {}) },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...(input.sections ?? {}) },
		cwd: input.cwd,
		...(input.excludedTools === undefined ? {} : { excludedTools: [...input.excludedTools] }),
		...(input.selectedModel === undefined ? {} : { selectedModel: { ...input.selectedModel } }),
		...(input.selectedThinkingLevel === undefined ? {} : { selectedThinkingLevel: input.selectedThinkingLevel }),
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const tools = selectedTools;
	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const shouldIncludeAskUserFallbackGuidance = tools.length > 0 && !tools.includes("ask_user_question");
	const addGuideline = addRule;
	if ((hasBash || hasPowerShell) && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addRule("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addRule("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addRule("Use bash for file operations like ls, rg, find");
		}
	}
	if (shouldIncludeAskUserFallbackGuidance) {
		addGuideline(
			"If an equivalent user-question tool is available, use it for all questions to the user instead of plain text, including confirmations and approvals, following its supported schema. When no usable question tool or human-input channel exists, do not stall on a question: choose the interpretation best supported by the repository and the stated objective, state the assumption in your response, and continue fully autonomously on best judgment. Tool unavailability alone is not a blocker. Preserve safety and authorization constraints.",
		);
	}
	if (hasBash || hasPowerShell) {
		addGuideline(
			"**Repository intent**: When working in a repository, infer how its maintainers actually work before imposing defaults: review recent commits, open and merged PRs, issues and their comments, and project/board status when tooling allows (for example `git log` and the `gh` CLI) to learn conventions, priorities, and scope norms. Better, identify the requesting user (`git config user.name`/`user.email`, `gh api user`) and study their own commits, PRs, reviews, and issue comments so you interpret ambiguous requests the way they would, aligning style, scope, and process with their patterns.",
		);
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule(
		"Do not add code comments unless the user explicitly asks for them or the task instructions call for them; when a comment is warranted, explain non-obvious intent rather than restating what the code does",
	);
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		cwd,
		contextFiles,
		skills,
	} = options;
	const explicitlyExcludedTools = new Set(options.excludedTools ?? []);
	const tools = selectedTools.filter((name) => !explicitlyExcludedTools.has(name));
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();
	const modelName = options.selectedModel?.name?.trim() || options.selectedModel?.id || "unknown";
	const modelReasoningLevel = options.selectedThinkingLevel?.trim() || "off";
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

	for (const name of Object.keys(customSections)) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else {
		promptSections.preamble =
			"You are an expert coding assistant operating named Atomic, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const visibleTools = tools.filter((name) => !!toolSnippets[name]);
		const toolsList =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = `Available tools:\n${toolsList}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		promptSections.rules = `Guidelines:\n${buildRules(tools, toolGuidelines, promptGuidelines)}`;
		promptSections.docs = `
Atomic documentation (read when the user asks about model choice, computer use or automation, MCP, web access, intercom, subagents, or customizing Atomic itself, its SDK, creating workflows, packages, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- Docs/examples references above must be resolved against these absolute roots; e.g. docs/foo.md means ${docsPath}/foo.md and examples/bar means ${examplesPath}/bar.
- When asked about: atomic workflows (docs/workflows.md), extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), atomic packages (docs/packages.md)
- Bundled integrations use the same docs root in npm and binary installations: MCP servers (docs/mcp-servers.md), web access (docs/web-access.md), intercom (docs/intercom.md), subagents (docs/subagents.md), workflows (docs/workflows.md). Read these guides rather than guessing paths inside builtin packages.
- When the user asks which model to choose for a task, read ${docsPath}/models/model-selection.md and ${docsPath}/models/evals.md, then consult https://artificialanalysis.ai/ for the relevant benchmark charts and methodology. Match the task to individual evaluations rather than an aggregate winner. Cite the benchmark, source date, exact model/effort and cost or latency tradeoff; distinguish measured results from recommendations. If live evidence is unavailable, label the dated docs snapshot instead of claiming a refresh. Check the configured catalog before giving an exact provider/model or thinking setting; catalog presence is not proof of live access.
- For computer use (CUA), use PyAutoGUI for desktop mouse, keyboard and screenshot automation; for browser automation use the playwright-cli skill. For terminal automation/testing, prefer herdr on macOS, Linux and Windows; install it if missing when network access and permissions permit, and fall back to tmux or native Windows psmux if installation or use is not possible. Load the matching skill and ${docsPath}/workflows/verification.md. Preserve the pinned herdr skill's explicit-request and HERDR_ENV=1 requirements; never control a focused session from outside Herdr. Check installed capabilities, use dedicated sessions, preserve desktop failsafes and permissions, and release held input on interruption. These CLIs are not interchangeable, and skills do not grant tools or authorization.
- When working on Atomic topics, read the docs and examples, and follow .md cross-references before implementing
- Always read Atomic .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
	}

	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.model = `Model name (used for commit attribution): ${modelName}\nModel reasoning level: ${modelReasoningLevel}`;
	promptSections.date = `Current date: ${date}`;
	promptSections.cwd = `Current working directory: ${cwd.replace(/\\/g, "/")}`;
	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
	}

	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
