import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { DurableStageCheckpoint } from "../durable/types.js";
import { stickyEntryTargetsStage, toPendingStageSender } from "../runs/foreground/pending-stage-delivery.js";
import { pendingStageMessageAdmissionOrder, pendingStageMessagesFor } from "../shared/pending-stage-delivery.js";
import type { WorkflowBoundaryHop } from "../shared/pending-stage-status.js";
import type { Store } from "../shared/store.js";
import { resolvePendingStageIdentity } from "../shared/store-pending-stage-delivery-methods.js";
import type { PendingStageMessage, RunSnapshot } from "../shared/store-types.js";
import { type RunsById, runsByIdOf } from "../shared/workflow-run-ownership.js";
import type { WorkerDeliver, WorkerRecipient, WorkerStageDelivery } from "./protocol.js";

export interface PooledStageIdentity {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
}

type PooledStageJournal = Pick<DurableWorkflowBackend, "getWorkflow" | "listCheckpoints">;

/**
 * The queued Intercom entries the root's journal holds for one stage of a pooled child, in the order the root
 * delivers them: the stage's exact entries and the root run's sticky entries whose target matches the stage.
 * `store` is the attempt's own store, which holds the child's runs; the root run is read from the journal.
 */
export function pooledStageQueuedEntries(
	journal: PooledStageJournal,
	store: Store,
	root: string,
	stage: PooledStageIdentity,
): readonly PendingStageMessage[] {
	const messages = journal.getWorkflow(root)?.pendingStageMessages ?? [];
	const runs = runsByIdOf(store);
	const run = runs.get(stage.runId);
	if (run === undefined) return [];
	const exact = new Set<PendingStageMessage>();
	for (const key of new Set([stage.stageId, stage.stageName]))
		for (const entry of pendingStageMessagesFor(messages, stage.runId, key, resolvePendingStageIdentity(run, key)))
			exact.add(entry);
	const hops = pooledStageHops(journal, runs, root, stage.runId);
	const sticky =
		hops === undefined
			? []
			: messages.filter(
					(entry) =>
						entry.runId === root && stickyEntryTargetsStage(entry, root, hops, stage.stageId, stage.stageName),
				);
	// As the root's drain orders them: exact entries by admission and queue position, sticky ones by admission.
	return [
		...[...exact].map((entry) => ({ entry, index: messages.indexOf(entry) })),
		...sticky.map((entry) => ({ entry, index: Number.MAX_SAFE_INTEGER })),
	]
		.map(({ entry, index }) => ({ entry, index, order: pendingStageMessageAdmissionOrder(entry) }))
		.sort((left, right) => left.order - right.order || left.index - right.index)
		.map(({ entry }) => entry);
}

/**
 * Boundary hops from the root to a run of a pooled child. The child's own boundary lives in the root run, which
 * the attempt's store does not hold, so its name comes from the boundary's journal record. `runs` finds each run
 * by id, so the walk reads only the run and its ancestors.
 */
function pooledStageHops(
	journal: PooledStageJournal,
	runs: RunsById,
	root: string,
	runId: string,
): readonly WorkflowBoundaryHop[] | undefined {
	const hops: WorkflowBoundaryHop[] = [];
	let current = runs.get(runId);
	while (current !== undefined && current.parentRunId !== root) {
		const child: RunSnapshot = current;
		const parent = child.parentRunId === undefined ? undefined : runs.get(child.parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === child.parentStageId);
		if (parent === undefined || boundary === undefined) return undefined;
		hops.unshift({ name: boundary.name, runId: child.id });
		current = parent;
	}
	if (current === undefined) return undefined;
	const childRunId = current.id;
	const boundary = journal
		.listCheckpoints(root)
		.find(
			(checkpoint): checkpoint is DurableStageCheckpoint =>
				checkpoint.kind === "stage" && checkpoint.topology?.boundary?.child.runId === childRunId,
		);
	if (boundary === undefined) return undefined;
	hops.unshift({ name: boundary.name, runId: childRunId });
	return hops;
}

export interface PooledStageDeliveryOptions {
	readonly routeCapability: string;
	/** The stage's queued entries, read where the worker can reach them without waiting on the root. */
	readonly queued: () => Promise<readonly PendingStageMessage[]>;
	/**
	 * Asks the root to drain the stage as well. The root records the delivery of every entry `recipient` already
	 * holds, and hands anything else, such as an entry queued after `queued` read the journal, to `deliver`.
	 */
	readonly forward: (recipient: NonNullable<WorkerRecipient>, deliver: WorkerDeliver) => Promise<void>;
	readonly fail: WorkerStageDelivery["fail"];
}

/**
 * Pending-stage delivery for a stage on a local worker. The worker delivers the stage's queued messages itself,
 * before its first turn, so a stage never waits on a root too busy to answer. The root's own drain follows in the
 * background: it records the receipts, which only the root writes, and delivers what the worker could not read.
 * Each message reaches a session once, whichever drain hands it over first.
 */
export function createPooledStageDelivery(options: PooledStageDeliveryOptions): WorkerStageDelivery {
	const admissions = new Map<string, Map<string, Promise<void>>>();
	/** Each session's latest sink: a root drain that finishes after a later drain began hands over through it. */
	const sinks = new Map<string, WorkerDeliver>();
	return {
		routeCapability: options.routeCapability,
		async deliverPending(deliver, recipient) {
			const sessionId = recipient?.sessionId ?? "";
			sinks.set(sessionId, deliver);
			let admitted = admissions.get(sessionId);
			if (admitted === undefined) {
				admitted = new Map();
				admissions.set(sessionId, admitted);
			}
			const held = admitted;
			for (const id of recipient?.receivedMessageIds ?? []) if (!held.has(id)) held.set(id, Promise.resolve());
			// The sink decides how a message reaches the session: Intercom frames one handed over while the stage
			// starts as pre-start context, and delivers one handed over later live, in its own delivery mode.
			const admit: WorkerDeliver = (from, message) => {
				const existing = held.get(message.id);
				if (existing !== undefined) return existing;
				const sink = sinks.get(sessionId) ?? deliver;
				const delivery = Promise.resolve().then(() => sink(from, message));
				held.set(message.id, delivery);
				// A failed delivery leaves the message to the next drain.
				delivery.catch(() => {
					if (held.get(message.id) === delivery) held.delete(message.id);
				});
				return delivery;
			};
			try {
				for (const entry of await options.queued()) await admit(toPendingStageSender(entry), entry.message);
			} catch {
				// Whatever this drain could not deliver stays queued; the root's drain below delivers it.
			}
			const deliveries = [...held];
			const settled = await Promise.allSettled(deliveries.map(([, delivery]) => delivery));
			const receivedMessageIds = deliveries.flatMap(([id], index) =>
				settled[index]?.status === "fulfilled" ? [id] : [],
			);
			// The root answers when its drain ends, so later messages of a slow drain still reach the session. The
			// stage does not wait for it: a failure is the root's to report, and the entries stay queued.
			void options.forward({ sessionId, receivedMessageIds }, admit).catch(() => {});
		},
		ready() {
			return undefined;
		},
		fail: options.fail,
	};
}
