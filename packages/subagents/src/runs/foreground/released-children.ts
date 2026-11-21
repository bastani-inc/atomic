import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
	type AgentRehydrateError,
	type AgentWake,
	type AgentWakeDispatcher,
	type AgentWakeSlot,
	agentWakeDispatcher,
	type DetachedToolCall,
	type DetachedToolResult,
	type ExtensionContext,
	type SessionEntry,
	type SessionManager,
} from "@bastani/atomic";
import type { ChildTaskCompletionRoute } from "../../../../coding-agent/src/core/tasks/child-command-owner.js";
import type { SubagentReleased, SubagentReleasePolicy } from "../inprocess/runner.js";
import { lateToolResultNoticeIds, legacyLateToolResultMessage } from "./late-tool-result-notice.js";
import { SUBAGENT_OWNER_GENERATION } from "./owner-generation.js";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import { SUBAGENT_QUESTION_TOOLS } from "./released-child-questions.js";
import {
	releasedReplyTimeoutId,
	scheduleReleasedReplyTimeouts,
	withReleasedReplyTimeouts,
} from "./released-child-replies.js";
import {
	type ReleasedChildResumeWake,
	setReleasedChildWakeActive,
	settleResumeWake,
	takeReleasedChildResume,
} from "./released-child-resume.js";
import { isReleasedReplyHandoffResult } from "./released-reply-protocol.js";
import {
	indexSubagentChildOwner,
	keepSubagentChildRecord,
	subagentChildRecordOf,
} from "./subagent-child-card-state.js";
import {
	holdInterruptedStillRunningCalls,
	observeChildRecordFailure,
	recordSubagentChildHeldToolResults,
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
	type SubagentChildRecordSink,
	type SubagentChildStillRunningCall,
	type SubagentChildWaitingCall,
	subagentChildOwner,
	subagentChildRecordsAppended,
} from "./subagent-child-records.js";
import type { SubagentChildRestoreOutcome, SubagentChildResumeRequest } from "./subagent-child-restore.js";

export { SUBAGENT_OWNER_GENERATION } from "./owner-generation.js";

/** How long a background child waits on a detachable tool call inline before it is released (#4326). */
export const SUBAGENT_RELEASE_AFTER_MS = 60_000;

export { SUBAGENT_RELEASED_WAKE_PROMPT } from "./released-wake-prompt.js";

/** The result a still-running detached call gets when its child is woken by something else first. */
export const SUBAGENT_STILL_RUNNING_RESULT =
	"This call is still running in the background. Its result arrives later as a message; do not start it again.";

/** The result a detached call gets when the owner process it ran in has gone, so its result never arrives (#4848). */
export const SUBAGENT_INTERRUPTED_BY_RESTART_RESULT =
	"This call was interrupted when Atomic restarted, so its result will never arrive. Re-run it if you still need it.";

/** The wake namespace of the children one owner session launched: one handler per owner, never one per child. */
export function subagentWakeNamespace(ownerSessionId: string): string {
	return `subagents/${ownerSessionId}`;
}

/** The wake key of one child, `subagents/<owner session id>:<child id>`. */
export function subagentWakeKey(ownerSessionId: string, childId: string): string {
	return `${subagentWakeNamespace(ownerSessionId)}:${childId}`;
}

const REDISPATCH_WAKE_PREFIX = "redispatch:";

function isRedispatchWake(wake: AgentWake): boolean {
	return wake.id.startsWith(REDISPATCH_WAKE_PREFIX);
}

