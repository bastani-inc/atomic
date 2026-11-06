import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
	type AgentRehydrateError,
	type AgentWake,
	type AgentWakeDispatcher,
	agentWakeDispatcher,
	type DetachedToolCall,
	type DetachedToolResult,
	type ExtensionContext,
	type SessionManager,
} from "@bastani/atomic";
import type { ChildTaskCompletionRoute } from "../../../../coding-agent/src/core/tasks/child-command-owner.js";
import type { SubagentReleased, SubagentReleasePolicy } from "../inprocess/runner.js";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import {
	releasedReplyTimeoutId,
	scheduleReleasedReplyTimeouts,
	withReleasedReplyTimeouts,
} from "./released-child-replies.js";
import { type ReleasedChildResumeWake, setReleasedChildWakeActive, settleResumeWake } from "./released-child-resume.js";
import { isReleasedReplyHandoffResult } from "./released-reply-protocol.js";
import { indexSubagentChildOwner, subagentChildRecordOf } from "./subagent-child-card-state.js";
import {
	observeChildRecordFailure,
	recordSubagentChildHeldToolResults,
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	type SubagentChildRecordSink,
	type SubagentChildWaitingCall,
	subagentChildOwner,
	subagentChildRecordsAppended,
} from "./subagent-child-records.js";
import type { SubagentChildRestoreOutcome, SubagentChildResumeRequest } from "./subagent-child-restore.js";

/** How long a background child waits on a detachable tool call inline before it is released (#4326). */
export const SUBAGENT_RELEASE_AFTER_MS = 60_000;

/** What a woken child is told when no message of its own wakes it. */
export const SUBAGENT_RELEASED_WAKE_PROMPT =
	"You were released while you waited, and something you were waiting for arrived: read the new messages and tool results, then continue your task. If you have finished, stop.";

/** The result a still-running detached call gets when its child is woken by something else first. */
export const SUBAGENT_STILL_RUNNING_RESULT =
	"This call is still running in the background. Its result arrives later as a message; do not start it again.";

/** The wake namespace of the children one owner session launched: one handler per owner, never one per child. */
export function subagentWakeNamespace(ownerSessionId: string): string {
	return `subagents/${ownerSessionId}`;
}

/** The wake key of one child, `subagents/<owner session id>:<child id>`. */
export function subagentWakeKey(ownerSessionId: string, childId: string): string {
	return `${subagentWakeNamespace(ownerSessionId)}:${childId}`;
}

export const SUBAGENT_OWNER_GENERATION = randomUUID();

const REDISPATCH_WAKE_PREFIX = "redispatch:";

function isRedispatchWake(wake: AgentWake): boolean {
	return wake.id.startsWith(REDISPATCH_WAKE_PREFIX);
}

function waitsOnHeldResult(record: SubagentChildRecord): boolean {
	return (record.waitingOn ?? []).some((call) =>
		(record.heldToolResults ?? []).some((held) => held.toolCallId === call.toolCallId),
	);
}

function releasedByEarlierProcess(record: SubagentChildRecord): boolean {
	return (
		record.state === "terminal" &&
		record.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS &&
		record.ownerGeneration !== SUBAGENT_OWNER_GENERATION
	);
}

export function needsRedispatch(record: SubagentChildRecord): boolean {
	return (
		releasedByEarlierProcess(record) &&
		(record.waitingOn?.length ?? 0) > 0 &&
		!(record.waitingOn ?? []).some((call) => call.replyWait !== undefined) &&
		!waitsOnHeldResult(record)
	);
}

