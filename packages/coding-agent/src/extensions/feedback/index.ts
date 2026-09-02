import { arch, platform } from "node:os";
import { VERSION } from "../../config.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../../core/extensions/index.ts";
import type { SessionEntry } from "../../core/session-manager-types.ts";
import { FeedbackInvestigationController, INVESTIGATION_UNAVAILABLE } from "./investigation.js";
import { createGitHubFeedbackPostHandler } from "./posting.js";
import type { FeedbackPostHandler } from "./preview.js";
import { createFeedbackSubmissionTool, prepareModelUnavailableFallback, runFeedbackInteraction } from "./submission.js";
import {
	captureWorkingTreeSnapshot,
	compareWorkingTreeSnapshots,
	formatWorkingTreeDisclosure,
	type WorkingTreeSnapshot,
} from "./working-tree.js";

export const FEEDBACK_USAGE = "Usage: /feedback <what happened or what you would like changed>";

export interface FeedbackRuntimeFacts {
	version: string;
	platform: string;
	architecture: string;
	runtime: string;
}

export interface FeedbackSessionFacts extends FeedbackRuntimeFacts {
	mode: ExtensionCommandContext["mode"];
	provider: string;
	model: string;
	nonBuiltinExtensionsLoaded: boolean;
	recentFailedOutcomes: string[];
	sessionErrorState: "none" | "present";
}

interface ActiveFeedbackInvestigation {
	cwd: string;
	before: WorkingTreeSnapshot;
	controller: FeedbackInvestigationController;
	prompt: string;
	facts: FeedbackSessionFacts;
	phase: "initial" | "awaiting-clarification" | "clarification" | "retained-uncertain";
}

interface FeedbackExtensionState {
	activeInvestigation?: ActiveFeedbackInvestigation;
}

export interface FeedbackExtensionOptions {
	post?: FeedbackPostHandler;
	createRequestId?: () => string;
}

function currentRuntimeFacts(): FeedbackRuntimeFacts {
	const bunVersion = process.versions.bun;
	return {
		version: VERSION,
		platform: platform(),
		architecture: arch(),
		runtime: bunVersion ? `Bun ${bunVersion}` : `Node ${process.version}`,
	};
}

function safeToolName(name: string): string | undefined {
	return /^[A-Za-z0-9_.:-]{1,64}$/.test(name) ? name : undefined;
}

function failedOutcome(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const { message } = entry;
	if (message.role === "toolResult" && message.isError) {
		const name = safeToolName(message.toolName);
		return name ? `Tool ${name} failed` : "Tool failed";
	}
	if (message.role === "assistant" && message.stopReason === "error") return "Provider response failed";
	if (message.role !== "bashExecution" || (!message.cancelled && (message.exitCode ?? 0) === 0)) return undefined;
	return message.cancelled ? "Shell command was cancelled" : `Shell command failed (${message.exitCode})`;
}

function collectRecentFailedOutcomes(ctx: ExtensionCommandContext): {
	outcomes: string[];
	sessionErrorState: "none" | "present";
} {
	const outcomes = ctx.sessionManager
		.getEntries()
		.slice(-20)
		.map(failedOutcome)
		.filter((outcome): outcome is string => outcome !== undefined)
		.slice(-5);
	return { outcomes, sessionErrorState: outcomes.length === 0 ? "none" : "present" };
}

export function collectFeedbackSessionFacts(
	ctx: ExtensionCommandContext,
	runtimeFacts: FeedbackRuntimeFacts = currentRuntimeFacts(),
): FeedbackSessionFacts {
	const failures = collectRecentFailedOutcomes(ctx);
	return {
		...runtimeFacts,
		mode: ctx.mode,
		provider: ctx.model?.provider ?? "not selected",
		model: ctx.model?.id ?? "not selected",
		nonBuiltinExtensionsLoaded: ctx.hasNonBuiltinExtensions,
		recentFailedOutcomes: failures.outcomes,
		sessionErrorState: failures.sessionErrorState,
	};
}

