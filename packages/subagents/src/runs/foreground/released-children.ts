import { AsyncLocalStorage } from "node:async_hooks";
import {
	type AgentWake,
	type AgentWakeDispatcher,
	agentWakeDispatcher,
	type DetachedToolCall,
	type DetachedToolResult,
	type ExtensionContext,
	type SessionManager,
} from "@bastani/atomic";
import type { SubagentReleasePolicy } from "../inprocess/runner.js";
import { ReleasedChildError } from "./released-child-errors.js";
import { indexSubagentChildOwner, subagentChildRecordOf } from "./subagent-child-card-state.js";
import {
	recordSubagentChildHeldToolResults,
	SUBAGENT_CHILD_GONE_STATUS,
	SUBAGENT_CHILD_RELEASED_STATUS,
	SUBAGENT_CHILD_STAGE_CLOSED_STATUS,
	SUBAGENT_CHILD_STAGE_PAUSED_STATUS,
	type SubagentChildRecord,
	subagentChildOwner,
	subagentChildRecordsAppended,
} from "./subagent-child-records.js";

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
	origin: "call" | "held" = "call",
): Promise<void> {
	return dispatcher.deliver(wakeKey, {
		id: origin === "held" ? `held-result:${toolResult.toolCallId}` : `tool-result:${toolResult.toolCallId}`,
		kind: "tool-result",
		toolResult,
	});
}

function forwardDetachedResult(dispatcher: AgentWakeDispatcher, wakeKey: string, call: DetachedToolCall): void {
	void call.result
		.then((toolResult) => deliverToolResult(dispatcher, wakeKey, toolResult))
		.catch((error) => dispatcher.reportUnobservedFailure(error));
}

/**
 * Hand each detached call's result to the dispatcher as a `tool-result` wake for the child, once, when it settles.
 * Nothing waits per child: each call's own operation carries its delivery.
 */
export function forwardDetachedResults(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	calls: readonly DetachedToolCall[],
): void {
	for (const call of calls) outsideAnyTask(forwardDetachedResult, dispatcher, wakeKey, call);
}

function wakeWithHeldResult(dispatcher: AgentWakeDispatcher, wakeKey: string, held: DetachedToolResult): void {
	void deliverToolResult(dispatcher, wakeKey, held, "held").catch((error) =>
		dispatcher.reportUnobservedFailure(error),
	);
}

/**
 * Results that arrived while the child still ran are held in its record. Once the child is released they have nobody
 * waiting for them, so one wake hands them over: the handler takes every result the record holds.
 */
export function wakeReleasedChildWithHeldResults(
	dispatcher: AgentWakeDispatcher,
	wakeKey: string,
	held: readonly DetachedToolResult[] | undefined,
): void {
	const [first] = held ?? [];
	if (first !== undefined) outsideAnyTask(wakeWithHeldResult, dispatcher, wakeKey, first);
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
	| { readonly kind: "hold"; readonly heldToolResults: readonly DetachedToolResult[] }
	| { readonly kind: "wake"; readonly toolResults: readonly DetachedToolResult[]; readonly prompt: boolean };

/**
 * Decide a batch of wakes: an ended child or a stopped child with no new result ignores it; a stopped or live child
 * keeps new results for later; a released child, or a settled one a late result reaches, is woken with every result
 * it holds. Messages and asks wake only a released child: a live one already has them.
 */
export function decideReleasedChildWake(
	record: Pick<SubagentChildRecord, "state" | "terminalStatus" | "heldToolResults">,
	wakes: readonly AgentWake[],
): ReleasedChildWakeDecision {
	const status = record.terminalStatus;
	const held = record.heldToolResults ?? [];
	const arrived = wakes.flatMap((wake) => (wake.toolResult === undefined ? [] : [wake.toolResult]));
	const fresh = arrived.filter((result) => !held.some((kept) => kept.toolCallId === result.toolCallId));
	const toolResults = [...held, ...fresh];
	if (ENDED.has(status)) return { kind: "ignore" };
	if (record.state === "running" || STOPPED.has(status))
		return fresh.length === 0 ? { kind: "ignore" } : { kind: "hold", heldToolResults: toolResults };
	const prompt = wakes.some((wake) => wake.kind !== "tool-result");
	if (status === SUBAGENT_CHILD_RELEASED_STATUS) return { kind: "wake", toolResults, prompt };
	return fresh.length === 0 ? { kind: "ignore" } : { kind: "wake", toolResults, prompt: false };
}

/** Wakes this owner's children through `wake`; returns the function that stops handling them. */
export function handleReleasedChildWakes(
	ctx: Pick<ExtensionContext, "sessionManager" | "orchestrationContext">,
	wake: (record: SubagentChildRecord, decision: Extract<ReleasedChildWakeDecision, { kind: "wake" }>) => Promise<void>,
	hold: (record: SubagentChildRecord, heldToolResults: readonly DetachedToolResult[]) => Promise<void>,
	dispatcher: AgentWakeDispatcher = agentWakeDispatcher(),
): () => void {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const namespace = subagentWakeNamespace(ownerSessionId);
	// A reload's newer extension generation takes the owner's children over before the older one shuts down.
	return dispatcher.handle(
		namespace,
		async (wakeKey, wakes) => {
			const childId = wakeKey.slice(namespace.length + 1);
			await subagentChildRecordsAppended(ownerSessionId);
			indexSubagentChildOwner(ctx);
			const record = subagentChildRecordOf(ownerSessionId, childId);
			if (record === undefined) throw new ReleasedChildError("child-record-missing", { ownerSessionId, childId });
			const decision = decideReleasedChildWake(record, wakes);
			if (decision.kind === "hold") await hold(record, decision.heldToolResults);
			else if (decision.kind === "wake") await wake(record, decision);
		},
		{ replace: true },
	);
}

/** Keep results for a child that cannot take them now, durably, for its next wake or resume. */
export function holdToolResultsInRecord(
	pi: Parameters<typeof recordSubagentChildHeldToolResults>[0],
): (record: SubagentChildRecord, heldToolResults: readonly DetachedToolResult[]) => Promise<void> {
	return async (record, heldToolResults) => {
		await recordSubagentChildHeldToolResults(pi, record.owner.sessionId, record.childId, heldToolResults);
	};
}
