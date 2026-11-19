import { NoticeLine, type NoticeLineSpec, reportDebugAsync as reportDebug, sliceHead } from "@bastani/atomic";
import type { WorkflowArtifact } from "../shared/authoring-contract-stage.js";
import type { BudgetDimension, BudgetReport } from "../shared/budget.js";
import {
	actionableReturnedStatusText,
	effectiveRunStatus,
	hasRecordedRunBlock,
	isReturnedBlockedWorkflowStatus,
	normalizeReturnedWorkflowStatus,
	structuredRecoverableWorkflowFailureText,
} from "../shared/returned-run-status.js";
import { isTopLevelWorkflowRun } from "../shared/run-visibility.js";
import type { Store } from "../shared/store.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type {
	PendingPrompt,
	PromptKind,
	RunSnapshot,
	RunStatus,
	StageInputKind,
	StageSnapshot,
	StageStatus,
	StoreSnapshot,
	WorkflowActor,
} from "../shared/store-types.js";
import {
	boundedToolPayloadRecord,
	boundedToolPayloadText,
	boundedToolText,
	type ToolPayloadValue,
} from "../shared/tool-payload-bounds.js";
import type { WorkflowOutputValues } from "../shared/types.js";
import { inertDisplayLine, inertDisplayText } from "../tui/display-text.js";
import { runFailureText } from "../tui/run-display-state.js";
import { outputValueLine, summarizeFailureText } from "../tui/run-outcome.js";
import { fmtDuration } from "../tui/status-helpers.js";
import type { ExtensionAPI, PiMessageRenderComponent, PiMessageRenderer } from "./index.js";
import { createLifecycleNoticeDelivery } from "./lifecycle-notification-delivery.js";

export const LIFECYCLE_NOTICE_CUSTOM_TYPE = "workflows:lifecycle-notice";
export const LIFECYCLE_NOTICE_SNIPPET_LIMIT = 240;

export type WorkflowLifecycleNoticeKind =
	| "started"
	| "completed"
	| "failed"
	| "blocked"
	| "budget_warning"
	| "awaiting_input"
	| "paused"
	| "quit"
	| "resumed";

/**
 * Control-action kinds. Unlike terminal outcomes these are reversible and can
 * repeat, so their dedupe keys carry the occurrence timestamp rather than the
 * run id alone, and they are reported only when a control path attributed the
 * action to a user.
 */
type WorkflowControlNoticeKind = "started" | "paused" | "quit" | "resumed";
export const WORKFLOW_LIFECYCLE_NOTICE_KINDS = [
	"started",
	"completed",
	"failed",
	"blocked",
	"budget_warning",
	"awaiting_input",
	"paused",
	"quit",
	"resumed",
] as const satisfies readonly WorkflowLifecycleNoticeKind[];

export interface WorkflowLifecycleNotificationConfig {
	readonly enabled: boolean;
	readonly notifyOn: readonly WorkflowLifecycleNoticeKind[];
}

export interface WorkflowLifecycleNoticeDetails {
	readonly kind: WorkflowLifecycleNoticeKind;
	readonly scope: "run" | "stage";
	readonly runId: string;
	readonly workflowName: string;
	readonly status: RunStatus | StageStatus;
	readonly stageId?: string;
	readonly stageName?: string;
	readonly promptId?: string;
	readonly promptKind?: PromptKind | StageInputKind;
	readonly promptMessage?: string;
	readonly error?: string;
	/** Partial declared outputs carried by an author-initiated terminal exit. */
	readonly outputs?: WorkflowOutputValues;
	readonly outputsPreview?: string;
	readonly reason?: string;
	readonly artifacts?: { readonly shown: readonly WorkflowLifecycleNoticeArtifact[]; readonly total: number };
	readonly failedStageId?: string;
	readonly toolNodeId?: string;
	readonly toolName?: string;
	readonly durationMs?: number;
	readonly budgetDimension?: "duration" | "tokens" | "cost";
	/** True when a blocked stop is the engine-owned budget_exceeded rail. */
	readonly budgetExceeded?: boolean;
	readonly active?: boolean;
	/** Whether a failed author exit or quit run advertises itself as resumable. */
	readonly resumable?: boolean;
	/** Who performed this lifecycle action, when a control path attributed it. */
	readonly actor?: WorkflowActor;
	/** Who launched the run, when the launch was attributed. */
	readonly origin?: WorkflowActor;
	readonly createdAt: number;
}

export interface WorkflowLifecycleNoticeArtifact {
	readonly kind: string;
	readonly path: string;
	readonly detail?: string;
}

const NOTICE_ARTIFACTS_SHOWN = 3;
const NOTICE_TEXT_LIMIT = 4096;
const SNIPPET_SCAN_WINDOW = 4096;

export interface WorkflowLifecycleNotificationState {
	readonly deliveredTerminalRuns: Set<string>;
	readonly retryableTerminalNotices: Map<string, WorkflowLifecycleNoticeDetails>;
	readonly pendingTerminalRuns: Map<string, symbol>;
	readonly retryableTerminalRuns: Set<string>;
	readonly retryObservers: Set<(key: string, details: WorkflowLifecycleNoticeDetails) => void>;
	readonly deliveredInputPrompts: Set<string>;
	suppressionDepth: number;
}

export interface WorkflowLifecycleNotificationOptions {
	readonly store: Store;
	readonly sendMessage?: ExtensionAPI["sendMessage"];
	readonly registerMessageRenderer?: ExtensionAPI["registerMessageRenderer"];
	readonly rendererHost?: object;
	readonly config: WorkflowLifecycleNotificationConfig;
	readonly state?: WorkflowLifecycleNotificationState;
	readonly seedExisting?: boolean;
}