export function buildFeedbackTurnMessage(
	prompt: string,
	facts: FeedbackSessionFacts,
	debuggerToolAvailable = true,
): string {
	const failedOutcomes =
		facts.recentFailedOutcomes.length > 0
			? facts.recentFailedOutcomes.map((outcome) => `- ${outcome}`).join("\n")
			: "- None";
	const debuggerInstruction = debuggerToolAvailable
		? "For a bug, launch exactly one foreground run of the existing bundled debugger through the subagent tool with no model override."
		: `The debugger tool is disabled. For a bug, keep the original report in an editable draft marked exactly "${INVESTIGATION_UNAVAILABLE}".`;
	return `Handle this Atomic feedback request as one ordinary in-session model turn.

Classify it as a bug or enhancement. Ask one concise clarification only if classification or a required issue field is genuinely unresolved. ${debuggerInstruction} For an enhancement, do not launch the debugger. For visual feedback, use only a clearly labelled sanitized textual reconstruction with precise expected-versus-observed text; never claim that reconstruction is a captured screenshot or observed evidence. Do not attach a debugger transcript, raw trace, environment dump, repository file, screenshot, or diagnostic artifact. Do not launch a workflow, create or customize an agent, start a repair loop, or post to GitHub directly. Call submit_feedback with the exact template-shaped fields; it alone owns privacy review, editing, confirmation, and posting.

Safe current-session facts:
- Atomic version: ${facts.version}
- OS: ${facts.platform}
- Architecture: ${facts.architecture}
- Runtime: ${facts.runtime}
- Session mode: ${facts.mode}
- Provider: ${facts.provider}
- Model: ${facts.model}
- Non-builtin extensions loaded: ${facts.nonBuiltinExtensionsLoaded ? "yes" : "no"}
- Session error state: ${facts.sessionErrorState}
- Recent failed outcomes:
${failedOutcomes}

The user's feedback text follows verbatim after this line:
${prompt}`;
}

async function showModelUnavailableFallback(
	ctx: ExtensionContext,
	request: ActiveFeedbackInvestigation,
	post: FeedbackPostHandler,
	createRequestId?: () => string,
): Promise<void> {
	ctx.ui.notify("The selected model is unavailable. Preparing an editable fallback draft.", "warning");
	if (!ctx.hasUI) {
		ctx.ui.setEditorText(request.prompt);
		return;
	}
	const selection = await ctx.ui.select("Feedback type", ["Bug", "Enhancement"]);
	if (selection === undefined) return;
	const kind = selection === "Bug" ? "bug" : "enhancement";
	const preview = prepareModelUnavailableFallback(request.prompt, request.facts, kind);
	await runFeedbackInteraction(ctx, preview, post, { createRequestId });
}
function registerFeedbackSubmissionTool(
	pi: ExtensionAPI,
	state: FeedbackExtensionState,
	post: FeedbackPostHandler,
	options: FeedbackExtensionOptions,
): void {
	pi.registerTool(
		createFeedbackSubmissionTool({
			getInvestigation: () => state.activeInvestigation?.controller,
			post,
			createRequestId: options.createRequestId,
			onRetainedUncertainty: () => {
				const active = state.activeInvestigation;
				if (active !== undefined) active.phase = "retained-uncertain";
			},
			onTerminal: () => {
				state.activeInvestigation = undefined;
			},
		}),
	);
}

function handleFeedbackToolCall(state: FeedbackExtensionState, event: ToolCallEvent): ToolCallEventResult | undefined {
	const active = state.activeInvestigation;
	if (active === undefined || event.toolName === "submit_feedback") return undefined;
	if (event.toolName === "subagent") {
		return active.controller.handleSubagentCall(event.toolCallId, event.input);
	}
	return {
		block: true,
		reason:
			"Only submit_feedback and the admitted foreground debugger are allowed during an active feedback request.",
	};
}