function isResumeWake(wake: AgentWake): wake is ReleasedChildResumeWake {
	return wake.id.startsWith("resume:");
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

/**
 * Whether a call a child's transcript ends on died with an earlier owner process (#4848): the child was released by
 * an earlier generation, so nothing in this process forwards the call's result. A question's reply is routed by the
 * broker instead, so it still arrives.
 */
export function interruptedByRestart(
	record: Pick<SubagentChildRecord, "waitingOn" | "ownerGeneration">,
): (toolCallId: string) => boolean {
	// A child waiting on nothing, such as one whose run reset what it waits on, lost nothing to the restart.
	if (!record.waitingOn?.length || record.ownerGeneration === SUBAGENT_OWNER_GENERATION) return () => false;
	const questions = new Set(
		record.waitingOn.flatMap((call) => (call.replyWait === undefined ? [] : [call.toolCallId])),
	);
	return (toolCallId) => !questions.has(toolCallId);
}

/** The result a call told "still running" gets once the owner process that ran it is gone (#5014). */
export function interruptedStillRunningResult(call: Pick<SubagentChildStillRunningCall, "toolCallId" | "toolName">) {
	return {
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		result: {
			content: [{ type: "text" as const, text: SUBAGENT_INTERRUPTED_BY_RESTART_RESULT }],
			details: undefined,
		},
		isError: true,
	} satisfies DetachedToolResult;
}

/**
 * Hold the interrupted result of each call a child was told is still running by an earlier owner process (#5014), and
 * wake a child that ended on its own for it; any other child takes it when it is restored, woken or resumed. A question
 * lost with that process is no reason to relaunch a child that already finished (#6168): its next wake or resume tells
 * it once, so a child that ended is woken only when one of those calls was not a question.
 */
export function reportInterruptedStillRunningCalls(
	pi: Parameters<typeof holdInterruptedStillRunningCalls>[0],
	dispatcher: AgentWakeDispatcher,
	ownerSessionId: string,
	records: readonly SubagentChildRecord[],
): void {
	for (const record of records) {
		if (!record.stillRunning?.length) continue;
		// Read from the calls the hold actually reports, in its own read of the child's latest record.
		let reportsOtherThanQuestions = false;
		void holdInterruptedStillRunningCalls(pi, ownerSessionId, record.childId, SUBAGENT_OWNER_GENERATION, (call) => {
			if (!SUBAGENT_QUESTION_TOOLS.has(call.toolName)) reportsOtherThanQuestions = true;
			return interruptedStillRunningResult(call);
		})
			.then((held) => {
				// A child released by an earlier process is woken as it always is, which hands these over too.
				if (held === undefined || releasedByEarlierProcess(held)) return;
				if (held.state === "terminal" && !reportsOtherThanQuestions) return;
				wakeReleasedChildWithHeldResults(
					dispatcher,
					subagentWakeKey(ownerSessionId, record.childId),
					`interrupted:${SUBAGENT_OWNER_GENERATION}`,
				);
			})
			.catch((error: Error) => observeChildRecordFailure(ownerSessionId, wakeFailureOf(error, record.childId)));
	}
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

function textOf(content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>): string {
	return typeof content === "string"
		? content
		: content.map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`)).join("\n");
}

/** A transcript message as {@link savedIn} reads it. */
interface SavedMessage {
	readonly role: string;
	readonly toolCallId?: string;
	readonly content?: Parameters<typeof textOf>[0];
	readonly customType?: string;
	readonly details?: unknown;
}

/** The ids of `results` that `messages` hold: see {@link savedToolResultIds}. */
function savedIn(messages: readonly SavedMessage[], results: readonly DetachedToolResult[]): string[] {
	const answered = new Set<string>();
	const noticed = new Set<string>();
	const read = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.toolCallId !== undefined) {
			if (textOf(message.content ?? "") !== SUBAGENT_STILL_RUNNING_RESULT) answered.add(message.toolCallId);
		} else if (message.role === "custom") for (const id of lateToolResultNoticeIds(message)) noticed.add(id);
		else if (message.role === "user") read.add(textOf(message.content ?? ""));
	}
	return results
		.filter(
			(result) =>
				answered.has(result.toolCallId) ||
				noticed.has(result.toolCallId) ||
				read.has(legacyLateToolResultMessage(result)),
		)
		.map((result) => result.toolCallId);
}

/**
 * The ids of `results` the child's transcript already holds: recorded as their call's own result (one that is not
 * "still running"), or delivered as a late result, in the notice a woken child reads it in or as the message builds
 * before that notice sent. A run that saved them and then stopped, failed or lost its owner before it reported them
 * leaves them held; they are not delivered again (#5012).
 */
export function savedToolResultIds(
	sessionManager: Pick<SessionManager, "buildSessionProjection">,
	results: readonly DetachedToolResult[],
): string[] {
	if (results.length === 0) return [];
	return savedIn(sessionManager.buildSessionProjection().messages, results);
}

/** The message a session entry holds, as {@link savedIn} reads it. */
function savedMessageOf(entry: SessionEntry): SavedMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "custom_message") return { role: "custom", customType: entry.customType, details: entry.details };
	return undefined;
}

/**
 * {@link savedToolResultIds}, also reading the part of the child's branch a compaction took out of its context: the
 * entries the manager holds and, for a manager holding only its window, the stored branch from `fromSeq` (the child's
 * launch). History is read only for results the context does not hold, and only until all of them are found.
 */
export async function savedToolResultIdsInHistory(
	sessionManager: Pick<
		SessionManager,
		"buildSessionProjection" | "getBranch" | "hasFullHistory" | "readHistory" | "getLeafId" | "getEntrySeq"
	>,
	results: readonly DetachedToolResult[],
	fromSeq?: number,
): Promise<string[]> {
	const saved = new Set(savedToolResultIds(sessionManager, results));
	const missing = () => results.filter((result) => !saved.has(result.toolCallId));
	if (missing().length === 0) return [...saved];
	const held = sessionManager.getBranch().flatMap((entry) => {
		const message = savedMessageOf(entry);
		return message === undefined ? [] : [message];
	});
	for (const id of savedIn(held, missing())) saved.add(id);
	if (missing().length === 0 || typeof sessionManager.hasFullHistory !== "function" || sessionManager.hasFullHistory())
		return [...saved];
	const leaf = sessionManager.getLeafId();
	const branchLeafSeq = leaf === null ? undefined : sessionManager.getEntrySeq(leaf);
	if (branchLeafSeq === undefined) return [...saved];
	for await (const page of sessionManager.readHistory({
		branchLeafSeq,
		...(fromSeq === undefined ? {} : { fromSeq }),
	})) {
		const messages = page.items.flatMap((item) => {
			const message = "entry" in item ? savedMessageOf(item.entry) : undefined;
			return message === undefined ? [] : [message];
		});
		for (const id of savedIn(messages, missing())) saved.add(id);
		if (missing().length === 0) break;
	}
	return [...saved];
}

/** How a woken child continues: results recorded as its pending calls' results, then its late results and prompt. */
export interface ReleasedChildWakePlan {
	/** Results for the calls its transcript ends on, including a still-running result for each call with none yet. */
	readonly resumeToolResults: readonly DetachedToolResult[];
	/**
	 * Results of calls answered already, in arrival order: the child reads them in one notice delivered with its turn,
	 * which starts that turn when nothing else does.
	 */
	readonly lateResults: readonly DetachedToolResult[];
	/** Nothing but results woke it: the continued turn, or its late results' own turn, is the whole run. */
	readonly skipPrompt: boolean;
}

/**
 * Plan a wake from the calls the transcript is waiting on and the results that arrived. When the results answer every
 * pending call and nothing else woke the child, the turn simply continues. Otherwise every pending call is answered
 * first, a call still running with {@link SUBAGENT_STILL_RUNNING_RESULT} and one that died with an earlier owner
 * process with {@link SUBAGENT_INTERRUPTED_BY_RESTART_RESULT}, so the transcript never ends on a call without a result
 * before a new message. A result whose call was answered already is late: it is read in a notice, never as a prompt.
 */
export function planReleasedChildWake(
	pending: ReadonlyMap<string, string>,
	results: readonly DetachedToolResult[],
	hasOtherInput: boolean,
	interrupted: (toolCallId: string) => boolean = () => false,
): ReleasedChildWakePlan {
	const seen = new Set<string>();
	const unique = results.filter((result) => !seen.has(result.toolCallId) && seen.add(result.toolCallId));
	const onTime = unique.filter((result) => pending.has(result.toolCallId));
	const late = unique.filter((result) => !pending.has(result.toolCallId));
	const stillRunning: DetachedToolResult[] = [...pending]
		.filter(([toolCallId]) => !onTime.some((result) => result.toolCallId === toolCallId))
		.map(([toolCallId, toolName]) => {
			const lost = interrupted(toolCallId);
			const text = lost ? SUBAGENT_INTERRUPTED_BY_RESTART_RESULT : SUBAGENT_STILL_RUNNING_RESULT;
			return {
				toolCallId,
				toolName,
				result: { content: [{ type: "text", text }], details: undefined },
				isError: lost,
			};
		});
	return {
		resumeToolResults: [...onTime, ...stillRunning],
		lateResults: late,
		skipPrompt: !hasOtherInput,
	};
}

/** Statuses after which a child takes nothing more. */
const ENDED: ReadonlySet<string | undefined> = new Set(["killed", SUBAGENT_CHILD_GONE_STATUS]);
/** Statuses run control set: results wait in the record for `resume`, and messages do not wake the child. */
const STOPPED: ReadonlySet<string | undefined> = new Set(["paused", "quit"]);

/**
 * Whether a wake may still relaunch a child with this latest record: it is released or has ended on its own, and run
 * control has not stopped it, it has not ended for good, and it is not running again (#4845).
 */
export function isRelaunchableChildRecord(record: SubagentChildRecord | undefined): boolean {
	return record?.state === "terminal" && !ENDED.has(record.terminalStatus) && !STOPPED.has(record.terminalStatus);
}

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
		slot?: AgentWakeSlot,
	) => Promise<void>;
	readonly hold: (record: SubagentChildRecord, toolResults: readonly DetachedToolResult[]) => Promise<void>;
	readonly resume?: (
		record: SubagentChildRecord,
		request: SubagentChildResumeRequest,
	) => Promise<SubagentChildRestoreOutcome>;
	readonly redispatch?: (record: SubagentChildRecord, slot?: AgentWakeSlot) => Promise<void>;
	readonly fail?: (
		record: SubagentChildRecord,
		toolResults: readonly DetachedToolResult[],
		failure: ReleasedChildError,
	) => Promise<void>;
}

/** `error` as the failure of a wake of `childId`, as its owner is told of it. */
export function wakeFailureOf(error: Error, childId: string): ReleasedChildError {
	return isReleasedChildError(error)
		? error
		: new ReleasedChildError("wake-failed", { childId, reason: error.message }, { cause: error });
}

/**
 * Wakes this owner's children through `actions`; returns the function that stops handling them. A wake that fails
 * hands the batch's results and the failure to `actions.fail` before it fails, so nothing it carried is lost.
 */
export function handleReleasedChildWakes(
	ctx: Pick<ExtensionContext, "sessionManager">,
	actions: ReleasedChildWakeActions,
	dispatcher: AgentWakeDispatcher = agentWakeDispatcher(),
	maxConcurrent?: number,
): () => void {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const namespace = subagentWakeNamespace(ownerSessionId);
	const latest = async (childId: string): Promise<SubagentChildRecord> => {
		await subagentChildRecordsAppended(ownerSessionId);
		indexSubagentChildOwner(ctx);
		// A child whose records left the owner's window is read from it first, and kept for the wake's later reads: also
		// one an action read and holds, which lets it go when it is done.
		const reading = keepSubagentChildRecord(ownerSessionId, childId);
		if (reading !== undefined) await reading;
		const record = subagentChildRecordOf(ownerSessionId, childId);
		if (record === undefined) throw new ReleasedChildError("child-record-missing", { ownerSessionId, childId });
		return record;
	};
	// A reload's newer extension generation takes the owner's children over before the older one shuts down.
	return dispatcher.handle(
		namespace,
		async (wakeKey, wakes, slot) => {
			const childId = wakeKey.slice(namespace.length + 1);
			// Active from the moment this handler holds the batch, before any await: a resume arriving meanwhile then waits for
			// this wake's relaunch decision instead of queuing behind the run it starts (#5485).
			setReleasedChildWakeActive(wakeKey, true);
			let record: SubagentChildRecord;
			try {
				record = await latest(childId);
			} catch (error) {
				setReleasedChildWakeActive(wakeKey, false);
				throw error;
			}
			try {
				const redispatch =
					actions.redispatch !== undefined && wakes.some(isRedispatchWake) && needsRedispatch(record);
				if (redispatch) await actions.redispatch?.(record, slot);
				const current = redispatch ? await latest(childId) : record;
				// A resume its caller withdrew before this handler took it is left out, as if it never arrived (#5485).
				const others = withReleasedReplyTimeouts(
					current,
					wakes.filter(
						(wake) => !isRedispatchWake(wake) && (!isResumeWake(wake) || takeReleasedChildResume(wake.id)),
					),
				);
				if (others.length === 0) return;
				const resumes = others.filter(isResumeWake);
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
				else if (decision.kind === "wake") await actions.wake(current, decision, slot);
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
 * The route the completions of shell tasks a released child launched take to that child: each notice is held in its
 * record and wakes it, or waits for its resume when it is stopped, and reaches it as the notice a running child gets,
 * never as a message. A child that runs again or has ended holds none: the route refuses it, and the parent's task owner
 * keeps it for the child's next run. The session that launched it never gets it.
 */
export function releasedChildShellRoute(
	holdNotices: NonNullable<SubagentChildRecordSink["holdNotices"]>,
	ownerSessionId: string,
	childId: string,
	dispatcher: AgentWakeDispatcher,
): ChildTaskCompletionRoute {
	return {
		isOpen: () => true,
		deliver: async (message) => {
			const outcome = await holdNotices(childId, [
				{ customType: message.customType, content: message.content, details: message.details },
			]);
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
	holdNotices: NonNullable<SubagentChildRecordSink["holdNotices"]>,
	ownerSessionId: string,
	childId: string,
	dispatcher: AgentWakeDispatcher,
): void {
	try {
		released.routeShellCompletions?.(releasedChildShellRoute(holdNotices, ownerSessionId, childId, dispatcher));
	} catch (error) {
		observeChildRecordFailure(
			ownerSessionId,
			new ReleasedChildError("completion-not-held", { ownerSessionId, childId }, { cause: error as Error }),
		);
	}
}