type RawRenderer = PiMessageRenderer;
const rendererRegisteredHosts = new WeakSet<object>();
export function createWorkflowLifecycleNotificationState(): WorkflowLifecycleNotificationState {
	return {
		deliveredTerminalRuns: new Set<string>(),
		pendingTerminalRuns: new Map<string, symbol>(),
		retryableTerminalNotices: new Map<string, WorkflowLifecycleNoticeDetails>(),
		retryableTerminalRuns: new Set<string>(),
		retryObservers: new Set<(key: string, details: WorkflowLifecycleNoticeDetails) => void>(),
		deliveredInputPrompts: new Set<string>(),
		suppressionDepth: 0,
	};
}

/** Reset all prior-session lifecycle delivery and dedupe state. */
export function resetWorkflowLifecycleNotificationState(state: WorkflowLifecycleNotificationState): void {
	state.deliveredTerminalRuns.clear();
	state.pendingTerminalRuns.clear();
	state.retryableTerminalRuns.clear();
	state.retryableTerminalNotices.clear();
	state.retryObservers.clear();
	state.deliveredInputPrompts.clear();
	state.suppressionDepth = 0;
}

export function seedWorkflowLifecycleNotificationState(
	state: WorkflowLifecycleNotificationState,
	snapshot: StoreSnapshot,
): void {
	for (const run of snapshot.runs) {
		if (!isTopLevelWorkflowRun(run)) continue;
		const noticeKind = terminalNoticeKind(run);
		if (noticeKind !== undefined && lifecycleOccurrenceAt(run, noticeKind) !== undefined) {
			const key = terminalRunKey(noticeKind, run);
			if (!state.pendingTerminalRuns.has(key) && !state.retryableTerminalRuns.has(key)) {
				state.deliveredTerminalRuns.add(key);
			}
		}
		for (const occurrence of controlOccurrences(run)) {
			const controlKey = controlOccurrenceKey(run, occurrence);
			if (!state.pendingTerminalRuns.has(controlKey) && !state.retryableTerminalRuns.has(controlKey)) {
				state.deliveredTerminalRuns.add(controlKey);
			}
		}
		for (const warning of budgetWarningReports(run))
			state.deliveredTerminalRuns.add(budgetWarningKey(run, warning.dimension));
		if (run.pendingPrompt !== undefined) {
			state.deliveredInputPrompts.add(runAwaitingInputKey(run.id, run.pendingPrompt));
		}
		for (const stage of run.stages) {
			if (stage.status === "awaiting_input") {
				state.deliveredInputPrompts.add(awaitingInputKey(run.id, stage));
			}
		}
	}
}

/**
 * Suppress lifecycle notice emission while still observing snapshot changes and
 * marking matching lifecycle states as delivered. This is intended for restore
 * or replay paths where historical workflow states should seed dedupe state
 * without notifying the current chat; it is not a generic temporary mute that
 * should emit the same notices later.
 */
export function withWorkflowLifecycleNotificationsSuppressed<T>(
	state: WorkflowLifecycleNotificationState,
	fn: () => T,
): T {
	state.suppressionDepth += 1;
	try {
		return fn();
	} finally {
		state.suppressionDepth -= 1;
	}
}

/**
 * Async-safe companion to {@link withWorkflowLifecycleNotificationsSuppressed}.
 * Keeps suppression active until the awaited operation settles, so terminal
 * store updates produced by background jobs cannot race an awaited headless
 * workflow dispatch and trigger an extra steer turn before the caller returns.
 */
export async function withWorkflowLifecycleNotificationsSuppressedAsync<T>(
	state: WorkflowLifecycleNotificationState,
	fn: () => Promise<T>,
): Promise<T> {
	state.suppressionDepth += 1;
	try {
		return await fn();
	} finally {
		state.suppressionDepth -= 1;
	}
}

