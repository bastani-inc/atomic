import {
	actionableReturnedStatusText,
	effectiveRunStatus,
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
import type { WorkflowOutputValues } from "../shared/types.js";
import { deriveGraphThemeFromPiTheme, type GraphTheme } from "../tui/graph-theme.js";
import { renderWorkflowNoticeCard, type WorkflowNoticeTone } from "../tui/workflow-notice-card.js";
import type { ExtensionAPI, PiMessageRenderComponent, PiMessageRenderer } from "./index.js";
import { createLifecycleNoticeDelivery } from "./lifecycle-notification-delivery.js";

export const LIFECYCLE_NOTICE_CUSTOM_TYPE = "workflows:lifecycle-notice";
export const LIFECYCLE_NOTICE_SNIPPET_LIMIT = 240;

export type WorkflowLifecycleNoticeKind =
	| "started"
	| "completed"
	| "failed"
	| "blocked"
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
	readonly failedStageId?: string;
	readonly toolNodeId?: string;
	readonly toolName?: string;
	readonly durationMs?: number;
	readonly active?: boolean;
	/** Whether a failed author exit or quit run advertises itself as resumable. */
	readonly resumable?: boolean;
	/** Who performed this lifecycle action, when a control path attributed it. */
	readonly actor?: WorkflowActor;
	/** Who launched the run, when the launch was attributed. */
	readonly origin?: WorkflowActor;
	/** Source run this run continues, for a resumed continuation with a fresh id. */
	readonly continuedFromRunId?: string;
	readonly createdAt: number;
}

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
		delivery.deliver(key, makeTerminalNotice(run, kind));
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
		// See stage-level awaiting-input handling above: prompt state remains visible
		// through workflow status/connect surfaces instead of the main chat context.
	};

	const inspect = (snapshot: StoreSnapshot): void => {
		for (const run of snapshot.runs) {
			if (!isTopLevelWorkflowRun(run)) continue;
			emitTerminalNoticeOnce(run, "completed");
			emitTerminalNoticeOnce(run, "failed");
			emitTerminalNoticeOnce(run, "blocked");
			emitControlNoticesOnce(run);

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

	const renderer: RawRenderer = (raw, _options, piTheme) => {
		const message = raw as { details?: WorkflowLifecycleNoticeDetails };
		if (!message.details) return undefined;
		return makeNoticeComponent(message.details, themeFromRenderer(piTheme));
	};

	register(LIFECYCLE_NOTICE_CUSTOM_TYPE, renderer);
	rendererRegisteredHosts.add(host);
}

export function formatWorkflowLifecycleNoticeText(details: WorkflowLifecycleNoticeDetails): string {
	const workflowName = escapeQuotedText(details.workflowName);
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
		return `✓ Workflow "${workflowName}" completed (run ${details.runId})${origin}. Inspect: /workflow status ${details.runId}`;
	}
	if (details.kind === "failed") {
		const stage = details.stageName ?? details.failedStageId ?? details.stageId;
		const tool = lifecycleToolOrigin(details);
		const failureSite = stage ? `, stage ${stage}` : tool !== undefined ? `, tool ${tool}` : "";
		const errorText = details.error ? `: ${details.error}` : "";
		const outputsText = formatLifecycleOutputs(details.outputs);
		const outputSuffix = outputsText === undefined ? "" : ` Partial outputs: ${outputsText}`;
		return `✗ Workflow "${workflowName}" failed (run ${details.runId}${failureSite})${origin}${errorText}${outputSuffix}. Inspect: /workflow status ${details.runId}`;
	}
	if (details.kind === "blocked") {
		const errorText = details.error ? `: ${details.error}` : "";
		const stateText = details.active === true ? "is blocked" : "ended blocked";
		return `! Workflow "${workflowName}" ${stateText} (run ${details.runId})${origin}${errorText}. Inspect: /workflow status ${details.runId}`;
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
		return `${glyph} ${actor} ${verb} the ${scopeText} "${workflowName}" (run ${details.runId})${origin}${stageText}. This ${noun} was deliberate and user-requested; do not resume it or take over the work unless asked. Resume: /workflow resume ${details.runId}`;
	}
	if (details.kind === "resumed") {
		const resumedStage = details.stageName ?? details.stageId;
		const stageText = resumedStage ? `${origin === "" ? "" : ","} at stage ${resumedStage}` : "";
		const scopeText = details.scope === "stage" ? "stage of workflow" : "workflow";
		const continues =
			details.continuedFromRunId === undefined ? "" : `, continuing run ${details.continuedFromRunId}`;
		return `▶ ${actor} resumed the ${scopeText} "${workflowName}" (run ${details.runId}${continues})${origin}${stageText}. It is running again in the background.`;
	}
	const prompt = details.promptMessage ? ` Prompt: ${details.promptMessage}` : "";
	if (details.scope === "run") {
		return `？ Workflow "${workflowName}" needs input (run ${details.runId}).${prompt} Respond: /workflow connect ${details.runId} to answer this run-level prompt.`;
	}
	const stage = details.stageName ?? details.stageId ?? "unknown";
	const responseHint =
		details.stageId && details.promptId
			? `/workflow connect ${details.runId} or workflow({ action: "send", runId: ${jsonString(details.runId)}, stageId: ${jsonString(details.stageId)}, promptId: ${jsonString(details.promptId)}, response: ... })`
			: `/workflow connect ${details.runId}`;
	return `？ Workflow "${workflowName}" needs input (run ${details.runId}, stage ${stage}).${prompt} Respond: ${responseHint}.`;
}