export function wakeReleasedChildrenOfEarlierProcess(
	dispatcher: AgentWakeDispatcher,
	ownerSessionId: string,
	records: readonly SubagentChildRecord[],
): void {
	for (const record of records) {
		const wakeKey = subagentWakeKey(ownerSessionId, record.childId);
		scheduleReleasedReplyTimeouts(
			dispatcher,
			wakeKey,
			(record.waitingOn ?? []).filter(
				(call) => !(record.heldToolResults ?? []).some((held) => held.toolCallId === call.toolCallId),
			),
		);
		if (!releasedByEarlierProcess(record)) continue;
		if (needsRedispatch(record))
			void dispatcher
				.deliver(wakeKey, { id: `${REDISPATCH_WAKE_PREFIX}${SUBAGENT_OWNER_GENERATION}`, kind: "tool-result" })
				.catch((error) => dispatcher.reportUnobservedFailure(error));
		else if (waitsOnHeldResult(record))
			wakeReleasedChildWithHeldResults(dispatcher, wakeKey, SUBAGENT_OWNER_GENERATION);
	}
}

/**
 * The async context of this module's load, outside every task and session. A promise reaction keeps the async context
 * it was created in alive, so a reaction made inside a child's task would keep that task's launch input reachable for
 * as long as the call it waits on runs.
 */
const outsideAnyTask = AsyncLocalStorage.snapshot();

function deliverToolResult(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	toolResult: DetachedToolResult,
): Promise<void> {
	return dispatcher.deliver(wakeKey, { id: `tool-result:${toolResult.toolCallId}`, kind: "tool-result", toolResult });
}

async function deliverDetachedResult(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	replyQuestionId: string | undefined,
	toolResult: DetachedToolResult,
): Promise<void> {
	if (isReleasedReplyHandoffResult(toolResult.result.details)) return;
	if (replyQuestionId !== undefined) dispatcher.cancel(wakeKey, releasedReplyTimeoutId(replyQuestionId));
	await deliverToolResult(dispatcher, wakeKey, toolResult);
}

/**
 * The one reaction a released child keeps on a call it detached. It holds the wake key and the call's reply question,
 * not the call, its controller or the child's waiting records (#4403).
 */
function forwardResult(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	result: Promise<DetachedToolResult>,
	replyQuestionId: string | undefined,
): void {
	const report = (error: AgentRehydrateError) => dispatcher.reportUnobservedFailure(error);
	void result.then(
		(toolResult) => deliverDetachedResult(dispatcher, wakeKey, replyQuestionId, toolResult).catch(report),
		report,
	);
}

function forwardDetachedResult(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	call: DetachedToolCall,
	waitingOn: readonly SubagentChildWaitingCall[],
): void {
	forwardResult(dispatcher, wakeKey, call.result, replyQuestionOf(waitingOn, call.toolCallId));
}

function replyQuestionOf(waitingOn: readonly SubagentChildWaitingCall[], toolCallId: string): string | undefined {
	return waitingOn.find((item) => item.toolCallId === toolCallId)?.replyWait?.questionId;
}

/**
 * Hand each detached call's result to the dispatcher as a `tool-result` wake for the child, once, when it settles.
 * Nothing waits per child: each call's own operation carries its delivery.
 */
export function forwardDetachedResults(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	calls: readonly DetachedToolCall[],
	waitingOn: readonly SubagentChildWaitingCall[] = [],
): void {
	for (const call of calls) outsideAnyTask(forwardDetachedResult, dispatcher, wakeKey, call, waitingOn);
}

function wakeWithHeldResults(dispatcher: AgentWakeDispatcher, wakeKey: string, id: string): void {
	void dispatcher
		.deliver(wakeKey, { id: `held-results:${id}`, kind: "tool-result" })
		.catch((error) => dispatcher.reportUnobservedFailure(error));
}

/**
 * Results that arrived while the child still ran are held in its record. Once its run's terminal or released record
 * is written they have nobody waiting for them, so one wake hands them over: the handler takes every result the
 * record holds. `id` names the run whose end sends the wake, so it is sent once.
 */
export function wakeReleasedChildWithHeldResults(dispatcher: AgentWakeDispatcher, wakeKey: string, id: string): void {
	outsideAnyTask(wakeWithHeldResults, dispatcher, wakeKey, id);
}

/** The release policy of one background child: release after `afterMs` of waiting on a detachable call. */
export function subagentReleasePolicy(afterMs: number = SUBAGENT_RELEASE_AFTER_MS): SubagentReleasePolicy {
	return { afterMs };
}