export function installWorkflowLifecycleNotifications(options: WorkflowLifecycleNotificationOptions): () => void {
	registerLifecycleNoticeRenderer(options);

	if (!options.config.enabled) return () => undefined;
	const send = options.sendMessage;
	if (typeof send !== "function") return () => undefined;

	const notifyOn = new Set<WorkflowLifecycleNoticeKind>(options.config.notifyOn);
	const state = options.state ?? createWorkflowLifecycleNotificationState();
	let delivery!: ReturnType<typeof createLifecycleNoticeDelivery>;
	if (options.seedExisting !== false) {
		seedWorkflowLifecycleNotificationState(state, readGraphStoreSnapshot(options.store));
	}

	const emit = (details: WorkflowLifecycleNoticeDetails): boolean | Promise<boolean> => {
		try {
			const result = send(
				{
					customType: LIFECYCLE_NOTICE_CUSTOM_TYPE,
					content: formatWorkflowLifecycleNoticeText(details),
					display: true,
					details,
				},
				{ triggerTurn: true, deliverAs: "steer", persistWhenStreaming: true },
			);
			if (result === undefined) return true;
			return Promise.resolve(result).then(
				() => true,
				(error: unknown) => {
					warnLifecycleSendFailure(error);
					return false;
				},
			);
		} catch (error) {
			warnLifecycleSendFailure(error);
			return false;
		}
	};

	const emitTerminalNoticeOnce = (run: RunSnapshot, kind: "completed" | "failed" | "blocked"): void => {
		const noticeKind = terminalNoticeKind(run);
		if (noticeKind !== kind || lifecycleOccurrenceAt(run, kind) === undefined || !notifyOn.has(kind)) {
			return;
		}

		const key = terminalRunKey(kind, run);
		if (
			state.deliveredTerminalRuns.has(key) ||
			state.pendingTerminalRuns.has(key) ||
			state.retryableTerminalRuns.has(key)
		)
			return;
		if (state.suppressionDepth > 0) {
			state.deliveredTerminalRuns.add(key);
			state.retryableTerminalRuns.delete(key);
			state.retryableTerminalNotices.delete(key);
			return;
		}
		delivery.deliver(key, makeTerminalNotice(run, kind, options.store.run(run.id)?.result ?? run.result));
	};

	const emitControlNoticesOnce = (run: RunSnapshot): void => {
		for (const occurrence of controlOccurrences(run)) {
			if (!notifyOn.has(occurrence.kind)) continue;
			const key = controlOccurrenceKey(run, occurrence);
			if (
				state.deliveredTerminalRuns.has(key) ||
				state.pendingTerminalRuns.has(key) ||
				state.retryableTerminalRuns.has(key)
			)
				continue;
			if (state.suppressionDepth > 0) {
				state.deliveredTerminalRuns.add(key);
				state.retryableTerminalRuns.delete(key);
				state.retryableTerminalNotices.delete(key);
				continue;
			}
			delivery.deliver(key, makeControlNotice(run, occurrence));
		}
	};

	const emitStageAwaitingInputNoticeOnce = (run: RunSnapshot, stage: StageSnapshot): void => {
		if (stage.status !== "awaiting_input") return;

		const key = awaitingInputKey(run.id, stage);
		if (state.deliveredInputPrompts.has(key)) return;

		state.deliveredInputPrompts.add(key);
		// Awaiting-input states are tracked for dedupe/restore, but must not enqueue
		// a main-chat steer turn. Waking the active agent with an actionable prompt
		// can let the model answer workflow HIL without a deliberate user action.
	};

	const emitRunAwaitingInputNoticeOnce = (run: RunSnapshot): void => {
		if (run.pendingPrompt === undefined) return;

		const key = runAwaitingInputKey(run.id, run.pendingPrompt);
		if (state.deliveredInputPrompts.has(key)) return;

		state.deliveredInputPrompts.add(key);
	};

	const emitBudgetWarningOnce = (run: RunSnapshot): void => {
		for (const warning of budgetWarningReports(run)) {
			const key = budgetWarningKey(run, warning.dimension);
			if (state.deliveredTerminalRuns.has(key) || state.pendingTerminalRuns.has(key)) continue;
			if (state.suppressionDepth > 0) state.deliveredTerminalRuns.add(key);
			else delivery.deliver(key, makeBudgetWarningNotice(run, warning));
		}
	};

	const inspect = (snapshot: StoreSnapshot): void => {
		for (const run of snapshot.runs) {
			if (!isTopLevelWorkflowRun(run)) continue;
			emitTerminalNoticeOnce(run, "completed");
			emitTerminalNoticeOnce(run, "failed");
			emitTerminalNoticeOnce(run, "blocked");
			emitControlNoticesOnce(run);

			if (notifyOn.has("budget_warning")) emitBudgetWarningOnce(run);
			if (!notifyOn.has("awaiting_input")) continue;
			emitRunAwaitingInputNoticeOnce(run);
			for (const stage of run.stages) {
				emitStageAwaitingInputNoticeOnce(run, stage);
			}
		}
	};
	delivery = createLifecycleNoticeDelivery({ state, emit, eligible: (details) => notifyOn.has(details.kind) });
	for (const [key, details] of state.retryableTerminalNotices) {
		if (notifyOn.has(details.kind)) delivery.deliver(key, details);
	}

	const unsubscribe = subscribeStoreInvalidation(options.store, () => inspect(readGraphStoreSnapshot(options.store)));
	inspect(readGraphStoreSnapshot(options.store));
	return () => {
		unsubscribe();
		delivery.dispose();
	};
}

export function registerLifecycleNoticeRenderer(
	options: Pick<WorkflowLifecycleNotificationOptions, "registerMessageRenderer" | "rendererHost">,
): void {
	const register = options.registerMessageRenderer;
	if (typeof register !== "function") return;

	const host = options.rendererHost ?? register;
	if (rendererRegisteredHosts.has(host)) return;

	const renderer: RawRenderer = (raw, options) => {
		const message = raw as { details?: WorkflowLifecycleNoticeDetails };
		if (!message.details) return undefined;
		return makeNoticeComponent(message.details, options?.expanded === true, options?.outputPad);
	};

	register(LIFECYCLE_NOTICE_CUSTOM_TYPE, renderer);
	rendererRegisteredHosts.add(host);
}

