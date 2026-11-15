import { randomUUID } from "node:crypto";
import {
	type AgentRehydrateError,
	type AgentTaskHost,
	type AgentWakeDispatcher,
	agentWakeDispatcher,
	type ExtensionContext,
	isStaleExtensionContextError,
	type TaskId,
} from "@bastani/atomic";
import { type IntercomEventBus, resolveTopLevelParallelRunningCapacity } from "../../shared/types.js";
import { deliverLocalCompletionNotification } from "./completion-notification.js";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import { releasedReplyTimeoutId, releasedReplyToolResult } from "./released-child-replies.js";
import {
	acknowledgeReleasedChildWake,
	INTERCOM_CONNECTED_EVENT,
	markEndedChildrenOf,
	type ReleasedChildHoldFailure,
	releasedChildReservation,
	reserveReleasedChildrenOf,
	SUBAGENT_HOLD_FAILURE_EVENT,
	SUBAGENT_HOLD_RECOVERED_EVENT,
} from "./released-child-reservations.js";
import {
	bindResumeDispatcher,
	isReleasedChildStopPending,
	openReleasedChildRelaunch,
	settleReleasedChildRelaunch,
} from "./released-child-resume.js";
import {
	handleReleasedChildWakes,
	holdToolResultsInRecord,
	isRelaunchableChildRecord,
	reportInterruptedStillRunningCalls,
	SUBAGENT_RELEASED_WAKE_PROMPT,
	subagentWakeKey,
	subagentWakeNamespace,
	wakeReleasedChildrenOfEarlierProcess,
	wakeReleasedChildWithHeldResults,
} from "./released-children.js";
import { RELEASED_CHILD_REPLY_EVENT, type ReleasedChildReplyRequest } from "./released-reply-protocol.js";
import {
	indexSubagentChildOwner,
	subagentChildRecordForTarget,
	subagentChildRecordOf,
	subagentChildRecordsOf,
} from "./subagent-child-card-state.js";
import {
	currentWakeFailure,
	observeChildRecordFailure,
	recordSubagentChildReply,
	recordSubagentChildWakeFailure,
	reportSubagentChildWakeFailure,
	type SubagentChildRecord,
	subagentChildOwner,
	subagentChildRecordsAppended,
} from "./subagent-child-records.js";
import {
	restoreSubagentChild,
	type SubagentChildRestoreDeps,
	type SubagentChildResumeRequest,
} from "./subagent-child-restore.js";

/** Intercom → Subagents: a send or ask waits at the broker for a released child of this session (#4326). */
export const SUBAGENT_RELEASED_CHILD_WAKE_EVENT = "subagent:released-child-wake";

export const RELEASED_CHILD_WAKE_FAILURE_LABEL = "Released subagent wake";

async function awaitTaskSettlement(host: AgentTaskHost, taskId: string): Promise<void> {
	for (;;) {
		const observed = await host.waitForTask(taskId as TaskId);
		if (!observed.ok || observed.value.kind === "settled") return;
	}
}

function noticeOf(record: SubagentChildRecord): Record<string, string | number> | undefined {
	const failure = currentWakeFailure(record);
	if (failure === undefined) return undefined;
	return {
		id: record.runId,
		runId: record.runId,
		agent: record.agent,
		status: "error",
		summary: `${record.agent} (${record.childId}) could not be woken: ${failure.reason} (${failure.code}). ${failure.hint}`,
		timestamp: Date.now(),
		noticeLabel: RELEASED_CHILD_WAKE_FAILURE_LABEL,
	};
}

/**
 * Wake this owner session's released children (#4326): one dispatcher handler for all of them, at most
 * `parallel.runningCapacity` at a time, and one listener for the broker's notices that a send waits for one. A woken
 * child is restored from its own session and the handler waits until that run settles, so wakes for one child are
 * taken one run at a time, in order. A wake that fails keeps what it carried in the child's record with the failure,
 * and the owner is told once. Children an earlier process released start their calls again. Returns the function
 * that stops all of it.
 */
