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
import {
	RELEASED_CHILD_REPLY_EVENT,
	type ReleasedChildReplyRequest,
} from "../../../../intercom/released-reply-wait.js";
import { type IntercomEventBus, resolveTopLevelParallelRunningCapacity } from "../../shared/types.js";
import { deliverLocalCompletionNotification } from "./completion-notification.js";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import { releasedReplyTimeoutId, releasedReplyToolResult } from "./released-child-replies.js";
import {
	acknowledgeReleasedChildWake,
	INTERCOM_CONNECTED_EVENT,
	reserveReleasedChildrenOf,
} from "./released-child-reservations.js";
import { bindResumeDispatcher } from "./released-child-resume.js";
import {
	handleReleasedChildWakes,
	holdToolResultsInRecord,
	SUBAGENT_RELEASED_WAKE_PROMPT,
	subagentWakeKey,
	subagentWakeNamespace,
	wakeReleasedChildrenOfEarlierProcess,
	wakeReleasedChildWithHeldResults,
} from "./released-children.js";
import {
	indexSubagentChildOwner,
	subagentChildRecordForTarget,
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
	const reserveAll = () => {
		indexSubagentChildOwner(ctx);
		void reserveReleasedChildrenOf(events, ownerSessionId);
	};
	reserveAll();
	const restore = async (record: SubagentChildRecord, request: SubagentChildResumeRequest) => {
		const outcome = await restoreSubagentChild(deps, ctx, record.childId, request);
		if (outcome.kind === "unrestorable")
			throw new ReleasedChildError("child-unrestorable", { childId: record.childId, reason: outcome.reason });
		const host = ctx.getAgentTaskHost?.();
		if (outcome.kind === "restored" && host !== undefined) await awaitTaskSettlement(host, outcome.taskId);
	};
	const disposeHandler = handleReleasedChildWakes(
		ctx,
		{
			wake: async (record, decision) => {
				if (record.intercomTarget !== undefined) void acknowledgeReleasedChildWake(events, record.intercomTarget);
				await restore(record, {
					prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
					toolResults: decision.toolResults,
					...(decision.prompt ? {} : { promptless: true }),
				});
			},
			hold: holdToolResultsInRecord(deps.pi),
			resume: async (record, request) => {
				const outcome = await restoreSubagentChild(deps, ctx, record.childId, request);
				if (outcome.kind === "unrestorable")
					throw new ReleasedChildError("child-unrestorable", { childId: record.childId, reason: outcome.reason });
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
			if (record === undefined || call === undefined) return false;
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
		unsubscribe();
		unsubscribeReply();
		unsubscribeConnected();
	};
}
