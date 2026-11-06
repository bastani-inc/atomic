/** Report delivery into a subscriber stage, including one replayed from the journal after a resume. */

import { SubscriptionSubscriberUnavailableError } from "@bastani/atomic";
import {
	ensurePostMortemStageHandle,
	type PostMortemStageChatDeps,
} from "../../runs/foreground/postmortem-stage-chat.js";
import type { StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowEventSubscriber } from "../../shared/types.js";

export interface SubscriberReportDelivery {
	readonly runId: string;
	readonly subscriber: WorkflowEventSubscriber;
	/** The subscriber's stage in this run, when it is a workflow stage. */
	readonly stage: StageSnapshot | undefined;
	readonly subscriptionId: string;
	readonly message: string;
	readonly postMortem: PostMortemStageChatDeps;
}

/**
 * Delivers a report to the subscriber as a steering message. A stage replayed from a durable checkpoint has no live
 * session in a resumed run, so its report goes to the stage's retained session, reopened as a post-mortem stage chat is.
 */
export async function deliverSubscriberReport(delivery: SubscriberReportDelivery): Promise<void> {
	const { stage } = delivery;
	if (stage?.replayed !== true) {
		await delivery.subscriber.sendUserMessage(delivery.message, { deliverAs: "steer" });
		return;
	}
	const reopened = await ensurePostMortemStageHandle(delivery.runId, stage, delivery.postMortem);
	if (!reopened.ok) {
		throw new SubscriptionSubscriberUnavailableError(delivery.subscriptionId, stage.name, reopened.reason);
	}
	const send = reopened.handle.sendUserMessage;
	if (send === undefined) {
		throw new SubscriptionSubscriberUnavailableError(delivery.subscriptionId, stage.name, "no_message_admission");
	}
	await send.call(reopened.handle, delivery.message, { deliverAs: "steer" });
}