/** The calls a reopened transcript ends on without results: the last assistant turn's unanswered tool calls. */
export function pendingToolCalls(sessionManager: Pick<SessionManager, "buildSessionProjection">): Map<string, string> {
	const messages = sessionManager.buildSessionProjection().messages;
	const index = messages.findLastIndex((message) => message.role === "assistant");
	const assistant = messages[index];
	const pending = new Map<string, string>();
	if (assistant?.role !== "assistant" || assistant.stopReason !== "toolUse") return pending;
	const later = messages.slice(index + 1);
	if (later.some((message) => message.role === "user")) return pending;
	const answered = new Set(later.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
	for (const part of assistant.content)
		if (part.type === "toolCall" && !answered.has(part.id)) pending.set(part.id, part.name);
	return pending;
}

function resultText(result: DetachedToolResult): string {
	const text = (result.result.content ?? [])
		.map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
		.join("\n")
		.trim();
	return text || "(no output)";
}

/** A result that arrived after its call was answered, delivered as a message. */
export function lateToolResultMessage(result: DetachedToolResult): string {
	return `The ${result.toolName} call ${result.toolCallId} that kept running in the background ${result.isError ? "failed" : "finished"}:\n${resultText(result)}`;
}

/** How a woken child continues: results recorded as its pending calls' results, then messages and its prompt. */
export interface ReleasedChildWakePlan {
	/** Results for the calls its transcript ends on, including a still-running result for each call with none yet. */
	readonly resumeToolResults: readonly DetachedToolResult[];
	/** Results of calls answered already, delivered as messages before the prompt, in arrival order. */
	readonly lateMessages: readonly string[];
	/** The wake is only those results: the continued turn is the whole run. */
	readonly skipPrompt: boolean;
}

/**
 * Plan a wake from the calls the transcript is waiting on and the results that arrived. When the results answer every
 * pending call and nothing else woke the child, the turn simply continues. Otherwise every pending call is answered
 * first, a call still running with {@link SUBAGENT_STILL_RUNNING_RESULT}, so the transcript never ends on a call
 * without a result before a new message.
 */
export function planReleasedChildWake(
	pending: ReadonlyMap<string, string>,
	results: readonly DetachedToolResult[],
	hasOtherInput: boolean,
): ReleasedChildWakePlan {
	const seen = new Set<string>();
	const unique = results.filter((result) => !seen.has(result.toolCallId) && seen.add(result.toolCallId));
	const onTime = unique.filter((result) => pending.has(result.toolCallId));
	const late = unique.filter((result) => !pending.has(result.toolCallId));
	const stillRunning: DetachedToolResult[] = [...pending]
		.filter(([toolCallId]) => !onTime.some((result) => result.toolCallId === toolCallId))
		.map(([toolCallId, toolName]) => ({
			toolCallId,
			toolName,
			result: { content: [{ type: "text", text: SUBAGENT_STILL_RUNNING_RESULT }], details: undefined },
			isError: false,
		}));
	return {
		resumeToolResults: [...onTime, ...stillRunning],
		lateMessages: late.map(lateToolResultMessage),
		skipPrompt: !hasOtherInput && late.length === 0,
	};
}

/** Statuses after which a child takes nothing more. */
const ENDED: ReadonlySet<string | undefined> = new Set([
	"killed",
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_GONE_STATUS,
]);
/** Statuses run control set: results wait in the record for `resume`, and messages do not wake the child. */
const STOPPED: ReadonlySet<string | undefined> = new Set(["paused", "quit", SUBAGENT_CHILD_STAGE_PAUSED_STATUS]);

/** What the owner does with a batch of wakes for one child, by the child's latest record. */
export type ReleasedChildWakeDecision =
	| { readonly kind: "ignore" }
	| { readonly kind: "hold"; readonly toolResults: readonly DetachedToolResult[] }
	| { readonly kind: "wake"; readonly toolResults: readonly DetachedToolResult[]; readonly prompt: boolean };

/**
 * Decide a batch of wakes: an ended child or a stopped child with no new result ignores it; a stopped or live child
 * keeps the new results for later; a released child, or a settled one that holds or is reached by a late result, is
 * woken with every result it holds. Messages and asks wake only a released child: a live one already has them.
 */
export function decideReleasedChildWake(
	record: Pick<SubagentChildRecord, "state" | "terminalStatus" | "heldToolResults">,
	wakes: readonly AgentWake[],
): ReleasedChildWakeDecision {
	const status = record.terminalStatus;
	const held = record.heldToolResults ?? [];
	const arrived = wakes.flatMap((wake) => (wake.toolResult === undefined ? [] : [wake.toolResult]));
	const fresh = arrived.filter(
		(result, index) =>
			!held.some((kept) => kept.toolCallId === result.toolCallId) &&
			arrived.findIndex((other) => other.toolCallId === result.toolCallId) === index,
	);
	const toolResults = [...held, ...fresh];
	if (ENDED.has(status)) return { kind: "ignore" };
	if (record.state === "running" || STOPPED.has(status))
		return fresh.length === 0 ? { kind: "ignore" } : { kind: "hold", toolResults: fresh };
	const prompt = wakes.some((wake) => wake.kind !== "tool-result");
	if (status === SUBAGENT_CHILD_RELEASED_STATUS) return { kind: "wake", toolResults, prompt };
	return toolResults.length === 0 ? { kind: "ignore" } : { kind: "wake", toolResults, prompt: false };
}

export interface ReleasedChildWakeActions {
	readonly wake: (
		record: SubagentChildRecord,
		decision: Extract<ReleasedChildWakeDecision, { kind: "wake" }>,
	) => Promise<void>;
	readonly hold: (record: SubagentChildRecord, toolResults: readonly DetachedToolResult[]) => Promise<void>;
	readonly resume?: (
		record: SubagentChildRecord,
		request: SubagentChildResumeRequest,
	) => Promise<SubagentChildRestoreOutcome>;
	readonly redispatch?: (record: SubagentChildRecord) => Promise<void>;
	readonly fail?: (
		record: SubagentChildRecord,
		toolResults: readonly DetachedToolResult[],
		failure: ReleasedChildError,
	) => Promise<void>;
}

function wakeFailureOf(error: Error, childId: string): ReleasedChildError {
	return isReleasedChildError(error)
		? error
		: new ReleasedChildError("wake-failed", { childId, reason: error.message }, { cause: error });
}

/**
 * Wakes this owner's children through `actions`; returns the function that stops handling them. A wake that fails
 * hands the batch's results and the failure to `actions.fail` before it fails, so nothing it carried is lost.
 */
export function handleReleasedChildWakes(
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
	actions: ReleasedChildWakeActions,
	dispatcher: AgentWakeDispatcher = agentWakeDispatcher(),
	maxConcurrent?: number,
): () => void {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const namespace = subagentWakeNamespace(ownerSessionId);
	const latest = async (childId: string): Promise<SubagentChildRecord> => {
		await subagentChildRecordsAppended(ownerSessionId);
		indexSubagentChildOwner(ctx);
		const record = subagentChildRecordOf(ownerSessionId, childId);
		if (record === undefined) throw new ReleasedChildError("child-record-missing", { ownerSessionId, childId });
		return record;
	};
	// A reload's newer extension generation takes the owner's children over before the older one shuts down.
	return dispatcher.handle(
		namespace,
		async (wakeKey, wakes) => {
			const childId = wakeKey.slice(namespace.length + 1);
			const record = await latest(childId);
			setReleasedChildWakeActive(wakeKey, true);
			try {
				const redispatch =
					actions.redispatch !== undefined && wakes.some(isRedispatchWake) && needsRedispatch(record);
				if (redispatch) await actions.redispatch?.(record);
				const current = redispatch ? await latest(childId) : record;
				const others = withReleasedReplyTimeouts(
					current,
					wakes.filter((wake) => !isRedispatchWake(wake)),
				);
				if (others.length === 0) return;
				const resumes = others.filter((wake): wake is ReleasedChildResumeWake => wake.id.startsWith("resume:"));
				if (resumes.length > 0 && actions.resume !== undefined) {
					const first = resumes[0];
					if (first === undefined) return;
					const extraMessages = resumes
						.slice(1)
						.flatMap((wake) => (wake.resume.message ? [wake.resume.message] : []));
					const toolResults = others.flatMap((wake) => (wake.toolResult === undefined ? [] : [wake.toolResult]));
					const outcome = await actions.resume(current, {
						...first.resume,
						toolResults,
						followUps: extraMessages,
					});
					for (const wake of resumes) settleResumeWake(wake.id, outcome);
					return;
				}
				const decision = decideReleasedChildWake(current, others);
				if (decision.kind === "hold") await actions.hold(current, decision.toolResults);
				else if (decision.kind === "wake") await actions.wake(current, decision);
			} catch (error) {
				const results = withReleasedReplyTimeouts(record, wakes).flatMap((wake) =>
					wake.toolResult === undefined ? [] : [wake.toolResult],
				);
				await actions.fail?.(record, results, wakeFailureOf(error as Error, childId)).catch((secondary: Error) => {
					observeChildRecordFailure(ownerSessionId, wakeFailureOf(secondary, childId));
				});
				throw error;
			} finally {
				setReleasedChildWakeActive(wakeKey, false);
			}
		},
		{ replace: true, ...(maxConcurrent === undefined ? {} : { maxConcurrent }) },
	);
}

/** Keep new results for a child that cannot take them now, durably, beside those it holds, for its next wake or resume. */
export function holdToolResultsInRecord(
	pi: Parameters<typeof recordSubagentChildHeldToolResults>[0],
): (record: SubagentChildRecord, toolResults: readonly DetachedToolResult[]) => Promise<void> {
	return async (record, toolResults) => {
		await recordSubagentChildHeldToolResults(pi, record.owner.sessionId, record.childId, toolResults);
	};
}

function wakeForTaskCompletion(dispatcher: AgentWakeDispatcher, wakeKey: string, completionId: string): void {
	void dispatcher
		.deliver(wakeKey, { id: `task-completion:${completionId}`, kind: "task-completion" })
		.catch((error) => dispatcher.reportUnobservedFailure(error));
}

function completionIdOf(details: object): string {
	const completionId = (details as { readonly completionId?: string }).completionId;
	return typeof completionId === "string" ? completionId : randomUUID();
}

/**
 * The route the completions of shell tasks a released child launched take to that child: each is held in its record
 * and wakes it, or waits for its resume when it is stopped. A child that runs again or has ended holds none, so the
 * session that launched it receives the notice instead.
 */
export function releasedChildShellRoute(
	holdMessages: NonNullable<SubagentChildRecordSink["holdMessages"]>,
	ownerSessionId: string,
	childId: string,
	dispatcher: AgentWakeDispatcher,
): ChildTaskCompletionRoute {
	return {
		isOpen: () => true,
		deliver: async (message) => {
			const outcome = await holdMessages(childId, [message.content]);
			if (outcome === "not-held") throw new ReleasedChildError("completion-not-held", { ownerSessionId, childId });
			if (outcome === "released")
				outsideAnyTask(
					wakeForTaskCompletion,
					dispatcher,
					subagentWakeKey(ownerSessionId, childId),
					completionIdOf(message.details),
				);
		},
	};
}

/**
 * Route the completions of shell tasks a just-released child launched and that still run to that child, so they
 * wake it instead of reaching the session that launched it. A child with no such task keeps nothing here.
 */
export function routeReleasedChildShellCompletions(
	released: Pick<SubagentReleased, "routeShellCompletions">,
	holdMessages: NonNullable<SubagentChildRecordSink["holdMessages"]>,
	ownerSessionId: string,
	childId: string,
	dispatcher: AgentWakeDispatcher,
): void {
	try {
		released.routeShellCompletions?.(releasedChildShellRoute(holdMessages, ownerSessionId, childId, dispatcher));
	} catch (error) {
		observeChildRecordFailure(
			ownerSessionId,
			new ReleasedChildError("completion-not-held", { ownerSessionId, childId }, { cause: error as Error }),
		);
	}
}