async function handleFeedbackToolResult(
	pi: ExtensionAPI,
	state: FeedbackExtensionState,
	event: ToolResultEvent,
): Promise<ToolResultEventResult | undefined> {
	const active = state.activeInvestigation;
	if (event.toolName !== "subagent" || active === undefined) return undefined;
	const matchedDebugger = active.controller.handleSubagentResult(
		event.toolCallId,
		event.isError ? "failed" : "completed",
	);
	if (!matchedDebugger) return undefined;
	const after = await captureWorkingTreeSnapshot(active.cwd, pi.exec.bind(pi));
	const disclosure = compareWorkingTreeSnapshots(active.before, after);
	active.controller.setWorkingTreeDisclosure(disclosure);
	const disclosureContent = { type: "text" as const, text: formatWorkingTreeDisclosure(disclosure) };
	return event.isError
		? {
				content: [{ type: "text" as const, text: INVESTIGATION_UNAVAILABLE }, disclosureContent],
				isError: true,
			}
		: { content: [...event.content, disclosureContent] };
}

function registerFeedbackSubagentHooks(pi: ExtensionAPI, state: FeedbackExtensionState): void {
	pi.on("tool_call", (event) => handleFeedbackToolCall(state, event));
	pi.on("tool_result", (event) => handleFeedbackToolResult(pi, state, event));
}

function registerFeedbackLifecycleHook(
	pi: ExtensionAPI,
	state: FeedbackExtensionState,
	post: FeedbackPostHandler,
	options: FeedbackExtensionOptions,
): void {
	pi.on("before_agent_start", () => {
		const active = state.activeInvestigation;
		if (active?.phase === "awaiting-clarification") active.phase = "clarification";
	});
	pi.on("agent_end", async (event, ctx) => {
		const active = state.activeInvestigation;
		if (active === undefined) return;
		const assistantMessages = event.messages.filter((message) => message.role === "assistant");
		const modelFailed = assistantMessages.some((message) => message.stopReason === "error");
		const interrupted =
			assistantMessages.length === 0 || assistantMessages.some((message) => message.stopReason === "aborted");
		if (active.phase === "retained-uncertain") return;
		if (modelFailed || interrupted || active.phase === "clarification") {
			state.activeInvestigation = undefined;
		}
		if (modelFailed) await showModelUnavailableFallback(ctx, active, post, options.createRequestId);
		else if (!interrupted && active.phase === "initial") active.phase = "awaiting-clarification";
	});
}

function registerFeedbackCommand(
	pi: ExtensionAPI,
	state: FeedbackExtensionState,
	post: FeedbackPostHandler,
	options: FeedbackExtensionOptions,
): void {
	pi.registerCommand("feedback", {
		description: "Draft and review an Atomic bug report or enhancement",
		handler: async (args, ctx) => {
			if (args.trim().length === 0) {
				ctx.ui.notify(FEEDBACK_USAGE, "info");
				return;
			}
			const facts = collectFeedbackSessionFacts(ctx);
			const before = await captureWorkingTreeSnapshot(ctx.cwd, pi.exec.bind(pi));
			const debuggerToolAvailable = pi.getActiveTools().includes("subagent");
			state.activeInvestigation = {
				cwd: ctx.cwd,
				prompt: args,
				facts,
				before,
				controller: new FeedbackInvestigationController({
					prompt: args,
					facts,
					debuggerToolAvailable,
					protectedPaths: before.entries.map((entry) => entry.path),
				}),
				phase: "initial",
			};
			try {
				await pi.sendUserMessage(buildFeedbackTurnMessage(args, facts, debuggerToolAvailable));
			} catch {
				const request = state.activeInvestigation;
				state.activeInvestigation = undefined;
				if (request !== undefined) {
					await showModelUnavailableFallback(ctx, request, post, options.createRequestId);
				}
			}
		},
	});
}

function registerFeedbackExtension(pi: ExtensionAPI, options: FeedbackExtensionOptions): void {
	const state: FeedbackExtensionState = {};
	const post = options.post ?? createGitHubFeedbackPostHandler({ exec: pi.exec.bind(pi) });
	registerFeedbackSubmissionTool(pi, state, post, options);
	registerFeedbackSubagentHooks(pi, state);
	registerFeedbackLifecycleHook(pi, state, post, options);
	registerFeedbackCommand(pi, state, post, options);
}

export function createFeedbackExtension(options: FeedbackExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => registerFeedbackExtension(pi, options);
}

export default function feedbackExtension(pi: ExtensionAPI): void {
	registerFeedbackExtension(pi, {});
}
