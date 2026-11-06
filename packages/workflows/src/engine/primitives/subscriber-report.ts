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
 */
export interface SubscriberReports {
	deliver(delivery: SubscriberReportDelivery): Promise<void>;
	/** At the end of the run: waits for each reopened session's turn, then lets the session go. */
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

export function createSubscriberReports(
	runId: string,
	deps: PostMortemStageChatDeps,
	recordCleanupFailure: (stage: string, error: unknown) => void,
): SubscriberReports {
	const reopened = new Map<
		string,
		{ readonly stage: string; readonly acquired: Promise<AcquirePostMortemStageHandleResult> }
	>();

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
				recordCleanupFailure(stage, error);
			}
		}
	};

	return {
		async deliver(delivery) {
			const { stage } = delivery;
			if (stage?.replayed !== true) {
				await delivery.subscriber.sendUserMessage(delivery.message, { deliverAs: "steer" });
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
			await handle.sendUserMessage(delivery.message, { deliverAs: "steer" });
		},
		release: () => letGo(true),
		cancel: () => letGo(false),
	};
}
