import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDocsPath } from "@bastani/atomic";
import { getKeybindings, wrapTextWithAnsi } from "@bastani/atomic-tui";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { truncateToWidth } from "../tui/text-helpers.js";
import type { ExtensionAPI, PiCommandContext } from "./public-types.js";
import { dynamicTextRenderComponent } from "./render-component.js";
import type { ExtensionRuntime } from "./runtime.js";
import { completeToken, runIdItems } from "./workflow-command-completions.js";
import { formatWorkflowResourceLoadWarning } from "./workflow-command-surfaces.js";
import {
	createWorkflowCommandReporter,
	registerWorkflowCommand,
	type WorkflowCommandHandler,
} from "./workflow-command-utils.js";
import { handleWorkflowsCommand } from "./workflow-open-run.js";
import { captureWorkflowOwnerResources, type WorkflowOwnerResources } from "./workflow-owner-resources.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";
import type { WorkflowRunControlDeps } from "./workflow-run-control-command.js";

export const WORKFLOWS_COMMAND_DESCRIPTION = "Browse running and completed workflows";
export const WORKFLOW_AUTHORING_COMMAND_DESCRIPTION = "Load the reference for writing workflow definitions";
export const WORKFLOW_AUTHORING_CUSTOM_TYPE = "workflows:authoring-reference";
export const WORKFLOW_AUTHORING_COLLAPSED_LINE = "› Loaded workflow authoring reference (ctrl+o to expand)";
export const REMOVED_WORKFLOW_COMMAND_NOTICE =
	"! /workflow was removed · use /workflows, /resume or ask the agent to run a workflow";

export interface WorkflowSlashCommandDeps {
	runtimeProxy?: ExtensionRuntime;
	runtimeForContext?: (ctx?: PiCommandContext) => ExtensionRuntime;
	overlay: GraphOverlayPort;
	reloadWorkflowResources?: () => Promise<WorkflowReloadReport | undefined> | undefined;
	ensureWorkflowResourcesLoaded: () => Promise<void> | void;
	runWithLifecycleSuppressedForPolicy?: <T>(policy: WorkflowExecutionPolicy, fn: () => Promise<T>) => Promise<T>;
	runControl?: WorkflowRunControlDeps;
	owner?: WorkflowOwnerResources;
}

const MODIFIER_LABELS: Record<string, string> = {
	ctrl: "ctrl",
	control: "ctrl",
	cmd: "cmd",
	command: "cmd",
	shift: "shift",
	alt: "alt",
	option: "alt",
	meta: "meta",
};

const SPECIAL_KEY_LABELS: Record<string, string> = {
	enter: "enter",
	return: "enter",
	esc: "esc",
	escape: "esc",
	space: "space",
	tab: "tab",
	backspace: "backspace",
	delete: "delete",
	del: "delete",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
	home: "home",
	end: "end",
	pageup: "pageup",
	pagedown: "pagedown",
};

function normalizeKeyPart(part: string): string {
	const lower = part.toLowerCase();
	return MODIFIER_LABELS[lower] ?? SPECIAL_KEY_LABELS[lower] ?? lower;
}

function normalizeKeyBindingText(raw: string): string {
	return raw
		.split("/")
		.map((chord) => chord.split("+").map(normalizeKeyPart).join("+"))
		.join("/");
}

export function formatWorkflowAuthoringCollapsedLine(expandKey?: string): string {
	const rawKey =
		expandKey !== undefined ? expandKey : getKeybindings().getKeys("app.tools.expand").join("/") || "ctrl+o";
	const resolvedKey = normalizeKeyBindingText(rawKey);
	const hint = resolvedKey.length > 0 ? ` (${resolvedKey} to expand)` : "";
	return `› Loaded workflow authoring reference${hint}`;
}

const authoringRendererRegisteredHosts = new WeakSet<object>();

