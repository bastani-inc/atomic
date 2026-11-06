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

/** A session event as a subscriber stage reports it; `message_end` comes after the session saved the message. */
interface SubscriberSessionEvent {
	readonly type: string;
	readonly message?: { readonly role?: string };
}

/** A workflow stage of this run that subscribed: it takes steering messages and reports its session's events. */
export interface LiveSubscriberStage {
	readonly isStreaming: boolean;
	sendUserMessage(content: string, options?: { readonly deliverAs?: "steer" | "followUp" }): Promise<unknown>;
	subscribe(listener: (event: SubscriberSessionEvent) => void): () => void;
}

/** A report the subscriber took in. `saved` settles once the subscriber's session has saved it. */
export interface DeliveredReport {
	readonly saved: Promise<void>;
}

export interface SubscriberReportDelivery {
	readonly subscriber: WorkflowEventSubscriber;
	/** The subscriber's stage context, when the subscriber is a workflow stage of this run. */
	readonly live: LiveSubscriberStage | undefined;
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
 * through `turnFailed`. A report steered into a running turn waits in the subscriber's queue in memory until that turn
 * takes it; `saved` lets the caller hold the event's processed record until the subscriber's session saved the report.
 */
export interface SubscriberReports {
	deliver(delivery: SubscriberReportDelivery): Promise<DeliveredReport>;
	/** Before the run completes: waits for the turns that reports started. The run races it with its cancellation. */
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

/**
 * Sends a report and calls `admitted` once the subscriber has taken it in and `saved` once its session saved it;
 * resolves when the subscriber's turn ends, or, for a report steered into a running turn, once it is queued.
 */
type AdmittedSend = (admitted: () => void, saved: () => void) => Promise<unknown>;

function isSavedUserMessage(event: SubscriberSessionEvent): boolean {
	return event.type === "message_end" && event.message?.role === "user";
}

/**
 * An idle stage starts a turn for the report: the report counts as taken in when that turn starts, and as saved once
 * the turn's first user message, the report, is saved (`message_end`, which a session emits after saving). A stage
 * already in a turn queues the report: it counts as taken in once queued, and as saved when that turn ends
 * (`agent_end`), because a turn takes the reports queued into it before it ends and saves every message first. An input
 * hook may rewrite the report's text, so nothing here matches the saved message by its text.
 */
function sendToLiveStage(stage: LiveSubscriberStage, message: string): AdmittedSend {
	return (admitted, saved) => {
		const queuedIntoTurn = stage.isStreaming;
		let turnStarted = false;
		const savedNow = (): void => {
			stopWatching();
			saved();
		};
		const stopWatching = stage.subscribe((event) => {
			if (event.type === "agent_start") {
				turnStarted = true;
				admitted();
			}
			if (queuedIntoTurn ? event.type === "agent_end" : turnStarted && isSavedUserMessage(event)) savedNow();
		});
		const turn = stage.sendUserMessage(message, { deliverAs: "steer" });
		void turn.then(() => {
			if (!queuedIntoTurn) savedNow();
		}, savedNow);
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

	const untilAdmitted = async (stage: string, send: AdmittedSend): Promise<DeliveredReport> => {
		let admitted = false;
		const admission = Promise.withResolvers<void>();
		const saved = Promise.withResolvers<void>();
		const turn = send(
			() => {
				admitted = true;
				admission.resolve();
			},
			() => saved.resolve(),
		);
		const settled = turn.then(
			() => undefined,
			(error: unknown) => {
				if (admitted) failures.turnFailed(stage, error);
			},
		);
		turns.add(settled);
		void settled.then(() => turns.delete(settled));
		await Promise.race([admission.promise, turn]);
		return { saved: saved.promise };
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
			const { stage, live, subscriber, message } = delivery;
			if (stage?.replayed !== true) {
				if (live === undefined || stage === undefined) {
					await subscriber.sendUserMessage(message, { deliverAs: "steer" });
					return { saved: Promise.resolve() };
				}
				return await untilAdmitted(stage.name, sendToLiveStage(live, message));
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
			const sendUserMessage = handle.sendUserMessage;
			const reopenedStage: LiveSubscriberStage = {
				get isStreaming() {
					return handle.isStreaming;
				},
				sendUserMessage: (content, options) => sendUserMessage.call(handle, content, options),
				subscribe: (listener) => handle.subscribe(listener),
			};
			return await untilAdmitted(stage.name, sendToLiveStage(reopenedStage, message));
		},
		async settle() {
			while (turns.size > 0) await Promise.all([...turns]);
		},
		release: () => letGo(true),
		cancel: () => letGo(false),
	};
}