function makeTerminalNotice(
	run: RunSnapshot,
	kind: "completed" | "failed" | "blocked",
): WorkflowLifecycleNoticeDetails {
	const failedStage = run.failedStageId ? run.stages.find((stage) => stage.id === run.failedStageId) : undefined;
	const failedToolNodeId = kind === "failed" && run.failedStageId === undefined ? run.failedToolNodeId : undefined;
	const failedTool = (run.toolNodes ?? []).find((node) => node.id === failedToolNodeId);
	const activeBlocked = kind === "blocked" && isActiveRecoverableBlockedRun(run);
	const outputs = kind === "failed" && run.exited === true && run.result !== undefined ? run.result : undefined;
	const error = activeBlocked
		? (run.failureMessage ?? structuredRecoverableWorkflowFailureText(run) ?? run.error)
		: (run.error ??
			returnedNoticeError(run, kind) ??
			(kind === "blocked" || kind === "failed" ? run.exitReason : undefined));
	return {
		kind,
		scope: "run",
		runId: run.id,
		workflowName: run.name,
		status: effectiveRunStatus(run),
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
		// Attribution renders on every kind, and is omitted for a run that never
		// recorded an origin rather than guessed at.
		...(run.origin !== undefined ? { origin: run.origin } : {}),
		createdAt: lifecycleOccurrenceAt(run, kind) ?? Date.now(),
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
		...(occurrence.kind === "resumed" && run.resumedFromRunId !== undefined
			? { continuedFromRunId: run.resumedFromRunId }
			: {}),
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
	if (process.env.ATOMIC_WORKFLOW_DEBUG !== "1") return;
	const message = error instanceof Error ? error.message : String(error);
	console.warn("[workflows] workflow lifecycle notice send failed", message);
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
	return run.blockedAt !== undefined && structuredRecoverableWorkflowFailureText(run) !== undefined;
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
	const occurrence = kind === "blocked" ? (run.blockedAt ?? lifecycleOccurrenceAt(run, kind)) : "";
	return occurrence === undefined ? `${kind}:${run.id}` : `${kind}:${run.id}:${occurrence}`;
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
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= LIFECYCLE_NOTICE_SNIPPET_LIMIT) return normalized;
	return `${normalized.slice(0, LIFECYCLE_NOTICE_SNIPPET_LIMIT - 1)}…`;
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
	theme: GraphTheme | undefined,
): PiMessageRenderComponent {
	const text = formatWorkflowLifecycleNoticeText(details);
	return {
		render(width: number): string[] {
			// Width < 32 cannot carry rounded card chrome without exceeding the
			// terminal, so the card helper falls back to wrapped plain text there.
			return renderLifecycleNoticeCard(details, { width, theme, fallbackText: text });
		},
		invalidate() {
			/* stored lifecycle notices are immutable */
		},
	};
}

