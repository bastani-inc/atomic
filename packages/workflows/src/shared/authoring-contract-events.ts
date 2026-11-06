/** Event subscription contracts for `ctx.subscribe` and `ctx.events`. */

import type {
	EventSource,
	Subscription,
	SubscriptionAdmission,
	SubscriptionEvent,
	SubscriptionRate,
	SubscriptionStats,
} from "@bastani/atomic";
import type { WorkflowTaskOptions, WorkflowTaskResult } from "./authoring-contract-stage.js";

/** The long-lived stage that receives reports. Any `ctx.stage(...)` handle satisfies it. */
export interface WorkflowEventSubscriber {
	readonly name: string;
	sendUserMessage(content: string, options?: { readonly deliverAs?: "steer" | "followUp" }): Promise<void>;
}

/** One event's short-lived child, handed to the subscription handler. */
export interface WorkflowEventChild {
	/** Name of this event's tracked child stage. */
	readonly name: string;
	readonly subscriptionId: string;
	readonly event: SubscriptionEvent;
	/**
	 * Runs this event's tracked child stage with `ctx.task` options. The prompt is seeded with the event, and the
	 * stage gets a `report_to_subscriber` tool that calls `report`.
	 */
	task(options: WorkflowTaskOptions): Promise<WorkflowTaskResult>;
	/** Sends a short report to the subscriber. Call it only when the event matters. */
	report(text: string): Promise<void>;
}

export type WorkflowEventHandler = (event: SubscriptionEvent, child: WorkflowEventChild) => void | Promise<void>;

export interface WorkflowSubscribeOptions extends SubscriptionAdmission {
	/** Stage that receives reports. Without one, reports are recorded as run notices. */
	readonly subscriber?: WorkflowEventSubscriber;
	/** Names the subscription and its child stages. Defaults to the source id. */
	readonly name?: string;
}

export interface WorkflowSubscription extends Subscription {}

export interface WorkflowEventsOptions {
	/** Names the subscription. Defaults to the source id. */
	readonly name?: string;
	readonly maxRate?: SubscriptionRate;
}

/** Inline event stream: each event is yielded to the run body once, in arrival order. */
export interface WorkflowEventStream extends AsyncIterableIterator<SubscriptionEvent> {
	readonly id: string;
	stats(): SubscriptionStats;
	/** Stops the source and ends the iteration. */
	close(): Promise<SubscriptionStats>;
}

export interface WorkflowEventPrimitives {
	/** Handle each event of `source` in its own tracked child; see `WorkflowEventChild`. */
	subscribe(
		source: EventSource,
		handler: WorkflowEventHandler,
		options?: WorkflowSubscribeOptions,
	): WorkflowSubscription;
	/** Inline mode: iterate the events of `source` in the run body itself. */
	events(source: EventSource, options?: WorkflowEventsOptions): WorkflowEventStream;
}
