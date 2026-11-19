import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocsPath, keyHintIfBound, ToolBlock, ToolBlockMarkdown } from "@bastani/atomic";
import { stripTerminalSequences, Text } from "@bastani/atomic-tui";
import { summarizeFailureText } from "../tui/display-text.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { invalidDefinitionsFromDiagnostics } from "../tui/workflows-listing.js";
import type { DiscoveryDiagnostic } from "./discovery.js";
import type { ExtensionAPI, PiCommandContext } from "./public-types.js";
import { completeToken, runIdItems } from "./workflow-command-completions.js";
import {
	createWorkflowCommandReporter,
	registerWorkflowCommand,
	type WorkflowCommandHandler,
} from "./workflow-command-utils.js";
import { handleWorkflowsCommand } from "./workflow-open-run.js";
import { captureWorkflowOwnerResources, type WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";

export const WORKFLOWS_COMMAND_DESCRIPTION = "Browse running and completed workflows";
export const WORKFLOW_AUTHORING_COMMAND_DESCRIPTION = "Load the reference for writing workflow definitions";
export const WORKFLOW_AUTHORING_CUSTOM_TYPE = "workflows:authoring-reference";
export const REMOVED_WORKFLOW_COMMAND_NOTICE =
	"! /workflow was removed · use /workflows, /resume or ask the agent to run a workflow";

export interface WorkflowSlashCommandDeps {
	overlay: GraphOverlayPort;
	owner?: WorkflowOwnerResources;
	ensureWorkflowResourcesLoaded?: () => Promise<void>;
	discoveryDiagnostics?: () => readonly DiscoveryDiagnostic[];
	restoreSessionRuns?: (ctx: PiCommandContext) => Promise<void>;
}

function authoringHeaderTitle(): string {
	const hint = keyHintIfBound("app.tools.expand", "to expand");
	return `Loaded workflow authoring reference${hint ? ` (${hint})` : ""}`;
}

export function formatWorkflowAuthoringCollapsedLine(): string {
	return `› ${stripTerminalSequences(authoringHeaderTitle())}`;
}

const authoringRendererRegisteredHosts = new WeakSet<object>();

export function registerWorkflowAuthoringMessageRenderer(pi: ExtensionAPI): void {
	if (authoringRendererRegisteredHosts.has(pi)) return;
	const register = pi.registerMessageRenderer;
	if (typeof register !== "function") return;
	register.call(pi, WORKFLOW_AUTHORING_CUSTOM_TYPE, (raw, options) => {
		const message = raw as { content?: unknown } | undefined;
		const content = typeof message?.content === "string" ? message.content : "";
		const expanded = options?.expanded === true;
		return new ToolBlock({
			status: "info",
			title: new Text(authoringHeaderTitle(), 0, 0),
			...(expanded && content.length > 0 ? { body: new ToolBlockMarkdown(content) } : {}),
		});
	});
	authoringRendererRegisteredHosts.add(pi);
}

function readWorkflowAuthoringReference(): Promise<string> {
	return readFile(join(getDocsPath(), "workflows", "authoring.md"), "utf8");
}

function safeErrorReason(error: unknown): string {
	return summarizeFailureText(error instanceof Error ? error.message : String(error)).reason;
}

async function handleWorkflowAuthoringCommand(args: string, ctx: PiCommandContext, pi: ExtensionAPI): Promise<void> {
	const reporter = createWorkflowCommandReporter(ctx, workflowPolicyFromContext(ctx), pi);
	const request = args.trim();
	if (typeof pi.sendMessage !== "function") {
		reporter.error("Could not load workflow authoring reference: session message API is unavailable.");
		return;
	}
	if (request.length > 0 && typeof pi.sendUserMessage !== "function") {
		reporter.error("Could not send workflow authoring request: user message API is unavailable.");
		return;
	}
	let content: string;
	try {
		content = await readWorkflowAuthoringReference();
	} catch (error) {
		reporter.error(`Could not load workflow authoring reference: ${safeErrorReason(error)}`);
		return;
	}
	const collapsedLine = formatWorkflowAuthoringCollapsedLine();
	try {
		await pi.sendMessage(
			{
				customType: WORKFLOW_AUTHORING_CUSTOM_TYPE,
				content,
				display: true,
				details: { collapsed: collapsedLine },
			},
			{ triggerTurn: false },
		);
	} catch (error) {
		reporter.error(`Could not load workflow authoring reference: ${safeErrorReason(error)}`);
		return;
	}
	if (request.length > 0) {
		const delivery = ctx.isIdle?.() === false ? { deliverAs: "steer" as const } : undefined;
		try {
			await pi.sendUserMessage!(request, delivery);
		} catch (error) {
			reporter.error(`Could not send workflow authoring request: ${safeErrorReason(error)}`);
		}
	}
}

export function registerWorkflowSlashCommand(
	pi: ExtensionAPI,
	workflowCommands: Map<string, WorkflowCommandHandler>,
	deps: WorkflowSlashCommandDeps,
): void {
	const owner = deps.owner ?? captureWorkflowOwnerResources();
	const { overlay } = deps;
	registerWorkflowAuthoringMessageRenderer(pi);
	workflowCommands.set("workflow", (_args, ctx) => {
		const reporter = createWorkflowCommandReporter(ctx, workflowPolicyFromContext(ctx), pi);
		reporter.info(REMOVED_WORKFLOW_COMMAND_NOTICE);
	});
	registerWorkflowCommand(
		pi,
		"workflows",
		{
			description: WORKFLOWS_COMMAND_DESCRIPTION,
			handler: async (args, ctx) => {
				const reporter = createWorkflowCommandReporter(ctx, workflowPolicyFromContext(ctx), pi);
				try {
					if (owner.store.runs().length === 0) await deps.ensureWorkflowResourcesLoaded?.();
				} catch (error) {
					reporter.error(`Could not load workflow definitions: ${safeErrorReason(error)}`);
					return;
				}
				if (deps.restoreSessionRuns) {
					try {
						await deps.restoreSessionRuns(ctx);
					} catch (error) {
						// Saved runs that cannot be read must not hide the live ones: list those and say what is missing.
						const notice = `Could not reopen saved workflow runs: ${safeErrorReason(error)}`;
						if (ctx.hasUI === false || workflowPolicyFromContext(ctx).mode === "non_interactive")
							reporter.info(notice);
						else ctx.ui.notify(notice, "warning");
					}
				}
				await handleWorkflowsCommand(args, ctx, reporter, {
					overlay,
					store: owner.store,
					invalidDefinitions: () => invalidDefinitionsFromDiagnostics(deps.discoveryDiagnostics?.() ?? []),
				});
			},
			getArgumentCompletions: (partial) =>
				/\s/.test(partial.trimStart()) ? null : completeToken(partial, runIdItems(owner.store)),
		},
		workflowCommands,
	);
	registerWorkflowCommand(
		pi,
		"workflow-authoring",
		{
			description: WORKFLOW_AUTHORING_COMMAND_DESCRIPTION,
			handler: async (args, ctx) => {
				await handleWorkflowAuthoringCommand(args, ctx, pi);
			},
		},
		workflowCommands,
	);
}
