/**
 * Durable records of `ctx.subscribe` and `ctx.events`.
 *
 * Storage shape: reserved tool-kind checkpoints with no topology, following `run-timing.ts`, so they never become
 * graph nodes. One write-once record per subscription keeps its source and caps; one compact record per processed
 * event id makes a redelivered event (after resume, or from a source that repeats itself) a no-op. Both are found by
 * O(1) `getToolCheckpoint` lookups, never by listing the journal.
 */

import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./durable-hash.js";
import { recordCheckpointDurably } from "./tool-primitive.js";

const SUBSCRIPTION_CHECKPOINT_PREFIX = "workflow-subscription:";
const SUBSCRIPTION_EVENT_CHECKPOINT_PREFIX = "workflow-subscription-event:";

/** True for a reserved subscription record, including one stored under a child workflow's scope prefix. */
export function isSubscriptionCheckpointHash(argsHash: string): boolean {
	return [SUBSCRIPTION_CHECKPOINT_PREFIX, SUBSCRIPTION_EVENT_CHECKPOINT_PREFIX].some(
		(prefix) => argsHash.startsWith(prefix) || argsHash.includes(`:${prefix}`),
	);
}

export interface DurableSubscriptionRecord {
	readonly subscription: string;
	readonly source: string;
	readonly mode: "child" | "inline";
	readonly maxConcurrent: number;
	readonly maxRate: { readonly events: number; readonly intervalMs: number } | null;
}

export async function recordSubscription(
	backend: DurableWorkflowBackend,
	workflowId: string,
	record: DurableSubscriptionRecord,
): Promise<void> {
	const key = `${SUBSCRIPTION_CHECKPOINT_PREFIX}${record.subscription}`;
	if (backend.getToolCheckpoint(workflowId, key) !== undefined) return;
	await recordCheckpointDurably(backend, {
		kind: "tool",
		workflowId,
		checkpointId: key,
		name: key,
		argsHash: key,
		output: { ...record, maxRate: record.maxRate === null ? null : { ...record.maxRate } },
		completedAt: Date.now(),
	});
}

function eventKey(subscription: string, eventId: string): string {
	return `${SUBSCRIPTION_EVENT_CHECKPOINT_PREFIX}${durableHash([subscription, eventId])}`;
}

export function subscriptionEventProcessed(
	backend: DurableWorkflowBackend,
	workflowId: string,
	subscription: string,
	eventId: string,
): boolean {
	return backend.getToolCheckpoint(workflowId, eventKey(subscription, eventId)) !== undefined;
}

export async function recordSubscriptionEventProcessed(
	backend: DurableWorkflowBackend,
	workflowId: string,
	subscription: string,
	eventId: string,
): Promise<void> {
	const key = eventKey(subscription, eventId);
	await recordCheckpointDurably(backend, {
		kind: "tool",
		workflowId,
		checkpointId: key,
		name: key,
		argsHash: key,
		output: { subscription, eventId },
		completedAt: Date.now(),
	});
}