export function formatWorkflowLifecycleNoticeText(details: WorkflowLifecycleNoticeDetails): string {
	const workflowName = escapeQuotedText(singleLineNoticeText(details.workflowName));
	// "which you started" / "which the user started". Omitted entirely when the
	// run carries no recorded origin, rather than guessing one.
	const origin =
		details.origin === undefined
			? ""
			: details.origin === "agent"
				? ", which you started"
				: ", which the user started";
	const actor = details.actor === "agent" ? "You" : "The user";
	if (details.kind === "started") {
		return `▶ ${actor} started workflow "${workflowName}" (run ${details.runId}). It is running in the background; you will be notified when it completes.`;
	}
	if (details.kind === "completed") {
		return `✓ Workflow "${workflowName}" completed (run ${details.runId})${origin}. Inspect: /workflows ${details.runId}`;
	}
	if (details.kind === "failed") {
		const stage = details.stageName ?? details.failedStageId ?? details.stageId;
		const tool = lifecycleToolOrigin(details);
		const failureSite = stage ? `, stage ${stage}` : tool !== undefined ? `, tool ${tool}` : "";
		const errorText = details.error ? `: ${details.error}` : "";
		const outputsText = formatLifecycleOutputs(details.outputs);
		const outputSuffix = outputsText === undefined ? "" : ` Partial outputs: ${outputsText}`;
		return `✗ Workflow "${workflowName}" failed (run ${details.runId}${failureSite})${origin}${errorText}${outputSuffix}. Inspect: /workflows ${details.runId}`;
	}
	if (details.kind === "blocked") {
		const errorText = details.error ? `: ${details.error}` : "";
		if (details.budgetExceeded === true) {
			const dimension = details.budgetDimension === undefined ? "" : ` ${details.budgetDimension}`;
			return `! Workflow "${workflowName}" stopped at its${dimension} budget limit (run ${details.runId})${origin}${errorText}. Summarize progress and the estimated next steps, then ask the user whether to proceed — prefer the ask_user_question tool when it is available — and after approval resume with a raised budget: workflow({ action: "resume", runId: "${details.runId}", budget: { ... } }). Inspect: /workflows ${details.runId}`;
		}
		const stateText = details.active === true ? "is blocked" : "ended blocked";
		return `! Workflow "${workflowName}" ${stateText} (run ${details.runId})${origin}${errorText}. Unless the user has requested inline/no-workflow execution, resume or steer the run, or continue with a follow-up workflow. For an explicit inline switch, safely hold/stop the affected run, reconcile completed work and in-flight side effects, then continue inline without duplicate execution; completed work is not undone. Preserve safety, authorization and validation requirements. Resolve material ambiguity from the objective and repository evidence. Inspect: /workflows ${details.runId}`;
	}
	if (details.kind === "budget_warning") {
		const warningText = details.error ? `: ${details.error}` : "";
		const dimension = details.budgetDimension ?? "duration";
		return `! Workflow "${workflowName}" is approaching its ${dimension} budget (run ${details.runId})${origin}${warningText}. Inspect: /workflows ${details.runId}`;
	}
	if (details.kind === "paused" || details.kind === "quit") {
		const stopStage = details.stageName ?? details.stageId;
		// "(run 8c31), which you started, at stage review" — the stage clause takes a
		// separating comma only when an origin clause precedes it.
		const stageText = stopStage ? `${origin === "" ? "" : ","} at stage ${stopStage}` : "";
		const scopeText = details.scope === "stage" ? "stage of workflow" : "workflow";
		const verb = details.kind === "paused" ? "paused" : "quit";
		const noun = details.kind === "paused" ? "pause" : "stop";
		const glyph = details.kind === "paused" ? "⏸" : "⏹";
		return `${glyph} ${actor} ${verb} the ${scopeText} "${workflowName}" (run ${details.runId})${origin}${stageText}. This ${noun} was deliberate and user-requested; do not resume it or take over the work unless asked. Resume from /workflows ${details.runId}`;
	}
	if (details.kind === "resumed") {
		const resumedStage = details.stageName ?? details.stageId;
		const stageText = resumedStage ? `${origin === "" ? "" : ","} at stage ${resumedStage}` : "";
		const scopeText = details.scope === "stage" ? "stage of workflow" : "workflow";
		return `▶ ${actor} resumed the ${scopeText} "${workflowName}" (run ${details.runId})${origin}${stageText}. It is running again in the background.`;
	}
	const prompt = details.promptMessage ? ` Prompt: ${details.promptMessage}` : "";
	if (details.scope === "run") {
		return `？ Workflow "${workflowName}" needs input (run ${details.runId}).${prompt} Respond: /workflows ${details.runId} to answer this run-level prompt.`;
	}
	const stage = details.stageName ?? details.stageId ?? "unknown";
	const responseHint =
		details.stageId && details.promptId
			? `/workflows ${details.runId} or workflow({ action: "answer", runId: ${jsonString(details.runId)}, stageId: ${jsonString(details.stageId)}, promptId: ${jsonString(details.promptId)}, response: ... })`
			: `/workflows ${details.runId}`;
	return `？ Workflow "${workflowName}" needs input (run ${details.runId}, stage ${stage}).${prompt} Respond: ${responseHint}.`;
}