function renderLifecycleNoticeCard(
	details: WorkflowLifecycleNoticeDetails,
	opts: { width: number; theme?: GraphTheme; fallbackText: string },
): string[] {
	const tone: WorkflowNoticeTone = lifecycleNoticeTone(details.kind);
	const title = lifecycleNoticeTitle(details.kind);
	const glyph = lifecycleNoticeGlyph(details.kind);
	const stage = details.stageName ?? details.failedStageId ?? details.stageId;
	const tool = stage === undefined ? lifecycleToolOrigin(details) : undefined;
	const headline = lifecycleNoticeHeadline(details);
	return renderWorkflowNoticeCard({
		title,
		glyph,
		headline,
		tone,
		fields: [
			{ label: "workflow", value: details.workflowName },
			{ label: "run", value: details.runId },
			{ label: "continues", value: details.continuedFromRunId },
			{ label: "stage", value: stage },
			{ label: "tool", value: tool },
			{ label: "actor", value: details.actor, tone: "muted" },
			{ label: "launched", value: details.origin, tone: "muted" },
			{ label: "prompt", value: details.promptMessage, tone: "muted" },
			{ label: "error", value: details.error, tone: "error" },
			{
				label: "partial outputs",
				value: formatLifecycleOutputs(details.outputs),
				tone: "muted",
			},
			{ label: "resumable", value: resumableFieldValue(details), tone: "muted" },
			{ label: "duration", value: formatDurationMs(details.durationMs), tone: "muted" },
		],
		hints: [lifecycleNoticeHint(details)],
		fallbackText: opts.fallbackText,
		width: opts.width,
		...(opts.theme ? { theme: opts.theme } : {}),
	});
}

function lifecycleNoticeTone(kind: WorkflowLifecycleNoticeKind): WorkflowNoticeTone {
	switch (kind) {
		case "failed":
			return "error";
		case "blocked":
		case "awaiting_input":
		case "paused":
		case "quit":
			return "warning";
		default:
			return "success";
	}
}

function lifecycleNoticeTitle(kind: WorkflowLifecycleNoticeKind): string {
	switch (kind) {
		case "started":
			return "WORKFLOW STARTED";
		case "failed":
			return "WORKFLOW FAILED";
		case "awaiting_input":
			return "WORKFLOW INPUT";
		case "blocked":
			return "WORKFLOW BLOCKED";
		case "paused":
			return "WORKFLOW PAUSED";
		case "quit":
			return "WORKFLOW QUIT";
		case "resumed":
			return "WORKFLOW RESUMED";
		default:
			return "WORKFLOW COMPLETE";
	}
}

function lifecycleNoticeGlyph(kind: WorkflowLifecycleNoticeKind): string {
	switch (kind) {
		case "failed":
			return "✗";
		case "awaiting_input":
			return "？";
		case "blocked":
			return "!";
		case "paused":
			return "⏸";
		case "quit":
			return "⏹";
		case "started":
		case "resumed":
			return "▶";
		default:
			return "✓";
	}
}

function lifecycleNoticeHeadline(details: WorkflowLifecycleNoticeDetails): string {
	const name = details.workflowName;
	const scope = details.scope === "stage" ? "Stage of workflow" : "Workflow";
	switch (details.kind) {
		case "started":
			return `Workflow "${name}" started`;
		case "failed":
			return `Workflow "${name}" failed`;
		case "awaiting_input":
			return `Workflow "${name}" needs input`;
		case "blocked":
			return `Workflow "${name}" ${details.active === true ? "is blocked" : "ended blocked"}`;
		case "paused":
			return `${scope} "${name}" paused`;
		case "quit":
			return `Workflow "${name}" quit`;
		case "resumed":
			return `${scope} "${name}" resumed`;
		default:
			return `Workflow "${name}" completed`;
	}
}

function lifecycleNoticeHint(details: WorkflowLifecycleNoticeDetails): string {
	if (details.kind === "awaiting_input") return `/workflow connect ${details.runId}`;
	if (details.kind === "paused" || details.kind === "quit") return `/workflow resume ${details.runId}`;
	return `/workflow status ${details.runId}`;
}

function resumableFieldValue(details: WorkflowLifecycleNoticeDetails): string | undefined {
	if (details.resumable === undefined) return undefined;
	return details.resumable ? "yes" : "no";
}

function formatDurationMs(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${durationMs}ms`;
	const seconds = durationMs / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = Math.round(seconds % 60);
	return `${minutes}m ${remainder}s`;
}

function themeFromRenderer(piTheme: unknown): GraphTheme | undefined {
	return piTheme === undefined ? undefined : deriveGraphThemeFromPiTheme(piTheme);
}
