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
		addGuideline(
			[
				"**Execution history**: Leave a mineable record of how each task was executed and what the user prefers, and mine those records to calibrate later work. The records only accumulate value if every task writes them. If the user, a context file, or `APPEND_SYSTEM.md` asks you not to record some or all of these records, skip those records.",
				"  - When you author a commit, PR, issue, or issue/review comment for a task, record how it ran: `Assistant-workflow: <workflow name> (run <runId>)` for a registered or custom workflow, or `Assistant-workflow: inline` when no workflow was used; and `Assistant-duration: <elapsed> <converged|blocked|abandoned>, estimated <estimate>` (for example `Assistant-duration: 42m converged, estimated 30m`), measuring wall-clock time from launch or task start until acceptance was proven or work stopped, including resumes and repair rounds. Take elapsed time from workflow status timing or timestamps you recorded (for example `date` at task start); write `unmeasured` rather than guess. Put these as trailers alongside `Assistant-model` in commits (git trailers, or the equivalent commit-message metadata in the repository's version control system) and as the same `Key: value` lines in PR/merge request, issue, and comment bodies. For multi-commit work, record the workflow on each commit and the final duration once, in the last commit or the PR body.",
				"  - In the same artifacts, record how the result was verified with one `Assistant-verification: <method> <passed|failed|unavailable>: <what it proved or why>` line per method that actually ran or was attempted (for example `Assistant-verification: herdr terminal E2E passed: /tasks lists running tasks first at 80x24`, `Assistant-verification: vitest unit passed: npm run test:unit`, or `Assistant-verification: cua-driver unavailable: Accessibility permission not granted`). Name the concrete mechanism, such as unit, integration, or E2E tests, agent-browser, Cua Driver, herdr or tmux terminal automation, the qlty CLI, typecheck or lint, or a manual scenario, and the command or scenario it exercised. Record only checks that ran and their observed outcome; never record a skipped, mocked, or planned check as passed.",
				"  - When the user states or reveals a durable preference about how they work (a correction, a rejected approach, scope, review, tooling, or communication style), record it in the same artifacts as `User-preference: <one line, in the user's terms>`, and tie it to the requesting user with a `Co-authored-by: <name> <email>` trailer taken from their version control identity (for example `git config user.name`/`user.email`) unless that line is already present; in PR, issue, and comment bodies, add the same line or their hosting account (for example from `gh api user`). Record only what the user expressed or their own edits show; never record secrets, credentials, or personal details unrelated to the work. If repository rules restrict commit or PR formats, fit the records into what they allow.",
				"  - Before choosing between a workflow and inline work, choosing how to verify a change, estimating a duration, or interpreting an ambiguous request, mine these records with the rest of the history using the repository's version control system and its hosting CLI, for example `git log --format='%h %an <%ae> %s%n%(trailers:key=Assistant-workflow,key=Assistant-duration,key=Assistant-verification,key=User-preference,key=Co-authored-by)'` with `gh pr list --state all --search 'Assistant-workflow in:body'` on GitHub, or the equivalent commands for other systems and hosts (for example `glab` on GitLab). Compare tasks of similar kind and size, and state the sample size with the median and range. Treat fewer than five comparable records as anecdotal, and prefer the more recent record when two conflict. When choosing verification, start from the methods that proved comparable changes (the same files, subsystem, or kind of change), reuse their commands and scenarios, and do not retry a setup recorded as `unavailable` without a reason to expect a different result; past records never replace the project's required checks. Prioritize preferences tied to the requesting user by their co-author line, commit author, or hosting account. When the user has none that cover the situation, fall back to other contributors' relevant preferences as repository conventions; the user's own records and current request override them, so users can always encode their own preference. This history is a guide, not the decision: the current request, the task itself, and explicit user instructions decide between a workflow and inline work.",
			].join("\n"),
		);
	}

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	addRule(
		"Write self-describing code and do not add comments unless the user explicitly asks for them or the task instructions call for them. Code that needs a comment to be understood is a smell: restructure it with clearer names, smaller units, or explicit types instead",
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
- For computer use (CUA) on desktop apps, simulators and emulators, use Cua Driver through the bundled cua-driver skill and one-shot \`cua-driver call <tool>\` commands: when a model chooses the next action (interactive sessions or any workflow stage acting outside ctx.tool), use the CLI; when workflow TypeScript code owns the sequence and postcondition, use the @trycua/cua-driver TypeScript SDK inside ctx.tool. If \`cua-driver --version\` fails, make one bounded attempt with upstream's one-line executable installer and report its side effects. The executable installer does not install an agent skill; ignore upstream README's optional skill-install steps, never run \`cua-driver skills install\` or \`clawhub install @cua/driver\`, and do not link or copy a skill into \`~/.agents/skills/cua-driver\`. Atomic already bundles it; leave any existing user-level skill alone. Run every cua-driver command with CUA_DRIVER_RS_TELEMETRY_ENABLED=false and follow ${docsPath}/computer-use.md for install, readiness and permissions. Prefer the agent-browser skill for what it covers: websites and web apps in Chrome/Chromium, Electron desktop apps such as VS Code, Slack, Discord, Figma, Notion and Spotify, Slack workspaces, and cloud browsers. Use cua-driver for everything else (native desktop apps, iOS simulators, Android emulators, OS dialogs and permission prompts, non-Chromium browsers) and whenever agent-browser hits a limitation. For terminal automation/testing, prefer herdr on macOS, Linux and Windows; install it if missing when network access and permissions permit, and fall back to tmux or native Windows psmux if installation or use is not possible. Load the matching skill and ${docsPath}/workflows/verification.md. Preserve the pinned herdr skill's explicit-request and HERDR_ENV=1 requirements; never control a focused session from outside Herdr. Check installed capabilities, use dedicated sessions, respect desktop permissions, and stop before destructive actions. These CLIs are not interchangeable, and skills do not grant tools or authorization.
- Also skip \`cua-driver skills update\` and any skill installation into other agent directories such as \`~/.claude/skills\`; updating the executable is separate from installing or updating a skill.
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