function makeTerminalNotice(
	run: RunSnapshot,
	kind: "completed" | "failed" | "blocked",
	fullResult: WorkflowOutputValues | undefined = run.result,
): WorkflowLifecycleNoticeDetails {
	const failedStage = run.failedStageId ? run.stages.find((stage) => stage.id === run.failedStageId) : undefined;
	const failedToolNodeId = kind === "failed" && run.failedStageId === undefined ? run.failedToolNodeId : undefined;
	const failedTool = run.toolNodes.find((node) => node.id === failedToolNodeId);
	const activeBlocked = kind === "blocked" && isActiveRecoverableBlockedRun(run);
	const outputs = kind === "failed" && run.exited === true && run.result !== undefined ? run.result : undefined;
	const budgetExceeded =
		kind === "blocked" && run.result?.status === "budget_exceeded" && run.budgetState?.systemOwnedStop === true;
	const resultDimension = budgetExceeded ? run.result?.dimension : undefined;
	const budgetDimension =
		resultDimension === "duration" || resultDimension === "tokens" || resultDimension === "cost"
			? resultDimension
			: undefined;
	const error = activeBlocked
		? (run.failureMessage ?? structuredRecoverableWorkflowFailureText(run) ?? run.error)
		: (run.error ??
			returnedNoticeError(run, kind) ??
			(kind === "blocked" || kind === "failed" ? run.exitReason : undefined));
	const outputsPreview = kind === "completed" ? formatCardOutputs(fullResult) : undefined;
	const displayFailure = kind === "failed" || kind === "blocked" ? (runFailureText(run) ?? error) : undefined;
	const reason = displayFailure === undefined ? undefined : summarizeNoticeFailureReason(displayFailure);
	const artifacts = kind === "completed" ? collectNoticeArtifacts(run) : undefined;
	return {
		kind,
		scope: "run",
		runId: run.id,
		workflowName: run.name,
		status: effectiveRunStatus(run),
		...(outputsPreview !== undefined ? { outputsPreview } : {}),
		...(reason !== undefined ? { reason } : {}),
		...(artifacts !== undefined ? { artifacts } : {}),
		...(activeBlocked ? { active: true } : {}),
		...(run.exited === true && run.status === "failed" && run.resumable !== undefined
			? { resumable: run.resumable }
			: {}),
		...(error ? { error: truncateSnippet(error) } : {}),
		...(outputs !== undefined ? { outputs } : {}),
		...(run.failedStageId ? { failedStageId: run.failedStageId } : {}),
		...(failedStage ? { stageId: failedStage.id, stageName: failedStage.name } : {}),
		...(failedToolNodeId !== undefined ? { toolNodeId: failedToolNodeId } : {}),
		...(failedTool !== undefined ? { toolName: failedTool.name } : {}),
		...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
		...(budgetExceeded ? { budgetExceeded: true } : {}),
		...(budgetDimension !== undefined ? { budgetDimension } : {}),
		...(run.origin !== undefined ? { origin: run.origin } : {}),
		createdAt: lifecycleOccurrenceAt(run, kind) ?? Date.now(),
	};
}

function budgetWarningReports(run: RunSnapshot): readonly BudgetReport[] {
	const warnings = Object.values(run.budgetState?.warnings ?? {}).filter(
		(warning): warning is BudgetReport => warning !== undefined,
	);
	return warnings;
}
function makeBudgetWarningNotice(run: RunSnapshot, warning: BudgetReport): WorkflowLifecycleNoticeDetails {
	return {
		kind: "budget_warning",
		scope: "run",
		runId: run.id,
		workflowName: run.name,
		status: run.status,
		budgetDimension: warning.dimension,
		error: `At ${warning.percent.toFixed(1)}% of the ${warning.dimension} budget (${warning.reading} / ${warning.ceiling}).`,
		...(warning.dimension === "duration" ? { durationMs: warning.reading } : {}),
		...(run.origin !== undefined ? { origin: run.origin } : {}),
		createdAt: run.startedAt,
	};
}
function makeControlNotice(run: RunSnapshot, occurrence: ControlOccurrence): WorkflowLifecycleNoticeDetails {
	const stage = occurrence.stage ?? restingStage(run);
	const elapsedMs = run.durationMs ?? (occurrence.at >= run.startedAt ? occurrence.at - run.startedAt : undefined);
	return {
		kind: occurrence.kind,
		scope: occurrence.scope,
		runId: run.id,
		workflowName: run.name,
		status: occurrence.stage !== undefined ? occurrence.stage.status : run.status,
		...(stage !== undefined ? { stageId: stage.id, stageName: stage.name } : {}),
		...(elapsedMs !== undefined ? { durationMs: elapsedMs } : {}),
		...(occurrence.kind === "quit" && run.resumable !== undefined ? { resumable: run.resumable } : {}),
		...(occurrence.actor !== undefined ? { actor: occurrence.actor } : {}),
		// The origin clause is omitted entirely for a run that never recorded one.
		...(occurrence.kind !== "started" && run.origin !== undefined ? { origin: run.origin } : {}),
		createdAt: occurrence.at,
	};
}

/** The stage a run currently rests on, preferring an explicitly paused one. */
function restingStage(run: RunSnapshot): StageSnapshot | undefined {
	return (
		run.stages.find((stage) => stage.status === "paused") ?? run.stages.find((stage) => stage.status === "running")
	);
}

function warnLifecycleSendFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	reportDebug("workflow", "lifecycle-notice-send-failed", { message }, () =>
		console.warn("[workflows] workflow lifecycle notice send failed", message),
	);
}

function escapeQuotedText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function jsonString(value: string): string {
	return JSON.stringify(value);
}

function terminalNoticeKind(run: RunSnapshot): "completed" | "failed" | "blocked" | undefined {
	if (isActiveRecoverableBlockedRun(run)) return "blocked";
	const status = effectiveRunStatus(run);
	if (status === "failed" || status === "blocked") return status;
	if (status !== "completed") return undefined;
	return "completed";
}

function isActiveRecoverableBlockedRun(run: RunSnapshot): boolean {
	return (
		hasRecordedRunBlock(run) ||
		(run.blockedAt !== undefined && structuredRecoverableWorkflowFailureText(run) !== undefined)
	);
}

function lifecycleOccurrenceAt(run: RunSnapshot, kind: "completed" | "failed" | "blocked"): number | undefined {
	if (kind === "blocked" && isActiveRecoverableBlockedRun(run)) return run.blockedAt;
	return run.endedAt;
}

function returnedNoticeError(run: RunSnapshot, kind: "completed" | "failed" | "blocked"): string | undefined {
	if (run.exited === true && (kind === "failed" || kind === "blocked")) return run.exitReason;
	const structuredFailureText = structuredRecoverableWorkflowFailureText(run);
	if (kind === "blocked" && structuredFailureText !== undefined) return structuredFailureText;
	const returnedStatus = normalizeReturnedWorkflowStatus(run.result?.status);
	if (returnedStatus === undefined) return undefined;
	if (kind === "failed" && returnedStatus === "failed") return actionableReturnedStatusText(run.result);
	if (kind === "blocked" && isReturnedBlockedWorkflowStatus(returnedStatus))
		return actionableReturnedStatusText(run.result);
	return undefined;
}

