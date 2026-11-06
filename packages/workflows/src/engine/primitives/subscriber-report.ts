/** Report delivery into a subscriber stage, including one replayed from the journal after a resume. */

import { type SubscriberUnavailableReason, SubscriptionSubscriberUnavailableError } from "@bastani/atomic";
import {
	type AcquirePostMortemStageHandleResult,
	acquirePostMortemStageHandle,
	type PostMortemStageChatDeps,
	type PostMortemUnavailableReason,
} from "../../runs/foreground/postmortem-stage-chat.js";
import type { StageControlHandle } from "../../runs/foreground/stage-control-registry.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowEventSubscriber } from "../../shared/types.js";

export interface SubscriberReportDelivery {
	readonly subscriber: WorkflowEventSubscriber;
	/** The subscriber's stage in this run, when it is a workflow stage. */
	readonly stage: StageSnapshot | undefined;
	readonly subscriptionId: string;
	readonly message: string;
}

/**
 * Delivers reports to subscribers as steering messages. A stage replayed from a durable checkpoint has no live session
 * in a resumed run, so its reports go to the stage's retained session, reopened as a post-mortem stage chat is. The run
 * owns each session it reopens: `release` lets them go once their turns end, and `cancel` lets them go at once, which
 * aborts a running turn. A handle someone claimed meanwhile, such as an open stage chat, stays theirs.
 *
 * A report to a workflow stage returns as soon as the stage admits it, so the event child never waits for the turn the
 * report starts in the subscriber. A turn that fails after admission is the subscriber's failure and is recorded
 * through `turnFailed`.
 */
export interface SubscriberReports {
	deliver(delivery: SubscriberReportDelivery): Promise<void>;
	/** Before the run completes: waits for the turns that reports started, or until `cancel`. */
	settle(): Promise<void>;
	/** At the end of the run: lets each reopened session go once its turn ends. */
	release(): Promise<void>;
	/** When the run is cancelled: lets every reopened session go now. */
	cancel(): Promise<void>;
}

type Kebab<T extends string> = T extends `${infer Head}_${infer Tail}` ? `${Head}-${Kebab<Tail>}` : T;

/** The public, kebab-case spelling of why a retained session could not be reopened. */
function unavailableReason<T extends PostMortemUnavailableReason>(reason: T): Kebab<T> & SubscriberUnavailableReason {
	return reason.replaceAll("_", "-") as Kebab<T> & SubscriberUnavailableReason;
}

function turnEnded(handle: StageControlHandle): Promise<void> {
	if (!handle.isStreaming) return Promise.resolve();
	return new Promise((resolve) => {
		const stop = handle.subscribe((event) => {
			if (event.type !== "agent_end") return;
			stop();
			resolve();
		});
	});
}

/** Sends a report and calls `admitted` once the subscriber has taken it in; resolves when the subscriber's turn ends. */
type AdmittedSend = (admitted: () => void) => Promise<unknown>;

interface ObservableStage {
	readonly isStreaming: boolean;
	subscribe(listener: (event: { readonly type: string }) => void): () => void;
}

function isObservableStage(
	subscriber: WorkflowEventSubscriber,
): subscriber is WorkflowEventSubscriber & ObservableStage {
	return typeof (subscriber as Partial<ObservableStage>).subscribe === "function";
}

/**
 * A stage in a turn takes a steering report into that turn, and the send settles once the report is queued. An idle
 * stage starts a turn for the report, which counts as taken in when that turn starts.
 */
function sendToLiveStage(subscriber: WorkflowEventSubscriber & ObservableStage, message: string): AdmittedSend {
	return (admitted) => {
		if (subscriber.isStreaming) return subscriber.sendUserMessage(message, { deliverAs: "steer" });
		const stopWatching = subscriber.subscribe((event) => {
			if (event.type !== "agent_start") return;
			stopWatching();
			admitted();
		});
		const turn = subscriber.sendUserMessage(message, { deliverAs: "steer" });
		void turn.then(stopWatching, stopWatching);
		return turn;
	};
}

export interface SubscriberReportFailures {
	/** A reopened subscriber session could not be let go. */
	readonly cleanupFailed: (stage: string, error: unknown) => void;
	/** The subscriber's turn failed after it admitted a report. */
	readonly turnFailed: (stage: string, error: unknown) => void;
}

export function createSubscriberReports(
	runId: string,
	deps: PostMortemStageChatDeps,
	failures: SubscriberReportFailures,
): SubscriberReports {
	const reopened = new Map<
		string,
		{ readonly stage: string; readonly acquired: Promise<AcquirePostMortemStageHandleResult> }
	>();
	const turns = new Set<Promise<void>>();
	const cancelled = Promise.withResolvers<void>();

	const untilAdmitted = async (stage: string, send: AdmittedSend): Promise<void> => {
		let admitted = false;
		const admission = Promise.withResolvers<void>();
		const turn = send(() => {
			admitted = true;
			admission.resolve();
		});
		const settled = turn.then(
			() => undefined,
			(error: unknown) => {
				if (admitted) failures.turnFailed(stage, error);
			},
		);
		turns.add(settled);
		void settled.then(() => turns.delete(settled));
		await Promise.race([admission.promise, turn]);
	};

	const letGo = async (waitForTurns: boolean): Promise<void> => {
		const owned = [...reopened.values()];
		reopened.clear();
		for (const { stage, acquired } of owned) {
			try {
				const result = await acquired;
				if (!result.ok) continue;
				if (waitForTurns) await turnEnded(result.lease.handle);
				await result.lease.release();
			} catch (error) {
				failures.cleanupFailed(stage, error);
			}
		}
	};

	return {
		async deliver(delivery) {
			const { stage, subscriber, message } = delivery;
			if (stage?.replayed !== true) {
				if (stage === undefined || !isObservableStage(subscriber)) {
					await subscriber.sendUserMessage(message, { deliverAs: "steer" });
					return;
				}
				await untilAdmitted(stage.name, sendToLiveStage(subscriber, message));
				return;
			}
			let owned = reopened.get(stage.id);
			if (owned === undefined) {
				owned = { stage: stage.name, acquired: acquirePostMortemStageHandle(runId, stage, deps) };
				reopened.set(stage.id, owned);
			}
			const result = await owned.acquired;
			if (!result.ok) {
				throw new SubscriptionSubscriberUnavailableError(
					delivery.subscriptionId,
					stage.name,
					unavailableReason(result.reason),
				);
			}
			const { handle } = result.lease;
			if (handle.sendUserMessage === undefined) {
				throw new SubscriptionSubscriberUnavailableError(
					delivery.subscriptionId,
					stage.name,
					"no-message-admission",
				);
			}
			const send = handle.sendUserMessage;
			await untilAdmitted(stage.name, (beforeDelivery) =>
				send.call(handle, message, { deliverAs: "steer" }, beforeDelivery),
			);
		},
		async settle() {
			let settling = true;
			void cancelled.promise.then(() => {
				settling = false;
			});
			while (settling && turns.size > 0) await Promise.race([Promise.all([...turns]), cancelled.promise]);
		},
		release: () => letGo(true),
		cancel: () => {
			cancelled.resolve();
			return letGo(false);
		},
	};
}
