import { randomUUID } from "node:crypto";
import {
	type AgentRehydrateError,
	type AgentTaskHost,
	type AgentWakeDispatcher,
	type AgentWakeSlot,
	agentWakeDispatcher,
	type ExtensionContext,
	isStaleExtensionContextError,
	type TaskId,
} from "@bastani/atomic";
import { type IntercomEventBus, resolveTopLevelParallelRunningCapacity } from "../../shared/types.js";
import { deliverLocalCompletionNotification } from "./completion-notification.js";
import { isReleasedChildError, ReleasedChildError } from "./released-child-errors.js";
import { type HoldNoticeEpisode, holdNoticeEpisode } from "./released-child-receipts.js";
import { releasedReplyTimeoutId, releasedReplyToolResult } from "./released-child-replies.js";
import {
	acknowledgeReleasedChildWake,
	bindReleasedChildReservationOwner,
	INTERCOM_CONNECTED_EVENT,
	isHeldChildRecord,
	markEndedChildrenOf,
	pendingHoldNoticeEpisodes,
	type ReleasedChildHoldFailure,
	type ReleasedChildHoldRecovery,
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
	reservationRecordLookup,
	subagentChildRecordForTarget,
	subagentChildRecordOf,
	subagentChildRecordsOf,
} from "./subagent-child-card-state.js";
import { subagentChildOwnerOperations } from "./subagent-child-owner.js";
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
	start: (work: () => void) => void = (work) => work(),
): () => void {
	const owner = subagentChildOwnerOperations(deps.pi, ctx);
	// A bound owner's notices follow its live generation; without a binding they go to `events`, as the caller passed.
	const ownerEvents = owner.pi === deps.pi ? events : owner.pi.events;
	ctx = owner.ctx;
	deps = { ...deps, pi: owner.pi };
	const ownerSessionId = subagentChildOwner(ctx).sessionId;
	const namespace = subagentWakeNamespace(ownerSessionId);
	/**
	 * #5551: the children whose reservation failure the owner was told of and whose reservation has not succeeded since,
	 * each with the task of the release it failed for. A pending check shares that episode until recovery starts a new one.
	 */
	const holdFailuresTold = new Map<string, HoldNoticeEpisode>();
	const unbindReservationOwner = bindReleasedChildReservationOwner(events, ownerSessionId, holdFailuresTold);
	const pruned = new WeakSet<ReturnType<typeof reservationRecordLookup>>();
	const unsubscribeHoldFailure = events.on(SUBAGENT_HOLD_FAILURE_EVENT, (payload) => {
		const failure = payload as ReleasedChildHoldFailure;
		indexSubagentChildOwner(ctx);
		const recordOf = failure.recordOf ?? reservationRecordLookup(ownerSessionId);
		// Prune notices for obsolete releases once per batch, not once for every failed frame.
		if (!pruned.has(recordOf)) {
			pruned.add(recordOf);
			for (const [childName, { taskId }] of holdFailuresTold) {
				const record = recordOf(childName);
				if (record === undefined || !isHeldChildRecord(record) || record.taskId !== taskId)
					holdFailuresTold.delete(childName);
			}
		}
		const untold: Array<{ readonly childName: string; readonly record: SubagentChildRecord }> = [];
		for (const childName of failure.childNames) {
			const record = recordOf(childName);
			if (record === undefined) continue;
			failure.handled = true;
			// #5551: a child that runs again or has ended is not released any more: there is nothing to hold for it.
			if (!isHeldChildRecord(record)) continue;
			// #5551: a failure of an earlier release of a child that another run has released since is not this one's.
			const taskId = failure.taskIds?.get(childName);
			if (taskId !== undefined && taskId !== record.taskId) continue;
			observeChildRecordFailure(
				ownerSessionId,
				new ReleasedChildError(
					"hold-failed",
					{ ownerSessionId, childId: record.childId, childName, reason: "Intercom reservation request failed" },
					{ cause: failure.error },
				),
			);
			const episode =
				pendingHoldNoticeEpisodes.get(failure) ?? holdNoticeEpisode(holdFailuresTold, childName, record.taskId);
			if (episode.told) continue;
			episode.told = true;
			untold.push({ childName, record });
		}
		const [told] = untold;
		if (told === undefined) return;
		const first = told.record;
		// One notice for every child this failure leaves newly without a hold.
		const childNames = untold.map((child) => child.childName);
		const error = new ReleasedChildError(
			"hold-failed",
			{
				ownerSessionId,
				childId: first.childId,
				childName: told.childName,
				...(childNames.length > 1 ? { childNames } : {}),
				reason: "Intercom reservation request failed",
			},
			{ cause: failure.error },
		);
		void deliverLocalCompletionNotification(
			events,
			{
				id: first.runId,
				runId: first.runId,
				agent: first.agent,
				status: "error",
				// The message already names the code and the hint.
				summary: error.message,
				timestamp: Date.now(),
				noticeLabel: "Released subagent reservation",
			},
			`released-hold-failure-${ownerSessionId}-${randomUUID()}`,
		).catch((cause: Error) => {
			observeChildRecordFailure(ownerSessionId, new ReleasedChildError("hold-failed", error.fields, { cause }));
		});
	});
	const unsubscribeHoldRecovered = events.on(SUBAGENT_HOLD_RECOVERED_EVENT, (payload) => {
		// Only these children's reservations succeeded: another child's failure stays told (#5551).
		for (const childName of (payload as Partial<ReleasedChildHoldRecovery> | undefined)?.childNames ?? [])
			holdFailuresTold.delete(childName);
	});
	const reserveAll = () => {
		indexSubagentChildOwner(ctx);
		void reserveReleasedChildrenOf(events, ownerSessionId);
		void markEndedChildrenOf(events, ownerSessionId);
	};
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
	const restore = async (
		record: SubagentChildRecord,
		request: SubagentChildResumeRequest,
		slot: AgentWakeSlot | undefined,
	) => {
		const key = subagentWakeKey(ownerSessionId, record.childId);
		// Wait through the admitting host even if the owner closes while the accepted record is being saved.
		const host = ctx.getAgentTaskHost?.();
		// #4856: while the child waits for its run's concurrency limit, it leaves its wake slot to other runs' children.
		const outcome = await restoreSubagentChild(
			deps,
			ctx,
			record.childId,
			slot === undefined ? request : { ...request, outsideWakeSlot: (wait) => slot.outside(wait) },
			refuseRelaunch(record),
		);
		if (outcome.kind === "unrestorable")
			throw new ReleasedChildError("child-unrestorable", { childId: record.childId, reason: outcome.reason });
		// Relaunched with its new run's record written, or not relaunched: what the wake carried stays held for resume.
		settleReleasedChildRelaunch(key);
		if (outcome.kind !== "restored" || host === undefined) return;
		await awaitTaskSettlement(host, outcome.taskId);
		openReleasedChildRelaunch(key);
	};
	const holdResults = holdToolResultsInRecord(deps.pi);
	const disposeHandler = handleReleasedChildWakes(
		ctx,
		{
			wake: async (record, decision, slot) => {
				const unsaved = decision.toolResults.filter(
					(result) => !(record.heldToolResults ?? []).some((held) => held.toolCallId === result.toolCallId),
				);
				if (unsaved.length > 0) await holdResults(record, unsaved);
				if (refuseRelaunch(record)() !== undefined) return;
				// #5551: only a released child is reserved; one that ended on its own and is woken for a late result is not.
				const reservation = releasedChildReservation(record);
				if (reservation?.wake === true)
					void acknowledgeReleasedChildWake(
						ownerEvents,
						reservation.childName,
						reservation.taskId,
						record.childId,
					);
				await restore(
					record,
					{
						prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
						toolResults: decision.toolResults,
						...(decision.prompt ? {} : { promptless: true }),
					},
					slot,
				);
			},
			hold: holdResults,
			resume: async (record, request) => {
				// Held first, as a wake holds them: a stop before the resumed run saves them leaves them for its resume (#5012).
				if (request.toolResults?.length) await holdResults(record, request.toolResults);
				const outcome = await restoreSubagentChild(deps, ctx, record.childId, request);
				if (outcome.kind === "unrestorable")
					throw new ReleasedChildError("child-unrestorable", { childId: record.childId, reason: outcome.reason });
				// A pause or quit waiting on this wake now finds the run the resume started, and stops it.
				const key = subagentWakeKey(ownerSessionId, record.childId);
				settleReleasedChildRelaunch(key);
				return outcome;
			},
			redispatch: (record, slot) =>
				restore(record, { prompt: SUBAGENT_RELEASED_WAKE_PROMPT, redispatch: true }, slot),
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
					ownerEvents,
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
	// Route replacement is synchronous at commit. Only start background work after the previous generation retires.
	start(() => {
		reserveAll();
		wakeReleasedChildrenOfEarlierProcess(dispatcher, ownerSessionId, subagentChildRecordsOf(ownerSessionId));
		reportInterruptedStillRunningCalls(deps.pi, dispatcher, ownerSessionId, subagentChildRecordsOf(ownerSessionId));
	});
	const unsubscribe = events.on(SUBAGENT_RELEASED_CHILD_WAKE_EVENT, (payload) => {
		const childName = (payload as { readonly childName?: string } | null)?.childName;
		if (typeof childName !== "string") return;
		indexSubagentChildOwner(ctx);
		let record: SubagentChildRecord | undefined;
		try {
			record = subagentChildRecordForTarget(ownerSessionId, childName);
		} catch (error) {
			// A child whose record cannot be read is not woken; its owner is told why, as of any wake that fails.
			observeChildRecordFailure(
				ownerSessionId,
				isReleasedChildError(error as Error)
					? (error as ReleasedChildError)
					: new ReleasedChildError(
							"wake-failed",
							{ childName, reason: (error as Error).message },
							{ cause: error as Error },
						),
			);
			return;
		}
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
		unbindReservationOwner();
		holdFailuresTold.clear();
		unsubscribeHoldFailure();
		unsubscribeHoldRecovered();
		unsubscribe();
		unsubscribeReply();
		unsubscribeConnected();
	};
}