function terminalRunKey(kind: "completed" | "failed" | "blocked", run: RunSnapshot): string {
	if (kind !== "blocked") return `${kind}:${run.id}:`;
	// Block generations restart when a different workflow is registered under the same id.
	const occurrence = run.runGeneration ?? lifecycleOccurrenceAt(run, kind);
	return `${kind}:${run.id}:${run.startedAt}:${occurrence ?? ""}`;
}
function budgetWarningKey(run: RunSnapshot, dimension: BudgetDimension): string {
	return `budget_warning:${run.id}:${dimension}`;
}

/** One deliberate control action a run currently carries. */
interface ControlOccurrence {
	readonly kind: WorkflowControlNoticeKind;
	readonly scope: "run" | "stage";
	readonly at: number;
	readonly actor: WorkflowActor;
	readonly stage?: StageSnapshot;
}

/**
 * Every control action this run currently carries that a user actually asked
 * for.
 *
 * Attribution, not the status transition, is the trigger. A run passes through
 * paused on its way to a quit, and the engine resumes a run whenever a
 * human-in-the-loop prompt is answered or a stage control acknowledges; none of
 * those record an actor, so none of them reach the chat. Only a control path
 * that names its caller does, and it names exactly one scope per request, which
 * is what keeps a stage card and a run card from reporting the same event.
 */
function controlOccurrences(run: RunSnapshot): ControlOccurrence[] {
	const occurrences: ControlOccurrence[] = [];
	// Whether this run exists because someone resumed work, whoever asked for it.
	// A durable resume reuses the original run id (issue #1498) and a failed-run
	// continuation takes a fresh one; both re-enter `recordRunStart`, and neither
	// is a new run to the user. Keying the start suppression on the resume itself
	// rather than on who requested it is what keeps an agent-requested resume of a
	// user-started run from being announced as a fresh launch.
	const resumedRun = run.resumeSource === "run_control" || run.resumedFromRunId !== undefined;
	const userResumed = run.resumeSource === "run_control" && run.resumeActor === "user";
	// A resumed run that never paused in this session reports its start timestamp:
	// the re-dispatch is the occurrence.
	const continuation = userResumed && run.resumedAt === undefined;
	if (run.origin === "user" && !resumedRun) {
		occurrences.push({ kind: "started", scope: "run", at: run.startedAt, actor: "user" });
	}
	if (userResumed && run.status === "running") {
		occurrences.push({
			kind: "resumed",
			scope: "run",
			at: continuation ? run.startedAt : (run.resumedAt ?? run.startedAt),
			actor: "user",
		});
	}
	if (run.endedAt === undefined && run.status === "paused" && run.pauseActor === "user") {
		if (run.exitReason === "quit") {
			const quitAt = run.quitAt ?? run.pausedAt;
			if (quitAt !== undefined) occurrences.push({ kind: "quit", scope: "run", at: quitAt, actor: "user" });
		} else if (run.pausedAt !== undefined) {
			occurrences.push({ kind: "paused", scope: "run", at: run.pausedAt, actor: "user" });
		}
	}
	const runScoped = new Set(occurrences.map((occurrence) => occurrence.kind));
	if (run.endedAt !== undefined) return occurrences;
	for (const stage of run.stages) {
		if (stage.status === "paused" && stage.pauseActor === "user" && stage.pausedAt !== undefined) {
			if (!runScoped.has("paused") && !runScoped.has("quit")) {
				occurrences.push({ kind: "paused", scope: "stage", at: stage.pausedAt, actor: "user", stage });
			}
		}
		if (stage.status === "running" && stage.resumeActor === "user" && stage.resumedAt !== undefined) {
			if (!runScoped.has("resumed")) {
				occurrences.push({ kind: "resumed", scope: "stage", at: stage.resumedAt, actor: "user", stage });
			}
		}
	}
	return occurrences;
}

/**
 * Control actions are repeatable, so the occurrence timestamp is part of the
 * key: resuming clears `pausedAt`/`quitAt`, and the next pause mints a new key
 * while repeated invalidations at one unchanged state reuse the delivered one.
 */
function controlOccurrenceKey(run: RunSnapshot, occurrence: ControlOccurrence): string {
	if (occurrence.scope === "stage" && occurrence.stage !== undefined) {
		return `${occurrence.kind}:${run.id}:stage:${occurrence.stage.id}:${occurrence.at}`;
	}
	return `${occurrence.kind}:${run.id}:${occurrence.at}`;
}

function awaitingInputKey(runId: string, stage: StageSnapshot): string {
	const promptId = stage.pendingPrompt?.id ?? stage.inputRequest?.id;
	if (promptId) return `awaiting_input:${runId}:stage:${stage.id}:${promptId}`;
	return `awaiting_input:${runId}:stage:${stage.id}:${stage.awaitingInputSince ?? "active"}`;
}

function runAwaitingInputKey(runId: string, prompt: PendingPrompt): string {
	return `awaiting_input:${runId}:run:${prompt.id}`;
}
function lifecycleToolOrigin(details: WorkflowLifecycleNoticeDetails): string | undefined {
	return details.toolName !== undefined && details.toolName.length > 0 ? details.toolName : details.toolNodeId;
}
function truncateSnippet(value: string): string {
	if (value.length > SNIPPET_SCAN_WINDOW) {
		const head = value.slice(0, SNIPPET_SCAN_WINDOW).replace(/\s+/g, " ").trimStart();
		if (head.length > LIFECYCLE_NOTICE_SNIPPET_LIMIT + 2) {
			return `${sliceHead(head, LIFECYCLE_NOTICE_SNIPPET_LIMIT - 1)}…`;
		}
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= LIFECYCLE_NOTICE_SNIPPET_LIMIT) return normalized;
	return `${sliceHead(normalized, LIFECYCLE_NOTICE_SNIPPET_LIMIT - 1)}…`;
}