export function bindReleasedChildWakes(
	deps: SubagentChildRestoreDeps,
	ctx: ExtensionContext,
	events: IntercomEventBus,
	dispatcher: AgentWakeDispatcher = agentWakeDispatcher(),
): () => void {
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const namespace = subagentWakeNamespace(ownerSessionId);
	let holdFailureNotified = false;
	const unsubscribeHoldFailure = events.on(SUBAGENT_HOLD_FAILURE_EVENT, (payload) => {
		const failure = payload as ReleasedChildHoldFailure;
		indexSubagentChildOwner(ctx);
		const recordsByName = new Map<string, SubagentChildRecord>();
		for (const record of subagentChildRecordsOf(ownerSessionId))
			if (record.intercomTarget !== undefined) recordsByName.set(record.intercomTarget, record);
		for (const childName of failure.childNames) {
			const record = recordsByName.get(childName);
			if (record === undefined) continue;
			failure.handled = true;
			const error = new ReleasedChildError(
				"hold-failed",
				{ ownerSessionId, childId: record.childId, childName, reason: "Intercom reservation request failed" },
				{ cause: failure.error },
			);
			observeChildRecordFailure(ownerSessionId, error);
			if (holdFailureNotified) continue;
			holdFailureNotified = true;
			void deliverLocalCompletionNotification(
				events,
				{
					id: record.runId,
					runId: record.runId,
					agent: record.agent,
					status: "error",
					summary: `${error.message} (${error.code}). ${error.hint}`,
					timestamp: Date.now(),
					noticeLabel: "Released subagent reservation",
				},
				`released-hold-failure-${ownerSessionId}-${randomUUID()}`,
			).catch((cause: Error) => {
				observeChildRecordFailure(ownerSessionId, new ReleasedChildError("hold-failed", error.fields, { cause }));
			});
		}
	});
	const unsubscribeHoldRecovered = events.on(SUBAGENT_HOLD_RECOVERED_EVENT, () => {
		holdFailureNotified = false;
	});
	const reserveAll = () => {
		indexSubagentChildOwner(ctx);
		void reserveReleasedChildrenOf(events, ownerSessionId);
		void markEndedChildrenOf(events, ownerSessionId);
	};
	reserveAll();
	/**
	 * The child's latest record when a wake must not relaunch it after all: a pause or quit of it is in flight, or its
	 * latest record is no longer released or ended on its own (#4845). Undefined when it may run.
	 */
	const refuseRelaunch = (record: SubagentChildRecord) => (): SubagentChildRecord | undefined => {
		const latest = subagentChildRecordOf(ownerSessionId, record.childId);
		const key = subagentWakeKey(ownerSessionId, record.childId);
		if (!isReleasedChildStopPending(key) && isRelaunchableChildRecord(latest)) return undefined;
		return latest ?? record;
	};
	const restore = async (record: SubagentChildRecord, request: SubagentChildResumeRequest) => {
		const key = subagentWakeKey(ownerSessionId, record.childId);
		const outcome = await restoreSubagentChild(deps, ctx, record.childId, request, refuseRelaunch(record));
		if (outcome.kind === "unrestorable")
			throw new ReleasedChildError("child-unrestorable", { childId: record.childId, reason: outcome.reason });
		// Relaunched with its new run's record written, or not relaunched: what the wake carried stays held for resume.
		settleReleasedChildRelaunch(key);
		const host = ctx.getAgentTaskHost?.();
		if (outcome.kind !== "restored" || host === undefined) return;
		await awaitTaskSettlement(host, outcome.taskId);
		openReleasedChildRelaunch(key);
	};
	const holdResults = holdToolResultsInRecord(deps.pi);
	const disposeHandler = handleReleasedChildWakes(
		ctx,
		{
			wake: async (record, decision) => {
				const unsaved = decision.toolResults.filter(
					(result) => !(record.heldToolResults ?? []).some((held) => held.toolCallId === result.toolCallId),
				);
				if (unsaved.length > 0) await holdResults(record, unsaved);
				if (refuseRelaunch(record)() !== undefined) return;
				if (record.intercomTarget !== undefined) void acknowledgeReleasedChildWake(events, record.intercomTarget);
				await restore(record, {
					prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
					toolResults: decision.toolResults,
					...(decision.prompt ? {} : { promptless: true }),
				});
			},
			hold: holdResults,
			resume: async (record, request) => {
				// Held first, as a wake holds them: a stop before the resumed run saves them leaves them for its resume (#5012).
				const unsaved = (request.toolResults ?? []).filter(
					(result) => !(record.heldToolResults ?? []).some((held) => held.toolCallId === result.toolCallId),
				);
				if (unsaved.length > 0) await holdResults(record, unsaved);
				const outcome = await restoreSubagentChild(deps, ctx, record.childId, request);
				if (outcome.kind === "unrestorable")
					throw new ReleasedChildError("child-unrestorable", { childId: record.childId, reason: outcome.reason });
				// A pause or quit waiting on this wake now finds the run the resume started, and stops it.
				settleReleasedChildRelaunch(subagentWakeKey(ownerSessionId, record.childId));
				return outcome;
			},
			redispatch: (record) => restore(record, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT, redispatch: true }),
			fail: (record, toolResults, failure) =>
				recordSubagentChildWakeFailure(deps.pi, ownerSessionId, record.childId, toolResults, failure),
		},
		dispatcher,
		resolveTopLevelParallelRunningCapacity(deps.config?.parallel?.runningCapacity),
	);
	const unbindResume = bindResumeDispatcher(ownerSessionId, dispatcher);
	const report = (error: AgentRehydrateError) => {
		const wakeKey = error.fields.wakeKey;
		if (error.code !== "wake-failed" || !wakeKey?.startsWith(`${namespace}:`)) return;
		const childId = wakeKey.slice(namespace.length + 1);
		void reportSubagentChildWakeFailure(deps.pi, ownerSessionId, childId)
			.then(async (record) => {
				const notice = record === undefined ? undefined : noticeOf(record);
				if (notice === undefined) return;
				await deliverLocalCompletionNotification(
					events,
					notice,
					`released-wake-failure-${childId}-${record?.taskId ?? "none"}`,
				);
			})
			.catch((failure: Error) => {
				if (isStaleExtensionContextError(failure)) return;
				if (isReleasedChildError(failure) && failure.code === "child-record-missing") return;
				observeChildRecordFailure(
					ownerSessionId,
					isReleasedChildError(failure)
						? failure
						: new ReleasedChildError("wake-failed", { childId, reason: failure.message }, { cause: failure }),
				);
			});
	};
	const stopReporting = dispatcher.onUnobservedFailure(report);
	wakeReleasedChildrenOfEarlierProcess(dispatcher, ownerSessionId, subagentChildRecordsOf(ownerSessionId));
	reportInterruptedStillRunningCalls(deps.pi, dispatcher, ownerSessionId, subagentChildRecordsOf(ownerSessionId));
	const unsubscribe = events.on(SUBAGENT_RELEASED_CHILD_WAKE_EVENT, (payload) => {
		const childName = (payload as { readonly childName?: string } | null)?.childName;
		if (typeof childName !== "string") return;
		indexSubagentChildOwner(ctx);
		const record = subagentChildRecordForTarget(ownerSessionId, childName);
		if (record === undefined) return;
		void dispatcher
			.deliver(subagentWakeKey(ownerSessionId, record.childId), { id: `intercom:${randomUUID()}`, kind: "intercom" })
			.catch((error) => dispatcher.reportUnobservedFailure(error));
	});
	const unsubscribeReply = events.on(RELEASED_CHILD_REPLY_EVENT, (payload) => {
		const request = payload as ReleasedChildReplyRequest;
		const arrivedAt = Date.now();
		request.completion = (async () => {
			await subagentChildRecordsAppended(ownerSessionId);
			indexSubagentChildOwner(ctx);
			const record = subagentChildRecordForTarget(ownerSessionId, request.childName);
			const call = record?.waitingOn?.find((item) => item.replyWait?.questionId === request.replyTo);
			if (record === undefined) return false;
			// #4751: the child's `ask` already returned, so the reply is an ordinary message: the broker holds it for the
			// released child and wakes it, like any other send to it.
			if (call === undefined) return releasedChildReservation(record)?.wake === true ? "deliver" : false;
			const result = releasedReplyToolResult(call, request.message);
			const accepted = await recordSubagentChildReply(
				deps.pi,
				ownerSessionId,
				record.childId,
				request.replyTo,
				result,
				arrivedAt,
			);
			if (!accepted) return false;
			const wakeKey = subagentWakeKey(ownerSessionId, record.childId);
			dispatcher.cancel(wakeKey, releasedReplyTimeoutId(request.replyTo));
			wakeReleasedChildWithHeldResults(dispatcher, wakeKey, request.message.id);
			return true;
		})();
	});
	const unsubscribeConnected = events.on(INTERCOM_CONNECTED_EVENT, reserveAll);
	return () => {
		disposeHandler();
		unbindResume();
		stopReporting();
		unsubscribeHoldFailure();
		unsubscribeHoldRecovered();
		unsubscribe();
		unsubscribeReply();
		unsubscribeConnected();
	};
}
