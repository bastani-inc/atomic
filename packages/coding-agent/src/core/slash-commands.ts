import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { APP_NAME } from "../config.ts";
import {
	ATOMIC_GUIDE_COMMAND_DESCRIPTION,
	ATOMIC_GUIDE_COMMAND_NAME,
	getAtomicGuideArgumentCompletions,
} from "./atomic-guide-command.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	getArgumentCompletions?: (
		argumentPrefix: string,
	) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
}

type WorkflowInputCompletionMetadata = {
	description: string;
	kind?: "boolean" | "number" | "string";
};

type WorkflowCompletionMetadata = {
	name: string;
	description: string;
	inputs: Record<string, WorkflowInputCompletionMetadata>;
};

const WORKFLOW_ADMIN_COMPLETIONS: AutocompleteItem[] = [
	{ value: "connect ", label: "connect", description: "Attach to a run (picker if no id)" },
	{ value: "attach ", label: "attach", description: "Open the in-place attach pane on a node" },
	{ value: "list ", label: "list", description: "List registered workflows" },
	{ value: "status ", label: "status", description: "List current-session active and retained terminal runs" },
	{ value: "interrupt ", label: "interrupt", description: "Interrupt a run" },
	{ value: "kill ", label: "kill", description: "Kill and retain a run" },
	{ value: "pause ", label: "pause", description: "Pause a run or stage" },
	{ value: "resume ", label: "resume", description: "Re-open overlay for a run" },
	{ value: "inputs ", label: "inputs", description: "Show a workflow's input schema" },
	{ value: "reload ", label: "reload", description: "Reload workflow resources" },
];

const BUNDLED_WORKFLOW_COMPLETION_METADATA: WorkflowCompletionMetadata[] = [
	{
		name: "deep-research-codebase",
		description: "Scout + research-history chain → parallel specialist waves → aggregator for deep codebase research.",
		inputs: {
			prompt: { description: "Research question or investigation focus for the codebase.", kind: "string" },
			max_partitions: { description: "Maximum number of codebase partitions to explore in parallel.", kind: "number" },
			max_concurrency: { description: "Maximum number of workflow stages to run concurrently during deep research.", kind: "number" },
		},
	},
	{
		name: "goal",
		description: "Goal Runner workflow with bounded LM turns, acceptance criteria, ledger artifacts, reviewers, and reducer-gated completion.",
		inputs: {
			objective: { description: "The objective or delta for this Goal Runner workflow run.", kind: "string" },
			acceptance_criteria: { description: "Original immutable task contract this run must remain consistent with.", kind: "string" },
			max_turns: { description: "Maximum worker/review turns before Goal Runner stops as needs_human.", kind: "number" },
			base_branch: { description: "Optional branch reviewers compare the current code delta against.", kind: "string" },
			git_worktree_dir: { description: "Optional Git worktree path.", kind: "string" },
			create_pr: { description: "Whether to run the final pull-request creation stage after approval.", kind: "boolean" },
		},
	},
	{
		name: "open-claude-design",
		description: "AI-powered design workflow: discovery, reference research, HTML generation, refinement, and handoff.",
		inputs: {
			prompt: { description: "What to design, such as a dashboard, page, component, or prototype.", kind: "string" },
			discover_references: { description: "Discover current reference designs and feed them to generation.", kind: "boolean" },
			max_refinements: { description: "Maximum generate/user-feedback loop iterations.", kind: "number" },
		},
	},
	{
		name: "ralph",
		description: "Raw prompt → research → orchestrate → multi-model parallel review loop with bounded iteration.",
		inputs: {
			prompt: { description: "The task or goal to research, execute, and refine.", kind: "string" },
			acceptance_criteria: { description: "Original immutable task contract this run must remain consistent with.", kind: "string" },
			max_loops: { description: "Maximum research/orchestrate/review iterations.", kind: "number" },
			base_branch: { description: "Branch reviewers compare the current code delta against.", kind: "string" },
			git_worktree_dir: { description: "Optional Git worktree path.", kind: "string" },
			create_pr: { description: "Whether to run the final pull-request creation stage.", kind: "boolean" },
		},
	},
];

function completeWorkflowToken(argumentText: string, candidates: AutocompleteItem[]): AutocompleteItem[] | null {
	const tokenStart = /\s$/.test(argumentText)
		? argumentText.length
		: Math.max(argumentText.lastIndexOf(" "), argumentText.lastIndexOf("\t")) + 1;
	const head = argumentText.slice(0, tokenStart);
	const token = argumentText.slice(tokenStart);
	const normalizedToken = token.trimEnd();
	const filtered = candidates
		.filter((candidate) => candidate.value.startsWith(token) && candidate.value.trimEnd() !== normalizedToken)
		.map((candidate) => ({ ...candidate, value: `${head}${candidate.value}` }));
	return filtered.length > 0 ? filtered : null;
}