function summarizeNoticeFailureReason(error: string): string {
	if (error.length > SNIPPET_SCAN_WINDOW) {
		const head = error.slice(0, SNIPPET_SCAN_WINDOW);
		const firstBreak = head.search(/[\r\n]/);
		const candidate = firstBreak === -1 ? head : head.slice(0, firstBreak);
		const summary = summarizeFailureText(candidate).reason;
		if (firstBreak !== -1 && summary !== "No reason was recorded.") {
			return truncateSnippet(summary);
		}
		if (summary.replace(/\s+/g, " ").trim().length > LIFECYCLE_NOTICE_SNIPPET_LIMIT + 2) {
			return truncateSnippet(summary);
		}
	}
	return truncateSnippet(summarizeFailureText(error).reason);
}

function noticeArtifactDetail(artifact: WorkflowArtifact): string | undefined {
	if (artifact.captureError !== undefined)
		return `not captured: ${boundedToolText(summarizeFailureText(artifact.captureError).reason, LIFECYCLE_NOTICE_SNIPPET_LIMIT)}`;
	const size: string[] = [];
	if (artifact.filesChanged !== undefined && Number.isFinite(artifact.filesChanged) && artifact.filesChanged >= 0) {
		size.push(`${artifact.filesChanged} ${artifact.filesChanged === 1 ? "file" : "files"}`);
	}
	if (artifact.insertions !== undefined || artifact.deletions !== undefined) {
		const insertions = Number.isFinite(artifact.insertions) ? Math.max(0, artifact.insertions ?? 0) : 0;
		const deletions = Number.isFinite(artifact.deletions) ? Math.max(0, artifact.deletions ?? 0) : 0;
		size.push(`+${insertions} \u2212${deletions}`);
	}
	if (size.length > 0) return size.join(" \u00b7 ");
	return artifact.diffStat === undefined
		? undefined
		: boundedToolText(artifact.diffStat, LIFECYCLE_NOTICE_SNIPPET_LIMIT).split(/\r?\n/, 1)[0];
}

function collectNoticeArtifacts(run: RunSnapshot): WorkflowLifecycleNoticeDetails["artifacts"] {
	let total = 0;
	const shown: WorkflowLifecycleNoticeArtifact[] = [];
	for (const stage of run.stages) {
		const stageArtifacts = stage.artifacts;
		if (stageArtifacts === undefined || stageArtifacts.length === 0) continue;
		total += stageArtifacts.length;
		const inspectionLimit = Math.min(stageArtifacts.length, NOTICE_ARTIFACTS_SHOWN - shown.length);
		for (let i = 0; i < inspectionLimit; i++) {
			const artifact = stageArtifacts[i];
			if (artifact === undefined) continue;
			const detail = noticeArtifactDetail(artifact);
			shown.push({
				kind: artifact.kind,
				path: boundedNoticeLineText(artifact.path),
				...(detail === undefined ? {} : { detail: boundedNoticeLineText(detail) }),
			});
		}
	}
	return total > 0 ? { total, shown } : undefined;
}

function singleLineNoticeText(value: string): string {
	return inertDisplayLine(value.replace(/\r\n?/g, "\n"));
}

function boundedNoticeLineText(value: string): string {
	return singleLineNoticeText(boundedToolText(value, NOTICE_TEXT_LIMIT));
}

function formatLifecycleOutputs(outputs: WorkflowOutputValues | undefined): string | undefined {
	if (outputs === undefined) return undefined;
	try {
		const serialized = JSON.stringify(outputs);
		return serialized === undefined ? "available; inspect the run result" : truncateSnippet(serialized);
	} catch {
		return "available; inspect the run result";
	}
}

