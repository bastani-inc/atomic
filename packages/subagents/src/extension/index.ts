/** Subagent Tool: foreground orchestration extension. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	APP_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	keyHintIfBound,
	type ToolDefinition,
} from "@bastani/atomic";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { discoverAgents } from "../agents/agents.js";
import registerSubagentNotify, { type SubagentNotifyDetails } from "../runs/foreground/notify.js";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.js";
import { getArtifactsDir } from "../shared/artifacts.js";
import { formatDuration, shortenPath } from "../shared/formatters.js";
import { resolveCurrentSessionId } from "../shared/session-identity.js";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.js";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.js";
import { registerSlashCommands } from "../slash/slash-commands.js";
import {
	clearSlashSnapshots,
	getSlashRenderableSnapshot,
	resolveSlashMessageDetails,
	restoreSlashFinalSnapshots,
	type SlashMessageDetails,
} from "../slash/slash-live-state.js";
import {
	advanceResultPulseFrame,
	renderSubagentResult,
	type SubagentResultRenderState,
	stopResultAnimations,
} from "../tui/render.js";
import { loadConfig } from "./config.js";
import { parseSubagentNotifyContent } from "./notification-content.js";
import { DEFAULT_PROMPT_GUIDANCE } from "./prompt-guidance.js";
import { SubagentParams } from "./schemas.js";
import { SUBAGENT_TOOL_DESCRIPTION } from "./tool-description.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./tool-rendering.js";

export {
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	registerPromptTemplateBridgeRequestSettlement,
} from "../slash/prompt-template-bridge.js";
export { SUBAGENT_TOOL_DESCRIPTION } from "./tool-description.js";

import {
	DEFAULT_ARTIFACT_CONFIG,
	type Details,
	SLASH_RESULT_TYPE,
	SUBAGENT_CONTROL_EVENT,
	type SubagentState,
} from "../shared/types.js";
import { beginApiLifecycle, getApiScopedSet } from "./api-lifecycle.js";
import {
	clearPendingForegroundControlNotices,
	formatSubagentControlNotice,
	handleSubagentControlNotice,
	SUBAGENT_CONTROL_MESSAGE_TYPE,
	type SubagentControlMessageDetails,
} from "./control-notices.js";
import { createSubagentStartupMaintenance } from "./startup-maintenance.js";

export { loadConfig } from "./config.js";

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), `${APP_NAME}-subagent-session-`));
}
function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
function isSlashResultRunning(result: { details?: Details }): boolean {
	return (
		result.details?.progress?.some((entry) => entry.status === "running") ||
		result.details?.results.some((entry) => entry.progress?.status === "running") ||
		false
	);
}
function isSlashResultError(result: { details?: Details }): boolean {
	return (
		result.details?.results.some((entry) => entry.status === "error" && entry.progress?.status !== "running") || false
	);
}
type SubagentToolRenderState = SubagentResultRenderState;
function rebuildSlashResultContainer(
	container: Container,
	result: AgentToolResult<Details>,
	options: { expanded: boolean; now?: number; pulseFrame?: number },
	theme: ExtensionContext["ui"]["theme"],
): void {
	container.clear();
	container.addChild(new Spacer(1));
	const boxTheme = isSlashResultRunning(result)
		? "toolPendingBg"
		: isSlashResultError(result)
			? "toolErrorBg"
			: "toolSuccessBg";
	const box = new Box(1, 1, (text: string) => theme.bg(boxTheme, text));
	box.addChild(renderSubagentResult(result, options, theme));
	container.addChild(box);
}
function createSlashResultComponent(
	details: SlashMessageDetails,
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
	owner: ExtensionAPI,
): Container {
	const container = new Container();
	let lastVersion = -1;
	let lastSnapshotNow = 0;
	let pulseFrame = 0;
	container.render = (width: number): string[] => {
		const snapshot = getSlashRenderableSnapshot(details, owner);
		if (snapshot.version !== lastVersion) {
			lastVersion = snapshot.version;
			lastSnapshotNow = Date.now();
			pulseFrame = advanceResultPulseFrame(pulseFrame);
			rebuildSlashResultContainer(
				container,
				snapshot.result,
				{ ...options, now: lastSnapshotNow, pulseFrame },
				theme,
			);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}
export function renderSubagentNotification(
	message: { content: unknown; details?: unknown },
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): Text {
	const content = typeof message.content === "string" ? message.content : "";
	const details = (message.details as SubagentNotifyDetails | undefined) ?? parseSubagentNotifyContent(content);
	if (!details) return new Text(content, 0, 0);
	const icon =
		details.status === "completed"
			? theme.fg("success", "✓")
			: details.status === "paused"
				? theme.fg("warning", "■")
				: theme.fg("error", "✗");
	const parts: string[] = [];
	if (details.taskInfo) parts.push(details.taskInfo);
	if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
	let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
	if (parts.length > 0)
		text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
	const trimmedPreview = details.resultPreview.trim();
	const previewLines = options.expanded
		? trimmedPreview.split("\n").filter((line) => line.trim())
		: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
	for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
		text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
	}
	if (!options.expanded && trimmedPreview.includes("\n")) {
		const expandHint = keyHintIfBound("app.tools.expand", "full notification");
		if (expandHint) text += `\n  ${expandHint}`;
	}
	if (details.sessionLabel && details.sessionValue) {
		text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
	}
	return new Text(text, 0, 0);
}
class SubagentControlNoticeComponent implements Component {
	constructor(
		private readonly details: SubagentControlMessageDetails,
		private readonly theme: ExtensionContext["ui"]["theme"],
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		const eventLabel = this.details.event.type.replaceAll("_", " ");
		if (width < 3) return [truncateToWidth(`Subagent ${eventLabel}`, width)];
		const bodyWidth = Math.max(1, width - 2);
		const borderChar = "─";
		const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
		const headerText = truncateToWidth(header, bodyWidth, "");
		const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
		const lines = [this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`)];
		for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
			const text = truncateToWidth(line, bodyWidth, "");
			const padding = Math.max(0, bodyWidth - visibleWidth(text));
			lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
		}
		lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
		return lines;
	}
}

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const lifecycle = beginApiLifecycle(pi);
	const registrationFailureCleanups: Array<() => void> = [];
	let runtimeCleanupInstalled = false;
	try {
		const config = loadConfig();
		const tempArtifactsDir = getArtifactsDir(null);
		const state: SubagentState = {
			baseCwd: "",
			currentSessionId: null,
			subagentInProgress: false,
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		};
		const maintenance = createSubagentStartupMaintenance(state, {
			artifactCleanupDays: DEFAULT_ARTIFACT_CONFIG.cleanupDays,
		});
		maintenance.scheduleStartupCleanup();
		registrationFailureCleanups.push(() => maintenance.stop());
		const executorDeps = {
			pi,
			state,
			config,
			tempArtifactsDir,
			getSubagentSessionRoot,
			expandTilde,
			discoverAgents,
		};
		const executor = createSubagentExecutor(executorDeps);
		const childExecutors = new Map<string, ReturnType<typeof createSubagentExecutor>>();
		const executorForContext = (ctx: ExtensionContext): ReturnType<typeof createSubagentExecutor> => {
			const policy = ctx.subagentPolicy;
			if (!policy) return executor;
			const key = `${policy.managementActions}:${policy.fanoutAuthorized ? "fanout" : "no-fanout"}`;
			const cached = childExecutors.get(key);
			if (cached) return cached;
			const childExecutor = createSubagentExecutor({
				...executorDeps,
				childPolicy: policy,
				allowMutatingManagementActions: policy.managementActions === "full",
			});
			childExecutors.set(key, childExecutor);
			return childExecutor;
		};
		pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
			const details = resolveSlashMessageDetails(message.details);
			if (!details) return undefined;
			return createSlashResultComponent(details, options, theme, pi);
		});
		pi.registerMessageRenderer<SubagentNotifyDetails>("subagent-notify", renderSubagentNotification);
		pi.registerMessageRenderer<SubagentControlMessageDetails>(
			SUBAGENT_CONTROL_MESSAGE_TYPE,
			(message, _options, theme) => {
				const details = message.details as SubagentControlMessageDetails | undefined;
				if (!details?.event) return undefined;
				const content = typeof message.content === "string" ? message.content : undefined;
				return new SubagentControlNoticeComponent(
					{ ...details, noticeText: formatSubagentControlNotice(details, content) },
					theme,
				);
			},
		);
		const executeSubagentCollapsed = (
			id: string,
			params: SubagentParamsLike,
			signal: AbortSignal,
			onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
			ctx: ExtensionContext,
		) => {
			if (ctx.hasUI) {
				state.lastUiContext = ctx;
				ctx.ui.setToolsExpanded(false);
			}
			return executorForContext(ctx).execute(id, params, signal, onUpdate, ctx);
		};
		const slashBridge = registerSlashSubagentBridge({
			events: pi.events,
			getContext: () => state.lastUiContext,
			execute: (id, params, signal, onUpdate, ctx) => executeSubagentCollapsed(id, params, signal, onUpdate, ctx),
		});
		registrationFailureCleanups.push(() => {
			slashBridge.cancelAll();
			slashBridge.dispose();
		});
		const promptTemplateBridge = registerPromptTemplateDelegationBridge({
			events: pi.events,
			getContext: () => state.lastUiContext,
			execute: async (requestId, request, signal, ctx, onUpdate) => {
				if (request.tasks && request.tasks.length > 0) {
					return executeSubagentCollapsed(
						requestId,
						{ tasks: request.tasks, context: request.context, cwd: request.cwd, worktree: request.worktree },
						signal,
						onUpdate,
						ctx,
					);
				}
				return executeSubagentCollapsed(
					requestId,
					{
						agent: request.agent,
						task: request.task,
						context: request.context,
						cwd: request.cwd,
						model: request.model,
					},
					signal,
					onUpdate,
					ctx,
				);
			},
		});
		registrationFailureCleanups.push(() => {
			promptTemplateBridge.cancelAll();
			promptTemplateBridge.dispose();
		});
		const tool: ToolDefinition<typeof SubagentParams, Details, SubagentToolRenderState> = {
			name: "subagent",
			label: "Subagent",
			description: SUBAGENT_TOOL_DESCRIPTION,
			parameters: SubagentParams,
			promptGuidelines: DEFAULT_PROMPT_GUIDANCE,
			execute(id, params, signal, onUpdate, ctx) {
				const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
				return executeSubagentCollapsed(id, params as SubagentParamsLike, executionSignal, onUpdate, ctx);
			},
			renderCall(args, theme, context) {
				return renderSubagentToolCall(args as SubagentParamsLike, theme, context);
			},
			renderResult(result, options, theme, context) {
				return renderSubagentToolResult(result, options, theme, context);
			},
		};
		pi.registerTool(tool);
		registerSlashCommands(pi, state);
		const notifyCleanup = registerSubagentNotify(pi);
		registrationFailureCleanups.push(notifyCleanup);
		const visibleControlNotices = getApiScopedSet(pi, "__piSubagentVisibleControlNoticesByApi");
		const controlEventHandler = (payload: unknown) => {
			if (!lifecycle.isCurrent()) return;
			handleSubagentControlNotice({
				pi,
				state,
				visibleControlNotices,
				details: payload as SubagentControlMessageDetails,
			});
		};
		const eventUnsubscribes: Array<() => void> = [];
		const unsubscribeControl = pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler);
		eventUnsubscribes.push(unsubscribeControl);
		registrationFailureCleanups.push(unsubscribeControl);
		let cleaned = false;
		const runtimeCleanup = () => {
			if (cleaned) return;
			cleaned = true;
			const cleanupSteps: Array<() => void> = [
				...eventUnsubscribes,
				notifyCleanup,
				() => maintenance.stop(),
				() => stopResultAnimations(),
				() => clearPendingForegroundControlNotices(state),
				() => childExecutors.clear(),
				() => clearSlashSnapshots(pi),
				() => slashBridge.cancelAll(),
				() => slashBridge.dispose(),
				() => promptTemplateBridge.cancelAll(),
				() => promptTemplateBridge.dispose(),
			];
			for (const cleanup of cleanupSteps) {
				try {
					cleanup();
				} catch {
					// Cleanup is exhaustive and best effort so later owned resources release.
				}
			}
		};
		lifecycle.setCleanup(runtimeCleanup);
		runtimeCleanupInstalled = true;
		const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
			maintenance.cleanupSessionArtifactsDeferred(ctx);
		};
		const resetSessionState = (ctx: ExtensionContext) => {
			state.baseCwd = ctx.cwd;
			state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
			state.lastUiContext = ctx;
			cleanupSessionArtifacts(ctx);
			clearPendingForegroundControlNotices(state);
			restoreSlashFinalSnapshots(ctx.sessionManager.getEntries(), pi);
		};
		pi.on("session_start", (_event, ctx) => {
			if (lifecycle.isCurrent()) resetSessionState(ctx);
		});
		pi.on("session_shutdown", () => {
			lifecycle.dispose();
		});
	} catch (error) {
		if (!runtimeCleanupInstalled) {
			for (const cleanup of registrationFailureCleanups.reverse()) {
				try {
					cleanup();
				} catch {
					// Continue releasing partial-registration resources.
				}
			}
		}
		lifecycle.dispose();
		throw error;
	}
}
