/** Subagent Tool: foreground orchestration extension. */
import * as os from "node:os";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	initTheme,
	keyHintIfBound,
	publishExtensionContextEffect,
	type SessionEntry,
	ToolBlock,
	type ToolBlockStatus,
	type ToolDefinition,
} from "@bastani/atomic";
import type { AgentToolResult } from "@bastani/atomic-agent-core";
import {
	type Component,
	Container,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import { discoverAgents } from "../agents/agents.js";
import { trackOwnIntercomSession } from "../intercom/own-intercom-session.js";
import { answerIntercomChildrenRequests } from "../runs/foreground/intercom-children.js";
import registerSubagentNotify, { type SubagentNotifyDetails } from "../runs/foreground/notify.js";
import { bindReleasedChildWakes } from "../runs/foreground/released-child-wakes.js";
import { bindSubagentChildCards } from "../runs/foreground/subagent-child-card-state.js";
import { bindSubagentChildOwner, subagentChildOwnerWriter } from "../runs/foreground/subagent-child-owner.js";
import {
	endWorkflowRunStageSubagentChildren,
	saveUnsavedSubagentChildRecords,
	subagentChildOwner,
	WORKFLOW_RUN_ENDED_STAGE_SUBAGENTS_EVENT,
	type WorkflowRunEndedStageSubagentsRequest,
	watchWorkflowStageSubagentChildren,
} from "../runs/foreground/subagent-child-records.js";
import {
	awaitSubagentChildRestoration,
	holdDormantRunSubagentChildren,
	holdRunningSubagentChildren,
	recordReportedGoneSubagentChildren,
	releaseEarlyChildHolds,
	restoredChildrenAwaitingIntercom,
	restoreSubagentChildren,
	SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT,
	SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT,
	type SubagentAwaitChildRestorationRequest,
	type SubagentRestoredIntercomPeersRequest,
	subagentChildRestoreNotices,
	WORKFLOW_DORMANT_RUN_SUBAGENT_HOLD_EVENT,
	type WorkflowDormantRunSubagentHoldRequest,
} from "../runs/foreground/subagent-child-restore.js";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.js";
import { resumeAwaitingSubagentChildren } from "../runs/foreground/subagent-run-control.js";
import { bindSubagentTaskResumer } from "../runs/foreground/subagent-task-resumer.ts";
import { formatDuration, shortenPath } from "../shared/formatters.js";
import { resolveCurrentSessionId } from "../shared/session-identity.js";
import { subagentSessionRoot } from "../shared/session-root.js";
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
import { prepareSubagentArguments, SubagentParams } from "./schemas.js";
import { SUBAGENT_TOOL_DESCRIPTION } from "./tool-description.js";
import { renderSubagentToolCall, renderSubagentToolResult } from "./tool-rendering.js";

export {
	isReleasedChildError,
	RELEASED_CHILD_ERROR_NAME,
	ReleasedChildError,
	type ReleasedChildErrorCode,
	type ReleasedChildErrorFields,
} from "../runs/foreground/released-child-errors.js";
export {
	findSubagentChildRecord,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildOwner,
	type SubagentChildRecord,
} from "../runs/foreground/subagent-child-records.js";
export {
	awaitSubagentChildRestoration,
	holdDormantRunSubagentChildren,
	holdRunningSubagentChildren,
	recordReportedGoneSubagentChildren,
	restoredChildrenAwaitingIntercom,
	restoreSubagentChild,
	restoreSubagentChildren,
	SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT,
	SUBAGENT_RESUME_CONTINUATION_PROMPT,
	type SubagentAwaitChildRestorationRequest,
	type SubagentAwaitIntercomPeerRequest,
	type SubagentChildRestoreDeps,
	type SubagentChildRestoreOutcome,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
	type SubagentRestoredIntercomPeer,
	type SubagentRestoredIntercomPeersRequest,
	subagentChildRestoreNotices,
	WORKFLOW_DORMANT_RUN_SUBAGENT_HOLD_EVENT,
	type WorkflowDormantRunSubagentHold,
	type WorkflowDormantRunSubagentHoldRequest,
} from "../runs/foreground/subagent-child-restore.js";
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
	isSubagentChildSession,
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
import { claimStartupCleanup, createSubagentStartupMaintenance } from "./startup-maintenance.js";

export { loadConfig } from "./config.js";

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
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
	container.addChild(renderSubagentResult(result, options, theme));
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
): Component {
	if (!(globalThis as Record<symbol, unknown>)[Symbol.for("@bastani/atomic:theme")]) {
		initTheme("dark", false);
	}
	const content = typeof message.content === "string" ? message.content : "";
	const details = (message.details as SubagentNotifyDetails | undefined) ?? parseSubagentNotifyContent(content);
	if (!details) return new Text(content, 0, 0);
	const status: ToolBlockStatus =
		details.status === "completed"
			? "success"
			: details.status === "interrupted" || details.status === "killed"
				? "stopped"
				: "failure";
	const meta: string[] = [];
	if (details.taskInfo) meta.push(details.taskInfo);
	if (details.durationMs !== undefined) meta.push(formatDuration(details.durationMs));
	const trimmedPreview = details.resultPreview.trim();
	const previewLines = options.expanded
		? trimmedPreview.split("\n").filter((line) => line.trim())
		: [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
	const detailLines = (previewLines.length > 0 ? previewLines : ["(no output)"]).map((line) => theme.fg("dim", line));
	if (!options.expanded && trimmedPreview.includes("\n")) {
		const expandHint = keyHintIfBound("app.tools.expand", "full notification");
		if (expandHint) detailLines.push(theme.fg("dim", expandHint));
	}
	if (details.sessionLabel && details.sessionValue) {
		detailLines.push(theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`));
	}
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(
		new ToolBlock({
			status,
			title: new Text(
				`${theme.fg("toolTitle", theme.bold(details.agent))} ${theme.fg("dim", details.status)}`,
				0,
				0,
			),
			...(meta.length > 0 ? { meta } : {}),
			details: new Text(detailLines.join("\n"), 0, 0),
		}),
	);
	return container;
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
		const state: SubagentState = {
			baseCwd: "",
			currentSessionId: null,
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		};
		const maintenance = createSubagentStartupMaintenance(state, {
			artifactCleanupDays: DEFAULT_ARTIFACT_CONFIG.cleanupDays,
		});
		// Scheduled by the first session that starts, never by a subagent child or an instance that never starts (#5186).
		let releaseStartupCleanup: (() => void) | undefined;
		const stopMaintenance = () => {
			maintenance.stop();
			releaseStartupCleanup?.();
			releaseStartupCleanup = undefined;
		};
		registrationFailureCleanups.push(stopMaintenance);
		const executorDeps = {
			pi,
			state,
			config,
			getSubagentSessionRoot: subagentSessionRoot,
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
			const ownerSessionId = subagentChildOwner(ctx).sessionId;
			return executorForContext(ctx)
				.execute(id, params, signal, onUpdate, ctx)
				.then((result) =>
					result.details?.taskResponse ? { ...result, details: { ...result.details, ownerSessionId } } : result,
				);
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
			exposure: "model-only",
			label: "Subagent",
			description: SUBAGENT_TOOL_DESCRIPTION,
			parameters: SubagentParams,
			prepareArguments: prepareSubagentArguments,
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
		// The children this session launches name its own Intercom id as their supervisor.
		eventUnsubscribes.push(trackOwnIntercomSession(pi.events, state));
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
				stopMaintenance,
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
		let releaseCards: (() => void) | undefined;
		const resetSessionState = (ctx: ExtensionContext) => {
			releaseCards?.();
			releaseCards = undefined;
			state.baseCwd = ctx.cwd;
			state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
			state.lastUiContext = ctx;
			cleanupSessionArtifacts(ctx);
			clearPendingForegroundControlNotices(state);
			restoreSlashFinalSnapshots(ctx.sessionManager.getEntries(), pi);
			// A subagent's own session launches no children (#4395): it adds nothing to the child index.
			if (!isSubagentChildSession(ctx)) releaseCards = bindSubagentChildCards(ctx);
		};
		let unbindChildOwner: (() => void) | undefined;
		let stopReleasedChildWakes: (() => void) | undefined;
		let taskResumer: ReturnType<typeof bindSubagentTaskResumer> | undefined;
		pi.on("agent_start", () => taskResumer?.ensure());
		pi.on("session_start", async (event, ctx) => {
			if (!lifecycle.isCurrent()) return;
			if (releaseStartupCleanup === undefined && !isSubagentChildSession(ctx))
				releaseStartupCleanup = claimStartupCleanup(maintenance);
			resetSessionState(ctx);
			stopReleasedChildWakes?.();
			stopReleasedChildWakes = undefined;
			// The children this session launched and a restart interrupted are addressable at once, not only after its
			// recovery has restored them (#3760). Recovery takes these holds over; this never blocks session start. Only
			// a session that was just opened has interrupted children: after a reload its running children are alive.
			const opened = event.reason === "startup" || event.reason === "resume";
			if (!isSubagentChildSession(ctx) && ctx.isPresentationOnly !== true) {
				let startWakes: (() => void) | undefined;
				const committed = publishExtensionContextEffect(
					ctx,
					() => {
						unbindChildOwner?.();
						unbindChildOwner = bindSubagentChildOwner(pi, ctx);
						stopReleasedChildWakes = bindReleasedChildWakes(executorDeps, ctx, pi.events, undefined, (start) => {
							startWakes = start;
						});
					},
					"commit",
				);
				const started = publishExtensionContextEffect(ctx, () => {
					const writer = subagentChildOwnerWriter(pi, ctx.sessionManager);
					// Children from earlier generations end with the stage when it closes for good.
					watchWorkflowStageSubagentChildren(writer, ctx);
					void saveUnsavedSubagentChildRecords(writer, subagentChildOwner(ctx).sessionId);
					startWakes?.();
					// A finished child continues from its chat: the message the reader sends resumes it in its own session.
					taskResumer?.dispose();
					taskResumer = bindSubagentTaskResumer(executorDeps, ctx);
				});
				await Promise.all([committed, started]);
				if (opened) void holdRunningSubagentChildren(pi.events, ctx).catch(() => undefined);
				if (opened)
					void resumeAwaitingSubagentChildren(
						executorDeps,
						ctx,
						config.resumeInFlight ?? "never",
						lifecycle.isCurrent,
					);
			}
		});
		pi.on("session_recovery_restore", async (_event, ctx) => {
			// Subagent children never own children; workflow stages carry a policy but do (#3760).
			if (!lifecycle.isCurrent() || isSubagentChildSession(ctx)) return undefined;
			const writer = subagentChildOwnerWriter(pi, ctx.sessionManager);
			const outcomes = await restoreSubagentChildren(executorDeps, ctx);
			const notices = subagentChildRestoreNotices(outcomes);
			// Report once: record the children the notices call gone, so later restarts neither retry nor repeat them.
			await recordReportedGoneSubagentChildren(writer, outcomes);
			return { notices };
		});
		const unsubscribeChildRestoration = pi.events.on(SUBAGENT_AWAIT_CHILD_RESTORATION_EVENT, (payload) => {
			const request = payload as Partial<SubagentAwaitChildRestorationRequest> | null;
			if (!lifecycle.isCurrent() || !request || request.completion) return;
			if (typeof request.ownerSessionId !== "string" || typeof request.target !== "string") return;
			const { ownerSessionId, target } = request;
			const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : 0;
			const entries = (): SessionEntry[] => {
				try {
					const ctx = state.lastUiContext;
					return ctx?.sessionManager.getSessionId() === ownerSessionId ? ctx.sessionManager.getEntries() : [];
				} catch {
					return [];
				}
			};
			request.completion = awaitSubagentChildRestoration(ownerSessionId, entries(), target, timeoutMs);
		});
		eventUnsubscribes.push(unsubscribeChildRestoration);
		// Intercom asks which children a `subagents:` send reaches (#4752).
		eventUnsubscribes.push(answerIntercomChildrenRequests(pi.events, lifecycle.isCurrent));
		// Intercom asks which relaunched children have not registered yet before it judges the peers of interrupted deliveries.
		const unsubscribeRestoredPeers = pi.events.on(SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT, (payload) => {
			const request = payload as Partial<SubagentRestoredIntercomPeersRequest> | null;
			if (!lifecycle.isCurrent() || !request || request.completion || typeof request.ownerSessionId !== "string")
				return;
			request.completion = Promise.resolve(restoredChildrenAwaitingIntercom(request.ownerSessionId));
		});
		eventUnsubscribes.push(unsubscribeRestoredPeers);
		// The workflows extension of this session asks to keep an interrupted run's stage subagents addressable.
		const unsubscribeDormantRunHold = pi.events.on(WORKFLOW_DORMANT_RUN_SUBAGENT_HOLD_EVENT, (payload) => {
			const request = payload as Partial<WorkflowDormantRunSubagentHoldRequest> | null;
			const ctx = request?.context ?? state.lastUiContext;
			if (!lifecycle.isCurrent() || !request || request.completion || !ctx) return;
			if (typeof request.group !== "string" || !Array.isArray(request.stageSessionIds)) return;
			const stageSessionIds = request.stageSessionIds.filter((id): id is string => typeof id === "string");
			request.completion = Promise.resolve(
				holdDormantRunSubagentChildren(pi.events, ctx, { group: request.group, stageSessionIds }),
			);
		});
		eventUnsubscribes.push(unsubscribeDormantRunHold);
		// The workflows extension of this session ended a run for good: its stages' subagents end with it.
		const unsubscribeRunEnded = pi.events.on(WORKFLOW_RUN_ENDED_STAGE_SUBAGENTS_EVENT, (payload) => {
			const request = payload as Partial<WorkflowRunEndedStageSubagentsRequest> | null;
			const ctx = request?.context ?? state.lastUiContext;
			if (!lifecycle.isCurrent() || !request || request.completion || !ctx) return;
			if (!Array.isArray(request.stageSessionIds)) return;
			const stageSessionIds = request.stageSessionIds.filter((id): id is string => typeof id === "string");
			request.completion = endWorkflowRunStageSubagentChildren(ctx, stageSessionIds);
		});
		eventUnsubscribes.push(unsubscribeRunEnded);
		pi.on("session_shutdown", (_event, ctx) => {
			releaseCards?.();
			releaseCards = undefined;
			unbindChildOwner?.();
			unbindChildOwner = undefined;
			taskResumer?.dispose();
			taskResumer = undefined;
			stopReleasedChildWakes?.();
			stopReleasedChildWakes = undefined;
			// Holds nothing took over end with the session; the broker also ends them when its connection closes.
			try {
				releaseEarlyChildHolds(subagentChildOwner(ctx).sessionId);
			} catch {
				// A context that is already retired has nothing to release.
			}
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