function makeNoticeComponent(
	details: WorkflowLifecycleNoticeDetails,
	expanded: boolean,
	outputPad?: number,
): PiMessageRenderComponent {
	const line = new NoticeLine(
		{ ...lifecycleNoticeLine(details), ...(outputPad === undefined ? {} : { outputPad }) },
		expanded,
	);
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render(width: number): string[] {
			if (width < 1) return [];
			const normalizedWidth = Math.floor(width);
			if (cachedWidth !== normalizedWidth || cachedLines === undefined) {
				cachedWidth = normalizedWidth;
				cachedLines = line.render(normalizedWidth);
			}
			return cachedLines;
		},
		invalidate() {
			line.invalidate();
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}

export function lifecycleNoticeLine(details: WorkflowLifecycleNoticeDetails): NoticeLineSpec {
	const stage = details.stageName ?? details.failedStageId ?? details.stageId;
	const at = stage === undefined ? undefined : `at ${boundedNoticeLineText(stage)}`;
	const duration = formatDurationMs(details.durationMs);
	const base = {
		label: details.scope === "stage" ? "Stage of workflow" : "Workflow",
		subject: boundedNoticeLineText(details.workflowName),
		detail: expandedNoticeDetails(details),
	};
	switch (details.kind) {
		case "started":
			return { ...base, status: "success", outcome: "started" };
		case "resumed":
			return { ...base, status: "success", outcome: "resumed", ...(at === undefined ? {} : { meta: [at] }) };
		case "failed": {
			const tool = stage === undefined ? lifecycleToolOrigin(details) : undefined;
			const where = at ?? (tool === undefined ? undefined : `at tool ${boundedNoticeLineText(tool)}`);
			return {
				...base,
				status: "failure",
				outcome: "failed",
				meta: [where, duration].filter((fact): fact is string => fact !== undefined),
			};
		}
		case "blocked":
			return {
				...base,
				status: "warning",
				outcome:
					details.budgetExceeded === true
						? "stopped at its budget limit"
						: details.active === true
							? "is blocked"
							: "ended blocked",
				...(at === undefined ? {} : { meta: [at] }),
			};
		case "budget_warning":
			return {
				...base,
				status: "warning",
				outcome: `is approaching its ${boundedNoticeLineText(details.budgetDimension ?? "duration")} budget`,
			};
		case "awaiting_input":
			return { ...base, status: "warning", outcome: "needs input", ...(at === undefined ? {} : { meta: [at] }) };
		case "paused":
			return { ...base, status: "paused", outcome: "paused", ...(at === undefined ? {} : { meta: [at] }) };
		case "quit":
			return {
				...base,
				status: "stopped",
				outcome: "was stopped",
				meta: [at, duration].filter((fact): fact is string => fact !== undefined),
			};
		default:
			return {
				...base,
				status: "success",
				outcome: "completed",
				...(duration === undefined ? {} : { meta: [duration] }),
			};
	}
}

function expandedNoticeDetails(details: WorkflowLifecycleNoticeDetails): string {
	const stage = details.stageName ?? details.failedStageId ?? details.stageId;
	const tool = stage === undefined ? lifecycleToolOrigin(details) : undefined;
	const reason =
		details.reason === undefined
			? details.error === undefined
				? undefined
				: summarizeNoticeFailureReason(details.error)
			: truncateSnippet(details.reason);
	const fields: readonly (readonly [string, string | undefined])[] = [
		["run", details.runId],
		["stage", stage],
		["tool", tool],
		["actor", details.actor],
		["launched", details.origin],
		["prompt", details.promptMessage],
		["reason", reason],
		["outputs", details.outputsPreview],
		["partial outputs", details.outputs === undefined ? undefined : boundedToolPayloadText(details.outputs)],
		["resumable", resumableFieldValue(details)],
	];
	const lines = fields.flatMap(([label, value]) =>
		value === undefined ? [] : [`${label} ${inertDisplayText(boundedToolText(value, NOTICE_TEXT_LIMIT))}`],
	);
	if (details.artifacts !== undefined) {
		for (const artifact of details.artifacts.shown.slice(0, NOTICE_ARTIFACTS_SHOWN)) {
			lines.push(
				boundedNoticeLineText(
					`artifact ${artifact.kind} ${artifact.path}${artifact.detail ? ` · ${artifact.detail}` : ""}`,
				),
			);
		}
		const remaining = details.artifacts.total - Math.min(details.artifacts.shown.length, NOTICE_ARTIFACTS_SHOWN);
		if (remaining > 0 && Number.isFinite(remaining))
			lines.push(`… +${remaining} more ${remaining === 1 ? "artifact" : "artifacts"}`);
	}
	const hints = lifecycleOutcomeHints(details);
	lines.push(
		...(hints.length > 0 ? hints.map(boundedNoticeLineText) : [`/workflows ${boundedNoticeLineText(details.runId)}`]),
	);
	return lines.join("\n");
}

function lifecycleOutcomeHints(details: WorkflowLifecycleNoticeDetails): string[] {
	if (details.scope !== "run") return [];
	if (details.kind === "completed") return [`/workflows ${details.runId}, then o: run details`];
	if (details.kind === "failed" || details.kind === "blocked")
		return [`full log: /workflows ${details.runId}, then o and l`];
	return [];
}

function cardOutputValueSlice(value: ToolPayloadValue): string {
	if (typeof value === "string" && value.length > SNIPPET_SCAN_WINDOW) {
		const head = value.slice(0, SNIPPET_SCAN_WINDOW);
		const firstBreak = head.search(/[\r\n]/);
		if (firstBreak !== -1) return inertDisplayLine(head.slice(0, firstBreak));
		const preview = inertDisplayLine(head);
		if (preview.replace(/\s+/g, " ").trim().length > LIFECYCLE_NOTICE_SNIPPET_LIMIT + 2) {
			return preview;
		}
	}
	return outputValueLine(value, LIFECYCLE_NOTICE_SNIPPET_LIMIT);
}

function formatCardOutputs(result: WorkflowOutputValues | undefined): string | undefined {
	if (result === undefined) return undefined;
	const entries = Object.entries(boundedToolPayloadRecord(result, LIFECYCLE_NOTICE_SNIPPET_LIMIT));
	if (entries.length === 0) return undefined;
	const parts: string[] = [];
	let length = 0;
	for (const [key, value] of entries) {
		const part = `${key}: ${cardOutputValueSlice(value)}`;
		parts.push(part);
		length += part.trim().length;
		if (
			length > LIFECYCLE_NOTICE_SNIPPET_LIMIT * 2 &&
			parts.join(" \u00b7 ").replace(/\s+/g, " ").trim().length > LIFECYCLE_NOTICE_SNIPPET_LIMIT + 2
		) {
			break;
		}
	}
	return truncateSnippet(parts.join(" \u00b7 "));
}

function resumableFieldValue(details: WorkflowLifecycleNoticeDetails): string | undefined {
	if (details.resumable === undefined) return undefined;
	return details.resumable ? "yes" : "no";
}

function formatDurationMs(durationMs: number | undefined): string | undefined {
	return durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
		? fmtDuration(durationMs)
		: undefined;
}
