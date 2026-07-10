/** Subagent Tool: sync/async orchestration extension. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { APP_NAME, getEnvValue } from "@bastani/atomic";
import { type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@bastani/atomic";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { resolveCurrentSessionId } from "../shared/session-identity.ts";
import { advanceResultPulseFrame, renderLiveSubagentResult, renderSubagentResult, stopResultAnimations, stopWidgetAnimation, type SubagentResultRenderState } from "../tui/render.ts";
import { SubagentParams } from "./schemas.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { registerSlashCommands } from "../slash/slash-commands.ts";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.ts";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots, type SlashMessageDetails } from "../slash/slash-live-state.ts";
import registerSubagentNotify, { type SubagentNotifyDetails } from "../runs/background/notify.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import registerFanoutChildSubagentExtension from "./fanout-child.ts";
import { formatDuration, shortenPath } from "../shared/formatters.ts";
import { loadConfig } from "./config.ts";
import { DEFAULT_PROMPT_GUIDANCE } from "./prompt-guidance.ts";
import { type Details, type SubagentState, ASYNC_DIR, DEFAULT_ARTIFACT_CONFIG, RESULTS_DIR, SLASH_RESULT_TYPE, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_CONTROL_EVENT } from "../shared/types.ts";
import { clearPendingForegroundControlNotices, formatSubagentControlNotice, handleSubagentControlNotice, SUBAGENT_CONTROL_MESSAGE_TYPE, type SubagentControlMessageDetails } from "./control-notices.ts";
import { createSubagentStartupMaintenance } from "./startup-maintenance.ts";
import { beginApiLifecycle, getApiScopedSet } from "./api-lifecycle.ts";
export { loadConfig } from "./config.ts";
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
function ensureAccessibleDir(dirPath: string): void {
	fs.mkdirSync(dirPath, { recursive: true });
	try {
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		try {
			fs.rmSync(dirPath, { recursive: true, force: true });
		} catch {
		}
		fs.mkdirSync(dirPath, { recursive: true });
		fs.accessSync(dirPath, fs.constants.R_OK | fs.constants.W_OK);
	}
}
function isSlashResultRunning(result: { details?: Details }): boolean {
	return result.details?.progress?.some((entry) => entry.status === "running")
		|| result.details?.results.some((entry) => entry.progress?.status === "running")
		|| false;
}
function isSlashResultError(result: { details?: Details }): boolean {
	return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
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
	const boxTheme = isSlashResultRunning(result) ? "toolPendingBg" : isSlashResultError(result) ? "toolErrorBg" : "toolSuccessBg";
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
			rebuildSlashResultContainer(container, snapshot.result, { ...options, now: lastSnapshotNow, pulseFrame }, theme);
		}
		return Container.prototype.render.call(container, width);
	};
	return container;
}
function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const match = header.match(/^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const resultPreview = resultLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[2]!,
		status: match[1] as SubagentNotifyDetails["status"],
		...(match[3] ? { taskInfo: match[3] } : {}),
		resultPreview,
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
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
	if (getEnvValue(SUBAGENT_CHILD_ENV) === "1") {
		if (getEnvValue(SUBAGENT_FANOUT_CHILD_ENV) === "1") registerFanoutChildSubagentExtension(pi);
		return;
	}
	const lifecycle = beginApiLifecycle(pi);
	const registrationFailureCleanups: Array<() => void> = [];
	let runtimeCleanupInstalled = false;
	try {
		ensureAccessibleDir(RESULTS_DIR);
		ensureAccessibleDir(ASYNC_DIR);
		const config = loadConfig();
		const asyncByDefault = config.asyncByDefault === true;
		const tempArtifactsDir = getArtifactsDir(null);
		const state: SubagentState = {
			baseCwd: "",
			currentSessionId: null,
			asyncJobs: new Map(),
			subagentInProgress: false,
			foregroundRuns: new Map(),
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			cleanupTimers: new Map(),
			lastUiContext: null,
			poller: null,
			completionSeen: new Map(),
			watcher: null,
			watcherRestartTimer: null,
			resultFileCoalescer: {
				schedule: () => false,
				clear: () => {},
			},
		};
		const maintenance = createSubagentStartupMaintenance(pi, state, {
			resultsDir: RESULTS_DIR,
			artifactCleanupDays: DEFAULT_ARTIFACT_CONFIG.cleanupDays,
			resultTtlMs: 10 * 60 * 1000,
		});
		maintenance.scheduleStartupCleanup();
		registrationFailureCleanups.push(() => maintenance.stop());
		maintenance.startResultWatcherDeferred();
		maintenance.primeExistingResultsDeferred();
		const { ensurePoller, handleStarted, handleComplete, resetJobs, hydrateActiveJobs } = createAsyncJobTracker(pi, state, ASYNC_DIR);
		const executor = createSubagentExecutor({
			pi,
			state,
			config,
			asyncByDefault,
			tempArtifactsDir,
			getSubagentSessionRoot,
			expandTilde,
			discoverAgents,
		});
		pi.registerMessageRenderer<SlashMessageDetails>(SLASH_RESULT_TYPE, (message, options, theme) => {
			const details = resolveSlashMessageDetails(message.details);
			if (!details) return undefined;
			return createSlashResultComponent(details, options, theme, pi);
		});
		pi.registerMessageRenderer<SubagentNotifyDetails>("subagent-notify", (message, options, theme) => {
			const content = typeof message.content === "string" ? message.content : "";
			const details = (message.details as SubagentNotifyDetails | undefined) ?? parseSubagentNotifyContent(content);
			if (!details) return new Text(content, 0, 0);
			const icon = details.status === "completed"
				? theme.fg("success", "✓")
				: details.status === "paused"
					? theme.fg("warning", "■")
					: theme.fg("error", "✗");
			const parts: string[] = [];
			if (details.taskInfo) parts.push(details.taskInfo);
			if (details.durationMs !== undefined) parts.push(formatDuration(details.durationMs));
			let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
			if (parts.length > 0) text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
			const trimmedPreview = details.resultPreview.trim();
			const previewLines = options.expanded
				? trimmedPreview.split("\n").filter((line) => line.trim())
				: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
			for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
				text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
			}
			if (!options.expanded && trimmedPreview.includes("\n")) {
				text += `\n  ${theme.fg("dim", "ctrl+o full notification")}`;
			}
			if (details.sessionLabel && details.sessionValue) {
				text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
			}
			return new Text(text, 0, 0);
		});
		pi.registerMessageRenderer<SubagentControlMessageDetails>(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
			const details = message.details as SubagentControlMessageDetails | undefined;
			if (!details?.event) return undefined;
			const content = typeof message.content === "string" ? message.content : undefined;
			return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
		});
		const executeSubagentCollapsed = (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => {
			if (ctx.hasUI) {
				state.lastUiContext = ctx;
				ctx.ui.setToolsExpanded(false);
			}
			return executor.execute(id, params, signal, onUpdate, ctx);
		};
		const slashBridge = registerSlashSubagentBridge({
			events: pi.events,
			getContext: () => state.lastUiContext,
			execute: (id, params, signal, onUpdate, ctx) =>
				executeSubagentCollapsed(id, params, signal, onUpdate, ctx),
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
						{
							tasks: request.tasks,
							context: request.context,
							cwd: request.cwd,
							worktree: request.worktree,
							async: false,
						},
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
						async: false,
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
		function effectiveParallelTaskCount(tasks: Array<{ count?: unknown }> | undefined): number {
			if (!tasks || tasks.length === 0) return 0;
			return tasks.reduce((total, task) => {
				const count = typeof task.count === "number" && Number.isInteger(task.count) && task.count >= 1 ? task.count : 1;
				return total + count;
			}, 0);
		}
		const tool: ToolDefinition<typeof SubagentParams, Details, SubagentToolRenderState> = {
			name: "subagent",
			label: "Subagent",
			description: `Delegate to subagents or manage agent definitions.
EXECUTION (use exactly ONE mode):
• Execution calls always start non-interactively.
• Before executing, use { action: "list" } to inspect configured agents/chains. Only execute agents listed as executable/non-disabled.
• SINGLE: { agent, task? } - one task; omit task for self-contained agents
• CHAIN: { chain: [{agent:"agent-a"}, {parallel:[{agent:"agent-b",count:3}]}] } - sequential pipeline with optional parallel fan-out
• PARALLEL: { tasks: [{agent,task,count?,output?,reads?,progress?}, ...], concurrency?: number, worktree?: true } - concurrent execution (worktree: isolate each task in a git worktree)
• Optional context: { context: "fresh" | "fork" } (default: if any requested agent has defaultContext: "fork", the whole invocation uses fork; otherwise "fresh"; inspect agent defaults via { action: "list" })
CHAIN TEMPLATE VARIABLES (use in task strings):
• {task} - The original task/request from the user
• {previous} - Text response from the previous step (empty for first step)
• {chain_dir} - Shared directory for chain files (e.g., <tmpdir>/${APP_NAME}-subagents-<scope>/chain-runs/abc123/)
Example: { chain: [{agent:"agent-a", task:"Analyze {task}"}, {agent:"agent-b", task:"Plan based on {previous}"}] }
MANAGEMENT (use action field, omit agent/task/chain/tasks):
• { action: "list" } - discover executable agents/chains
• { action: "get", agent: "name" } - full detail; packaged agents use dotted runtime names like "package.agent"
• { action: "create", config: { name: "custom-agent", package: "code-analysis", systemPrompt, systemPromptMode, inheritProjectContext, inheritSkills, defaultContext, ... } }
• { action: "update", agent: "code-analysis.custom-agent", config: { package: "analysis", ... } } - merge
• { action: "delete", agent: "code-analysis.custom-agent" }
• Use chainName for chain operations; packaged chains also use dotted runtime names
CONTROL:
• { action: "status", id: "..." } - inspect an async/background run by id or prefix
• { action: "interrupt", id?: "..." } - soft-interrupt the current child turn and leave the run paused
• { action: "resume", id: "...", message: "...", index?: 0 } - follow up with a live async child or revive a completed async/foreground child from its session
DIAGNOSTICS:
• { action: "doctor" } - read-only report for runtime paths, discovery, sessions, and intercom`,
			parameters: SubagentParams,
			promptGuidelines: DEFAULT_PROMPT_GUIDANCE,
			execute(id, params, signal, onUpdate, ctx) {
				const executionSignal = signal ?? ctx.signal ?? new AbortController().signal;
				return executeSubagentCollapsed(id, params as SubagentParamsLike, executionSignal, onUpdate, ctx);
			},
			renderCall(args, theme) {
				if (args.action) {
					const target = args.agent || args.chainName || "";
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}${target ? ` ${theme.fg("accent", target)}` : ""}`,
						0, 0,
					);
				}
				const isParallel = (args.tasks?.length ?? 0) > 0;
				const parallelCount = effectiveParallelTaskCount(args.tasks as Array<{ count?: unknown }> | undefined);
				const asyncLabel = args.async === true ? theme.fg("warning", " [async]") : "";
				if (args.chain?.length)
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}chain (${args.chain.length})${asyncLabel}`,
						0,
						0,
					);
				if (isParallel)
					return new Text(
						`${theme.fg("toolTitle", theme.bold("subagent "))}parallel (${parallelCount})${asyncLabel}`,
						0,
						0,
					);
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "?")}${asyncLabel}`,
					0,
					0,
				);
			},
			renderResult(result, options, theme, context) {
				return renderLiveSubagentResult(result, options, theme, context);
			},
		};
		pi.registerTool(tool);
		registerSlashCommands(pi, state);
		const notifyCleanup = registerSubagentNotify(pi);
		registrationFailureCleanups.push(notifyCleanup);
		const visibleControlNotices = getApiScopedSet(pi, "__piSubagentVisibleControlNoticesByApi");
		const startedEventHandler = (payload: unknown) => {
			if (lifecycle.isCurrent()) handleStarted(payload);
		};
		const completeEventHandler = (payload: unknown) => {
			if (lifecycle.isCurrent()) handleComplete(payload);
		};
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
		for (const [event, handler] of [
			[SUBAGENT_ASYNC_STARTED_EVENT, startedEventHandler],
			[SUBAGENT_ASYNC_COMPLETE_EVENT, completeEventHandler],
			[SUBAGENT_CONTROL_EVENT, controlEventHandler],
		] as const) {
			const unsubscribe = pi.events.on(event, handler);
			eventUnsubscribes.push(unsubscribe);
			registrationFailureCleanups.push(unsubscribe);
		}
		let cleaned = false;
		const runtimeCleanup = () => {
			if (cleaned) return;
			cleaned = true;
			const cleanupSteps: Array<() => void> = [
				...eventUnsubscribes,
				notifyCleanup,
				() => maintenance.stop(),
				() => stopWidgetAnimation(undefined, pi),
				() => stopResultAnimations(),
				() => {
					if (state.poller) clearInterval(state.poller);
					state.poller = null;
				},
				() => clearPendingForegroundControlNotices(state),
				...Array.from(state.cleanupTimers.values(), (timer) => () => clearTimeout(timer)),
				() => state.cleanupTimers.clear(),
				() => state.asyncJobs.clear(),
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
		pi.on("tool_result", (event, ctx) => {
			if (!lifecycle.isCurrent() || event.toolName !== "subagent") return;
			if (!ctx.hasUI) return;
			state.lastUiContext = ctx;
			hydrateActiveJobs(ctx);
			if (state.asyncJobs.size > 0) ensurePoller();
		});
		const cleanupSessionArtifacts = (ctx: ExtensionContext) => {
			maintenance.cleanupSessionArtifactsDeferred(ctx);
		};
		const resetSessionState = (ctx: ExtensionContext) => {
			state.baseCwd = ctx.cwd;
			state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
			state.lastUiContext = ctx;
			cleanupSessionArtifacts(ctx);
			clearPendingForegroundControlNotices(state);
			resetJobs(ctx);
			hydrateActiveJobs(ctx);
			restoreSlashFinalSnapshots(ctx.sessionManager.getEntries(), pi);
			maintenance.primeExistingResultsDeferred();
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