function bundledWorkflowNameItems(): AutocompleteItem[] {
	return BUNDLED_WORKFLOW_COMPLETION_METADATA.map((workflow) => ({
		value: `${workflow.name} `,
		label: workflow.name,
		description: `Run workflow: ${workflow.name}`,
	}));
}

export function getBundledWorkflowArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const parts = argumentPrefix.trim().split(/\s+/).filter(Boolean);
	const subcommand = parts[0] ?? "";
	const workflowItems = bundledWorkflowNameItems();
	if (!argumentPrefix.includes(" ")) {
		return completeWorkflowToken(argumentPrefix, [...WORKFLOW_ADMIN_COMPLETIONS, ...workflowItems]);
	}
	if (subcommand === "inputs") return completeWorkflowToken(argumentPrefix, workflowItems);
	if (subcommand === "interrupt" || subcommand === "kill") {
		const verb = subcommand === "kill" ? "Kill and retain" : "Interrupt";
		return completeWorkflowToken(argumentPrefix, [
			{ value: "--all ", label: "--all", description: `${verb} all in-flight runs` },
			{ value: "--yes ", label: "--yes", description: "Skip confirmation" },
			{ value: "-y ", label: "-y", description: "Skip confirmation" },
		]);
	}
	if (!subcommand) return completeWorkflowToken(argumentPrefix, [...WORKFLOW_ADMIN_COMPLETIONS, ...workflowItems]);

	const workflow = BUNDLED_WORKFLOW_COMPLETION_METADATA.find((candidate) => candidate.name === subcommand);
	if (!workflow) return null;
	const tokenStart = /\s$/.test(argumentPrefix)
		? argumentPrefix.length
		: Math.max(argumentPrefix.lastIndexOf(" "), argumentPrefix.lastIndexOf("\t")) + 1;
	const token = argumentPrefix.slice(tokenStart);
	const equalsIndex = token.indexOf("=");
	if (equalsIndex > 0) {
		const inputName = token.slice(0, equalsIndex);
		const input = workflow.inputs[inputName];
		if (input?.kind !== "boolean") return null;
		return completeWorkflowToken(argumentPrefix, [
			{ value: `${inputName}=true `, label: "true", description: inputName },
			{ value: `${inputName}=false `, label: "false", description: inputName },
		]);
	}

	return completeWorkflowToken(argumentPrefix, [
		{ value: "--no-picker ", label: "--no-picker", description: "Skip interactive input picker" },
		{ value: "--help ", label: "--help", description: "Show this workflow's input schema" },
		...Object.entries(workflow.inputs).map(([name, input]) => ({
			value: `${name}=`,
			label: name,
			description: input.description,
		})),
	]);
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for ctrl+p cycling" },
	{ name: "fast", description: "Configure Codex fast mode for chat and workflows" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{
		name: ATOMIC_GUIDE_COMMAND_NAME,
		description: ATOMIC_GUIDE_COMMAND_DESCRIPTION,
		getArgumentCompletions: getAtomicGuideArgumentCompletions,
	},
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Compact context with verbatim logical deletions" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "exit", description: `Exit ${APP_NAME}` },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

export const BUNDLED_EXTENSION_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "workflow",
		description: "Run or inspect Atomic workflows. Usage: /workflow <name> [key=value…] | /workflow [list|status|connect|attach|interrupt|kill|pause|resume|inputs|reload] [args]",
		getArgumentCompletions: getBundledWorkflowArgumentCompletions,
	},
	{ name: "run", description: "Run a subagent directly: /run agent[output=file] [task] [--bg] [--fork]" },
	{ name: "chain", description: "Run agents in sequence: /chain scout task -> planner [--bg] [--fork]" },
	{ name: "run-chain", description: "Run a saved chain: /run-chain chainName -- task [--bg] [--fork]" },
	{ name: "parallel", description: "Run agents in parallel: /parallel scout task1 -> reviewer task2 [--bg] [--fork]" },
	{ name: "subagents-doctor", description: "Show subagent diagnostics" },
	{ name: "mcp", description: "Show MCP server status" },
	{ name: "mcp-auth", description: "Authenticate with an MCP server (OAuth)" },
	{ name: "curator", description: "Toggle or configure the search curator workflow" },
	{ name: "google-account", description: "Show the active Google account for Gemini Web" },
	{ name: "search", description: "Browse stored web search results" },
	{ name: "websearch", description: "Open web search curator" },
	{ name: "intercom", description: "Open session intercom overlay" },
];