export function registerWorkflowAuthoringMessageRenderer(pi: ExtensionAPI): void {
	if (authoringRendererRegisteredHosts.has(pi)) return;
	const register = pi.registerMessageRenderer;
	if (typeof register !== "function") return;
	register.call(pi, WORKFLOW_AUTHORING_CUSTOM_TYPE, (raw, options, theme) => {
		const message = raw as { content?: unknown } | undefined;
		const content = typeof message?.content === "string" ? message.content : WORKFLOW_AUTHORING_COLLAPSED_LINE;
		const expanded = options?.expanded === true;
		const pad = " ".repeat(Math.max(0, options?.outputPad ?? 0));
		const fg =
			typeof (theme as { fg?: unknown } | undefined)?.fg === "function"
				? (theme as { fg: (color: string, text: string) => string }).fg.bind(theme)
				: undefined;
		return dynamicTextRenderComponent((width) => {
			const safeWidth = Math.max(1, width - pad.length);
			if (!expanded) {
				const expandKey =
					typeof options?.keyText === "function"
						? options.keyText("app.tools.expand")
						: getKeybindings().getKeys("app.tools.expand").join("/") || "ctrl+o";
				const normalizedKey = normalizeKeyBindingText(expandKey);
				const plain = truncateToWidth(formatWorkflowAuthoringCollapsedLine(normalizedKey), safeWidth);
				if (!fg) return `${pad}${plain}`;
				const hintSuffix = normalizedKey.length > 0 ? ` (${normalizedKey} to expand)` : "";
				if (hintSuffix.length > 0 && plain.endsWith(hintSuffix)) {
					const head = plain.slice(0, plain.length - hintSuffix.length);
					return `${pad}${fg("muted", head)}${fg("dim", hintSuffix)}`;
				}
				return `${pad}${fg("muted", plain)}`;
			}
			return wrapTextWithAnsi(content, safeWidth)
				.map((line) => `${pad}${line}`)
				.join("\n");
		});
	});
	authoringRendererRegisteredHosts.add(pi);
}

function readWorkflowAuthoringReference(): string {
	return readFileSync(join(getDocsPath(), "workflows", "authoring.md"), "utf8");
}

async function handleWorkflowAuthoringCommand(args: string, ctx: PiCommandContext, pi: ExtensionAPI): Promise<void> {
	const reporter = createWorkflowCommandReporter(ctx, workflowPolicyFromContext(ctx), pi);
	const collapsedLine = formatWorkflowAuthoringCollapsedLine();
	let content: string;
	try {
		content = readWorkflowAuthoringReference();
	} catch (error) {
		reporter.error(
			`Could not load workflow authoring reference: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	if (typeof pi.sendMessage === "function") {
		await pi.sendMessage(
			{
				customType: WORKFLOW_AUTHORING_CUSTOM_TYPE,
				content,
				display: true,
				details: { collapsed: collapsedLine },
			},
			{ triggerTurn: false },
		);
	} else {
		reporter.info(collapsedLine);
	}
	const request = args.trim();
	if (request.length > 0) {
		await pi.sendUserMessage?.(request);
	}
}

export function registerWorkflowSlashCommand(
	pi: ExtensionAPI,
	workflowCommands: Map<string, WorkflowCommandHandler>,
	deps: WorkflowSlashCommandDeps,
): void {
	const owner = deps.owner ?? captureWorkflowOwnerResources();
	const overlay = deps.runControl?.overlay ?? deps.overlay;
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
				const activeOwner = deps.owner ?? captureWorkflowOwnerResources();
				const reporter = createWorkflowCommandReporter(ctx, workflowPolicyFromContext(ctx), pi);
				try {
					await deps.ensureWorkflowResourcesLoaded();
				} catch (error) {
					ctx.ui?.notify(formatWorkflowResourceLoadWarning(error), "warning");
				}
				await handleWorkflowsCommand(args, ctx, reporter, {
					overlay,
					store: activeOwner.store,
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
