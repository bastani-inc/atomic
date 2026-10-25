import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import {
	markPendingStageMessageDelivered,
	markPendingStageMessageUndeliverable,
	markPendingStageMessageUndeliverableNotified,
	pendingStageUndeliverableNotificationId,
	queueStageMessage,
	queueStickyStageMessage,
	recordPendingStageMessageDeliveries,
	settleStickyPendingStageMessageDelivered,
} from "../../packages/workflows/src/shared/pending-stage-delivery.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type {
	PendingStageMessage,
	PendingStageMessageInput,
	RunSnapshot,
	StageSnapshot,
	StageStatus,
} from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";
import { sleep } from "../helpers/runtime.js";

const ROOT_RUN_ID = testRunId("pending-transition-equivalence-root");
const CHILD_RUN_IDS = [0, 1, 2, 3].map((index) => testRunId(`pending-transition-equivalence-child-${index}`));
const CHILD_STAGE_IDS = ["worker", "reviewer", "fixer"];
const ROOT_STAGE_ID = "orchestrator";
const GROUP = `workflow:${ROOT_RUN_ID}`;
const SEEDS = 16;
const OPERATIONS_PER_SEED = 600;
/** Each seed replays hundreds of journal-backed transitions in two independent worlds. */
const EQUIVALENCE_TEST_TIMEOUT_MS = 120_000;

afterEach(() => setDurableBackend(undefined));

// ---------------------------------------------------------------------------
// Reference: the pending-stage transition algorithm before incremental ledgers, kept verbatim in
// behavior. Every transition reconciles, compacts and retains the whole pending list.
// ---------------------------------------------------------------------------

interface ReferenceContext {
	readonly state: { readonly runs: RunSnapshot[] };
	findRun(runId: string): RunSnapshot | undefined;
}

function referenceReconcileDeliveryCounts(
	backend: DurableWorkflowBackend,
	runId: string,
	messages: readonly PendingStageMessage[],
): readonly PendingStageMessage[] {
	let changed = false;
	const recovered = messages.map((entry) => {
		if (entry.sticky !== true) return entry;
		const count = backend.getPendingStageMessageDeliveryCount?.(runId, entry.id, entry.runId) ?? 0;
		if (count <= (entry.deliveryCount ?? entry.deliveries?.length ?? 0)) return entry;
		changed = true;
		return { ...entry, deliveryCount: count };
	});
	return changed ? recovered : messages;
}

function referenceCompactStickyStageMessageDeliveries(
	messages: readonly PendingStageMessage[],
	runs: readonly {
		readonly id: string;
		readonly stages: readonly { readonly id: string; readonly status: string }[];
	}[],
): readonly PendingStageMessage[] {
	const finished = new Set(
		runs.flatMap((run) =>
			run.stages
				.filter((stage) => stage.status === "completed" || stage.status === "skipped")
				.map((stage) => JSON.stringify([run.id, stage.id])),
		),
	);
	let changed = false;
	const next = messages.map((entry) => {
		if (entry.sticky !== true || entry.deliveries === undefined) return entry;
		const deliveries = entry.deliveries.filter(
			(delivery) => !finished.has(JSON.stringify([delivery.runId, delivery.stageId])),
		);
		if (deliveries.length === entry.deliveries.length) return entry;
		changed = true;
		return { ...entry, deliveries, deliveryCount: entry.deliveryCount ?? entry.deliveries.length };
	});
	return changed ? next : messages;
}

async function referenceRetainPendingStageMessages(
	messages: readonly PendingStageMessage[],
	archive: (entry: PendingStageMessage) => Promise<void>,
): Promise<readonly PendingStageMessage[]> {
	const settled = messages.filter(
		(entry) =>
			entry.status === "delivered" ||
			(entry.status === "undeliverable" && entry.undeliverableNotifiedAt !== undefined),
	);
	const expired = new Set(settled.slice(0, Math.max(0, settled.length - 50)));
	for (const entry of expired) await archive(entry);
	return expired.size === 0 ? messages : messages.filter((entry) => !expired.has(entry));
}

async function referencePersistTransition(
	backend: DurableWorkflowBackend,
	runId: string,
	messages: readonly PendingStageMessage[],
	context: ReferenceContext,
): Promise<readonly PendingStageMessage[]> {
	let retained = referenceReconcileDeliveryCounts(backend, runId, messages);
	try {
		if (
			backend.archivePendingStageDeliveryReceipt !== undefined &&
			backend.hasPendingStageDeliveryReceipt !== undefined
		) {
			const compacted: PendingStageMessage[] = [];
			for (const entry of retained) {
				if (entry.sticky !== true || entry.deliveries === undefined) {
					compacted.push(entry);
					continue;
				}
				const latest = new Map<string, number>();
				entry.deliveries.forEach((delivery, index) => {
					latest.set(JSON.stringify([delivery.runId, delivery.stageId, delivery.admission]), index);
				});
				const deliveries = [];
				let archivedThrough = -1;
				for (let index = 0; index < entry.deliveries.length; index++) {
					const delivery = entry.deliveries[index]!;
					const stage = context.state.runs
						.find((run) => run.id === delivery.runId)
						?.stages.find((stage) => stage.id === delivery.stageId);
					if (
						entry.status !== "queued" ||
						stage?.status === "completed" ||
						stage?.status === "skipped" ||
						stage?.status === "failed" ||
						(latest.get(JSON.stringify([delivery.runId, delivery.stageId, delivery.admission])) !== index &&
							delivery.sessionId !== undefined)
					) {
						while (archivedThrough < index) {
							const prefixIndex = archivedThrough + 1;
							// A prefix receipt already archived by an earlier transition is not archived again.
							const receipt = entry.deliveries[prefixIndex]!;
							if (!(await backend.hasPendingStageDeliveryReceipt(runId, entry.id, receipt, entry.runId)))
								await backend.archivePendingStageDeliveryReceipt(runId, entry.id, receipt, {
									messageRunId: entry.runId,
									deliveryCount:
										(entry.deliveryCount ?? entry.deliveries.length) -
										entry.deliveries.length +
										prefixIndex +
										1,
								});
							archivedThrough = prefixIndex;
						}
					} else {
						deliveries.push(delivery);
					}
				}
				compacted.push(deliveries.length === entry.deliveries.length ? entry : { ...entry, deliveries });
			}
			retained = compacted;
		}
		retained = referenceCompactStickyStageMessageDeliveries(retained, context.state.runs);
		if (backend.archivePendingStageMessage !== undefined && backend.readSettledPendingStageMessage !== undefined) {
			retained = await referenceRetainPendingStageMessages(retained, (entry) =>
				backend.archivePendingStageMessage!(runId, entry),
			);
		}
		if (!(await backend.persistPendingStageMessages(runId, retained))) {
			throw new Error(`atomic-workflows: durable workflow ${runId} is unavailable for pending-stage persistence`);
		}
		return retained;
	} finally {
		const run = context.findRun(runId);
		if (run !== undefined) {
			const current = run.pendingStageMessages ?? [];
			const recovered = referenceReconcileDeliveryCounts(backend, runId, current);
			if (recovered !== current) run.pendingStageMessages = [...recovered];
		}
	}
}

/** The store's pending-stage methods before incremental ledgers, over a plain run list. */
class ReferenceStore implements ReferenceContext {
	readonly state: { readonly runs: RunSnapshot[] } = { runs: [] };

	findRun(runId: string): RunSnapshot | undefined {
		return this.state.runs.find((run) => run.id === runId);
	}

	recordRunStart(run: RunSnapshot): void {
		const index = this.state.runs.findIndex((existing) => existing.id === run.id);
		if (index === -1) this.state.runs.push(run);
		else this.state.runs[index] = run;
	}

	recordStageEnd(runId: string, stageId: string, status: StageStatus): void {
		const stage = this.findRun(runId)?.stages.find((candidate) => candidate.id === stageId);
		if (stage !== undefined) stage.status = status;
	}

	private async commit(
		backend: DurableWorkflowBackend,
		runId: string,
		run: RunSnapshot,
		next: readonly PendingStageMessage[],
	): Promise<void> {
		const messages = await referencePersistTransition(backend, runId, next, this);
		const live = this.findRun(runId) ?? run;
		live.pendingStageMessages = [...messages];
	}

	async queueStageMessage(input: PendingStageMessageInput, backend: DurableWorkflowBackend) {
		const run = this.findRun(input.runId)!;
		const receipt = await backend.readSettledPendingStageMessage?.(input.runId, input.message.id);
		const result = queueStageMessage(
			receipt === undefined ? (run.pendingStageMessages ?? []) : [...(run.pendingStageMessages ?? []), receipt],
			input,
			GROUP,
			GROUP,
			stageIdentity(run, input.stageKey),
		);
		if (result.ok && !result.deduplicated) await this.commit(backend, input.runId, run, result.messages);
		return result.ok ? result.position : result.reason;
	}

	async queueStickyStageMessage(
		input: PendingStageMessageInput & { readonly targetPath: string },
		backend: DurableWorkflowBackend,
	) {
		const run = this.findRun(input.runId)!;
		const receipt = await backend.readSettledPendingStageMessage?.(input.runId, input.message.id);
		const result = queueStickyStageMessage(
			receipt === undefined ? (run.pendingStageMessages ?? []) : [...(run.pendingStageMessages ?? []), receipt],
			input,
			GROUP,
			GROUP,
		);
		if (result.ok && !result.deduplicated) await this.commit(backend, input.runId, run, result.messages);
		return result.ok ? result.position : result.reason;
	}

	async markPendingStageMessageDelivered(
		runId: string,
		stageKey: string,
		messageId: string,
		deliveredAt: string,
		backend: DurableWorkflowBackend,
	): Promise<boolean> {
		const run = this.findRun(runId)!;
		const current = run.pendingStageMessages ?? [];
		const next = markPendingStageMessageDelivered(
			current,
			runId,
			stageKey,
			messageId,
			deliveredAt,
			stageIdentity(run, stageKey),
		);
		if (next === current) return false;
		await this.commit(backend, runId, run, next);
		return true;
	}

	async markPendingStageMessageUndeliverable(
		runId: string,
		stageKey: string,
		messageId: string,
		reason: string,
		backend: DurableWorkflowBackend,
	): Promise<boolean> {
		const run = this.findRun(runId)!;
		const current = run.pendingStageMessages ?? [];
		const next = markPendingStageMessageUndeliverable(
			current,
			runId,
			stageKey,
			messageId,
			reason,
			stageIdentity(run, stageKey),
		);
		if (next === current) return false;
		await this.commit(backend, runId, run, next);
		return true;
	}

	async markPendingStageMessageUndeliverableNotified(
		runId: string,
		stageKey: string,
		messageId: string,
		notificationId: string,
		notifiedAt: string,
		backend: DurableWorkflowBackend,
	): Promise<boolean> {
		const run = this.findRun(runId)!;
		const current = run.pendingStageMessages ?? [];
		const next = markPendingStageMessageUndeliverableNotified(
			current,
			runId,
			stageKey,
			messageId,
			notificationId,
			notifiedAt,
		);
		if (next === current) return false;
		await this.commit(backend, runId, run, next);
		return true;
	}

	async recordPendingStageMessageDeliveries(
		runId: string,
		messageId: string,
		records: readonly DeliveryRecord[],
		deliveredAt: string,
		backend: DurableWorkflowBackend,
	): Promise<boolean> {
		const run = this.findRun(runId)!;
		if (records.length === 0) await backend.readPendingStageMessageDeliveryCount?.(runId, messageId, runId);
		let current = referenceReconcileDeliveryCounts(backend, runId, run.pendingStageMessages ?? []);
		const unconfirmedRecords = [];
		for (const record of records) {
			const contextReceipt =
				record.admission === "transport" ? { ...record, admission: "context" as const } : undefined;
			if (
				!(await backend.hasPendingStageDeliveryReceipt?.(runId, messageId, record)) &&
				(contextReceipt === undefined ||
					(!current
						.find((entry) => entry.id === messageId)
						?.deliveries?.some(
							(delivery) =>
								delivery.runId === record.runId &&
								delivery.stageId === record.stageId &&
								delivery.sessionId === record.sessionId &&
								delivery.admission === "context",
						) &&
						!(await backend.hasPendingStageDeliveryReceipt?.(runId, messageId, contextReceipt))))
			) {
				unconfirmedRecords.push(record);
			}
		}
		current = referenceReconcileDeliveryCounts(backend, runId, current);
		if (current !== run.pendingStageMessages) run.pendingStageMessages = [...current];
		const next = recordPendingStageMessageDeliveries(current, runId, messageId, unconfirmedRecords, deliveredAt);
		if (next === current) return false;
		await this.commit(backend, runId, run, next);
		return true;
	}

	async settleStickyPendingStageMessageDelivered(
		runId: string,
		messageId: string,
		settledAt: string,
		backend: DurableWorkflowBackend,
	): Promise<boolean> {
		const run = this.findRun(runId)!;
		await backend.readPendingStageMessageDeliveryCount?.(runId, messageId, runId);
		const current = referenceReconcileDeliveryCounts(backend, runId, run.pendingStageMessages ?? []);
		const next = settleStickyPendingStageMessageDelivered(current, runId, messageId, settledAt);
		if (next === current) return false;
		await this.commit(backend, runId, run, next);
		return true;
	}
}

function stageIdentity(run: RunSnapshot, stageKey: string) {
	const exactIds = run.stages.filter((stage) => stage.id === stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === stageKey);
	if (candidates.length !== 1) return undefined;
	const stage = candidates[0]!;
	return {
		id: stage.id,
		...(stage.replayKey !== undefined ? { replayKey: stage.replayKey } : {}),
		aliases: stage.id === stage.name ? [stage.id] : [stage.id, stage.name],
	};
}

// ---------------------------------------------------------------------------
// Randomized operation sequences applied to both worlds.
// ---------------------------------------------------------------------------

interface DeliveryRecord {
	readonly runId: string;
	readonly stageId: string;
	readonly sessionId?: string;
	readonly admission?: "context" | "transport";
}

/** Deterministic PRNG (mulberry32) so a failing seed reproduces exactly. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function stage(id: string, status: StageStatus, sessionId?: string): StageSnapshot {
	return {
		id,
		name: id,
		status,
		parentIds: [],
		toolEvents: [],
		pendingStageDeliveryAvailable: true,
		...(sessionId === undefined ? {} : { sessionId }),
	} as StageSnapshot;
}

function rootRun(pendingStageMessages?: PendingStageMessage[]): RunSnapshot {
	return {
		id: ROOT_RUN_ID,
		name: "pool",
		inputs: {},
		status: "running",
		toolNodes: [],
		stages: [stage(ROOT_STAGE_ID, "running", "root-session")],
		startedAt: 1,
		...(pendingStageMessages === undefined ? {} : { pendingStageMessages }),
	} as RunSnapshot;
}

function childRun(index: number, generation: number): RunSnapshot {
	return {
		id: CHILD_RUN_IDS[index]!,
		name: `child-c${index}`,
		inputs: {},
		status: "running",
		parentRunId: ROOT_RUN_ID,
		rootRunId: ROOT_RUN_ID,
		toolNodes: [],
		stages: CHILD_STAGE_IDS.map((id) => stage(id, "running", `session-${index}-${id}-${generation}`)),
		startedAt: 2,
	} as RunSnapshot;
}

function input(id: string, stageKey: string, targetPath?: string): PendingStageMessageInput & { targetPath: string } {
	return {
		runId: ROOT_RUN_ID,
		stageKey,
		targetPath: targetPath ?? stageKey,
		from: { id: "planner-session", name: "planner", group: GROUP },
		message: { id, timestamp: 1_725_000_000_000, content: { text: `message ${id}` } },
		queuedAt: "2026-09-01T00:00:00.000Z",
	};
}

/** The notification identity an undeliverable exact message carries; a queued one has none yet. */
function notificationId(messageId: string): string {
	return pendingStageUndeliverableNotificationId({ runId: ROOT_RUN_ID, stageKey: ROOT_STAGE_ID, id: messageId });
}

type Operation =
	| { readonly kind: "queue-sticky"; readonly id: string; readonly target: string }
	| { readonly kind: "queue-exact"; readonly id: string }
	| { readonly kind: "deliver-exact"; readonly id: string }
	| { readonly kind: "undeliverable-exact"; readonly id: string }
	| { readonly kind: "notify-exact"; readonly id: string }
	| { readonly kind: "record"; readonly id: string; readonly records: readonly DeliveryRecord[] }
	| { readonly kind: "settle"; readonly id: string }
	| { readonly kind: "stage-end"; readonly child: number; readonly stageId: string; readonly status: StageStatus }
	| { readonly kind: "child-restart"; readonly child: number; readonly generation: number }
	| { readonly kind: "resume" }
	| { readonly kind: "persist-fault"; readonly id: string; readonly records: readonly DeliveryRecord[] };

function operations(seed: number): Operation[] {
	const next = random(seed);
	const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
	const sticky: string[] = [];
	const exact: string[] = [];
	const result: Operation[] = [];
	const generations = CHILD_RUN_IDS.map(() => 0);
	const records = (): DeliveryRecord[] =>
		Array.from({ length: 1 + Math.floor(next() * 3) }, () => {
			const child = Math.floor(next() * CHILD_RUN_IDS.length);
			const stageId = pick(CHILD_STAGE_IDS);
			const roll = next();
			return {
				runId: CHILD_RUN_IDS[child]!,
				stageId,
				...(roll < 0.15 ? {} : { sessionId: `session-${child}-${stageId}-${Math.floor(next() * 3)}` }),
				...(roll < 0.3 ? {} : { admission: next() < 0.6 ? ("context" as const) : ("transport" as const) }),
			};
		});
	for (let index = 0; index < OPERATIONS_PER_SEED; index++) {
		const roll = next();
		if (roll < 0.14 || sticky.length === 0) {
			const id = `sticky-${index}`;
			sticky.push(id);
			result.push({ kind: "queue-sticky", id, target: `workflow:${ROOT_RUN_ID}/child-c${pick([0, 1, 2, 3])}/**` });
		} else if (roll < 0.3) {
			const id = `exact-${index}`;
			exact.push(id);
			result.push({ kind: "queue-exact", id });
		} else if (roll < 0.42 && exact.length > 0) {
			result.push({ kind: "deliver-exact", id: pick(exact.slice(-4)) });
		} else if (roll < 0.46 && exact.length > 0) {
			result.push({ kind: "undeliverable-exact", id: pick(exact) });
		} else if (roll < 0.5 && exact.length > 0) {
			result.push({ kind: "notify-exact", id: pick(exact) });
		} else if (roll < 0.76) {
			result.push({ kind: "record", id: pick(sticky), records: records() });
		} else if (roll < 0.8) {
			result.push({ kind: "settle", id: pick(sticky) });
		} else if (roll < 0.9) {
			result.push({
				kind: "stage-end",
				child: Math.floor(next() * CHILD_RUN_IDS.length),
				stageId: pick(CHILD_STAGE_IDS),
				status: pick(["completed", "failed", "skipped"] as const),
			});
		} else if (roll < 0.95) {
			const child = Math.floor(next() * CHILD_RUN_IDS.length);
			generations[child]! += 1;
			result.push({ kind: "child-restart", child, generation: generations[child]! });
		} else if (roll < 0.97) {
			result.push({ kind: "resume" });
		} else {
			result.push({ kind: "persist-fault", id: pick(sticky), records: records() });
		}
	}
	return result;
}

interface World {
	readonly journal: MemoryRunJournal;
	readonly backend: JournalDurableBackend<MemoryRunJournal>;
	apply(operation: Operation, step: number): Promise<unknown>;
	list(): readonly PendingStageMessage[];
}

async function openBackend(): Promise<{ journal: MemoryRunJournal; backend: JournalDurableBackend<MemoryRunJournal> }> {
	const journal = new MemoryRunJournal();
	const backend = await JournalDurableBackend.open(journal);
	await backend.commitWorkflowRegistration({
		workflowId: ROOT_RUN_ID,
		name: "pool",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	return { journal, backend };
}

async function withPersistFault<T>(backend: DurableWorkflowBackend, action: () => Promise<T>): Promise<unknown> {
	const persist = backend.persistPendingStageMessages;
	backend.persistPendingStageMessages = async () => {
		throw new Error("injected metadata fault");
	};
	try {
		return await action();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	} finally {
		backend.persistPendingStageMessages = persist;
	}
}

async function subjectWorld(persistDelay?: () => Promise<void>): Promise<World> {
	const { journal, backend } = await openBackend();
	if (persistDelay !== undefined) {
		const persist = backend.persistPendingStageMessages.bind(backend);
		backend.persistPendingStageMessages = async (...args) => {
			await persistDelay();
			return await persist(...args);
		};
	}
	let store = createStore();
	const start = (pending?: PendingStageMessage[]) => {
		store.recordRunStart(rootRun(pending));
		for (let index = 0; index < CHILD_RUN_IDS.length; index++) store.recordRunStart(childRun(index, 0));
	};
	start();
	const at = (step: number) =>
		`2026-09-01T00:${String(Math.floor(step / 60)).padStart(2, "0")}:${String(step % 60).padStart(2, "0")}.000Z`;
	return {
		journal,
		backend,
		list: () => store.runs().find((run) => run.id === ROOT_RUN_ID)?.pendingStageMessages ?? [],
		async apply(operation, step) {
			switch (operation.kind) {
				case "queue-sticky": {
					const result = await store.queueStickyStageMessage(
						input(operation.id, operation.target, operation.target),
						GROUP,
						GROUP,
						backend,
					);
					return result?.ok ? result.position : result?.reason;
				}
				case "queue-exact": {
					const result = await store.queueStageMessage(input(operation.id, ROOT_STAGE_ID), GROUP, GROUP, backend);
					return result?.ok ? result.position : result?.reason;
				}
				case "deliver-exact":
					return await store.markPendingStageMessageDelivered(
						ROOT_RUN_ID,
						ROOT_STAGE_ID,
						operation.id,
						at(step),
						backend,
					);
				case "undeliverable-exact":
					return await store.markPendingStageMessageUndeliverable(
						ROOT_RUN_ID,
						ROOT_STAGE_ID,
						operation.id,
						"stage ended",
						backend,
					);
				case "notify-exact": {
					const notification = notificationId(operation.id);
					return await store.markPendingStageMessageUndeliverableNotified(
						ROOT_RUN_ID,
						ROOT_STAGE_ID,
						operation.id,
						notification,
						at(step),
						backend,
					);
				}
				case "record":
					return await store.recordPendingStageMessageDeliveries(
						ROOT_RUN_ID,
						operation.id,
						operation.records,
						at(step),
						backend,
					);
				case "settle":
					return await store.settleStickyPendingStageMessageDelivered(
						ROOT_RUN_ID,
						operation.id,
						at(step),
						backend,
					);
				case "stage-end": {
					const live = store.runs().find((run) => run.id === CHILD_RUN_IDS[operation.child]);
					const existing = live?.stages.find((candidate) => candidate.id === operation.stageId);
					if (existing === undefined) return false;
					store.recordStageEnd(CHILD_RUN_IDS[operation.child]!, { ...existing, status: operation.status });
					return true;
				}
				case "child-restart":
					store.recordRunStart(childRun(operation.child, operation.generation));
					return true;
				case "resume": {
					const durable = backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? [];
					const children = CHILD_RUN_IDS.map((id) => store.runs().find((run) => run.id === id)!);
					store = createStore();
					start([...durable]);
					for (const child of children) store.recordRunStart(child);
					return true;
				}
				case "persist-fault":
					return await withPersistFault(backend, () =>
						store.recordPendingStageMessageDeliveries(
							ROOT_RUN_ID,
							operation.id,
							operation.records,
							at(step),
							backend,
						),
					);
			}
		},
	};
}

async function referenceWorld(): Promise<World> {
	const { journal, backend } = await openBackend();
	let store = new ReferenceStore();
	const start = (pending?: PendingStageMessage[]) => {
		store.recordRunStart(rootRun(pending));
		for (let index = 0; index < CHILD_RUN_IDS.length; index++) store.recordRunStart(childRun(index, 0));
	};
	start();
	const at = (step: number) =>
		`2026-09-01T00:${String(Math.floor(step / 60)).padStart(2, "0")}:${String(step % 60).padStart(2, "0")}.000Z`;
	return {
		journal,
		backend,
		list: () => store.findRun(ROOT_RUN_ID)?.pendingStageMessages ?? [],
		async apply(operation, step) {
			switch (operation.kind) {
				case "queue-sticky":
					return await store.queueStickyStageMessage(
						input(operation.id, operation.target, operation.target),
						backend,
					);
				case "queue-exact":
					return await store.queueStageMessage(input(operation.id, ROOT_STAGE_ID), backend);
				case "deliver-exact":
					return await store.markPendingStageMessageDelivered(
						ROOT_RUN_ID,
						ROOT_STAGE_ID,
						operation.id,
						at(step),
						backend,
					);
				case "undeliverable-exact":
					return await store.markPendingStageMessageUndeliverable(
						ROOT_RUN_ID,
						ROOT_STAGE_ID,
						operation.id,
						"stage ended",
						backend,
					);
				case "notify-exact": {
					const notification = notificationId(operation.id);
					return await store.markPendingStageMessageUndeliverableNotified(
						ROOT_RUN_ID,
						ROOT_STAGE_ID,
						operation.id,
						notification,
						at(step),
						backend,
					);
				}
				case "record":
					return await store.recordPendingStageMessageDeliveries(
						ROOT_RUN_ID,
						operation.id,
						operation.records,
						at(step),
						backend,
					);
				case "settle":
					return await store.settleStickyPendingStageMessageDelivered(
						ROOT_RUN_ID,
						operation.id,
						at(step),
						backend,
					);
				case "stage-end": {
					const existing = store
						.findRun(CHILD_RUN_IDS[operation.child]!)
						?.stages.find((candidate) => candidate.id === operation.stageId);
					if (existing === undefined) return false;
					store.recordStageEnd(CHILD_RUN_IDS[operation.child]!, operation.stageId, operation.status);
					return true;
				}
				case "child-restart":
					store.recordRunStart(childRun(operation.child, operation.generation));
					return true;
				case "resume": {
					const durable = backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages ?? [];
					const children = CHILD_RUN_IDS.map((id) => store.findRun(id)!);
					store = new ReferenceStore();
					start([...durable]);
					for (const child of children) store.recordRunStart(child);
					return true;
				}
				case "persist-fault":
					return await withPersistFault(backend, () =>
						store.recordPendingStageMessageDeliveries(
							ROOT_RUN_ID,
							operation.id,
							operation.records,
							at(step),
							backend,
						),
					);
			}
		},
	};
}

/** Archived message and delivery receipts in journal order. */
async function archivedReceipts(
	journal: MemoryRunJournal,
): Promise<{ readonly type: string; readonly payload: unknown }[]> {
	const receipts: { readonly type: string; readonly payload: unknown }[] = [];
	for await (const entry of journal.read(ROOT_RUN_ID)) {
		const event = entry.event as { readonly type: string; readonly payload: unknown };
		if (event.type === "MessageSettled" || event.type === "MessageDelivered") receipts.push(event);
	}
	return receipts;
}

function deliveryCounts(world: World, messageIds: readonly string[]): number[] {
	return messageIds.map((id) => world.backend.getPendingStageMessageDeliveryCount(ROOT_RUN_ID, id, ROOT_RUN_ID));
}

describe("incremental pending-stage transitions", () => {
	test(
		"match the full-list algorithm on randomized queue, deliver, settle and stage-end sequences",
		async () => {
			let archivedDeliveries = 0;
			let archivedMessages = 0;
			for (let seed = 1; seed <= SEEDS; seed++) {
				const subject = await subjectWorld();
				const reference = await referenceWorld();
				const ids = new Set<string>();
				const script = operations(seed);
				for (const [step, operation] of script.entries()) {
					if ("id" in operation) ids.add(operation.id);
					const where = `seed ${seed} step ${step} ${operation.kind}`;
					assert.deepEqual(
						await subject.apply(operation, step),
						await reference.apply(operation, step),
						`${where}: result`,
					);
					assert.deepEqual(subject.list(), reference.list(), `${where}: store list`);
					assert.deepEqual(
						subject.backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages,
						reference.backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages,
						`${where}: persisted list`,
					);
					assert.deepEqual(
						deliveryCounts(subject, [...ids]),
						deliveryCounts(reference, [...ids]),
						`${where}: delivery counts`,
					);
				}
				const receipts = await archivedReceipts(subject.journal);
				assert.deepEqual(receipts, await archivedReceipts(reference.journal), `seed ${seed}: archived receipts`);
				archivedDeliveries += receipts.filter((receipt) => receipt.type === "MessageDelivered").length;
				archivedMessages += receipts.filter((receipt) => receipt.type === "MessageSettled").length;
				await subject.backend.close();
				await reference.backend.close();
			}
			// The sequences must reach the paths under test: receipt archives and settled-entry retention.
			assert.ok(archivedDeliveries > SEEDS * 20, `only ${archivedDeliveries} delivery receipts were archived`);
			assert.ok(archivedMessages > 0, "no settled entry was archived beyond the retention limit");
		},
		EQUIVALENCE_TEST_TIMEOUT_MS,
	);
});

/** Every this-many-th delivery-receipt archive fails, so faults land mid-compaction after earlier archives. */
const ARCHIVE_FAULT_PERIOD = 9;

/**
 * Fail a fixed subset of receipt archives by call index. Batched and sequential execution archive the same
 * receipts in the same order, so the same archives fail in both worlds.
 */
function failSomeArchives(backend: DurableWorkflowBackend): void {
	const archive = backend.archivePendingStageDeliveryReceipt!.bind(backend);
	let calls = 0;
	backend.archivePendingStageDeliveryReceipt = async (...args) => {
		calls++;
		if (calls % ARCHIVE_FAULT_PERIOD === 0) throw new Error("injected receipt archive fault");
		return await archive(...args);
	};
}

/** Store transitions that may run concurrently; the rest change runs or inject faults and run alone. */
const CONCURRENT_KINDS = new Set<Operation["kind"]>([
	"queue-sticky",
	"queue-exact",
	"deliver-exact",
	"undeliverable-exact",
	"notify-exact",
	"record",
	"settle",
]);

describe("batched pending-stage transitions", () => {
	test(
		"concurrent queue, deliver, settle and notify calls match sequential execution for every caller, under archive faults",
		async () => {
			let concurrentCalls = 0;
			let subjectPersists = 0;
			let referencePersists = 0;
			let archiveFaults = 0;
			for (let seed = 1; seed <= SEEDS; seed++) {
				const next = random(seed * 7919);
				const sleepRandomly = async () => {
					const roll = next();
					if (roll < 0.4) return;
					if (roll < 0.7) await Promise.resolve();
					else await sleep(roll < 0.9 ? 0 : 1);
				};
				const subject = await subjectWorld(async () => {
					subjectPersists++;
					await sleepRandomly();
				});
				const reference = await referenceWorld();
				const referencePersist = reference.backend.persistPendingStageMessages.bind(reference.backend);
				reference.backend.persistPendingStageMessages = async (...args) => {
					referencePersists++;
					return await referencePersist(...args);
				};
				failSomeArchives(subject.backend);
				failSomeArchives(reference.backend);
				const ids = new Set<string>();
				const script = operations(seed);
				let step = 0;
				while (step < script.length) {
					// A run of concurrent transitions issued with random gaps, so some join the batch being
					// built while others queue behind a persist in flight.
					const group: [number, Operation][] = [];
					const size = CONCURRENT_KINDS.has(script[step]!.kind) ? 1 + Math.floor(next() * 12) : 1;
					while (group.length < size && step < script.length) {
						const operation = script[step]!;
						if (group.length > 0 && !CONCURRENT_KINDS.has(operation.kind)) break;
						group.push([step, operation]);
						step++;
						if (!CONCURRENT_KINDS.has(operation.kind)) break;
					}
					const pending: Promise<unknown>[] = [];
					for (const [index, operation] of group) {
						if ("id" in operation) ids.add(operation.id);
						pending.push(
							subject.apply(operation, index).then(
								(value) => ({ value }),
								(error: Error) => ({ error: error.message }),
							),
						);
						await sleepRandomly();
					}
					if (group.length > 1) concurrentCalls += group.length;
					const results = await Promise.all(pending);
					archiveFaults += results.filter(
						(result) => (result as { error?: string }).error === "injected receipt archive fault",
					).length;
					for (const [offset, [index, operation]] of group.entries()) {
						const where = `seed ${seed} step ${index} ${operation.kind}`;
						const expected = await reference.apply(operation, index).then(
							(value) => ({ value }),
							(error: Error) => ({ error: error.message }),
						);
						assert.deepEqual(results[offset], expected, `${where}: result`);
					}
					const where = `seed ${seed} after step ${step - 1}`;
					assert.deepEqual(subject.list(), reference.list(), `${where}: store list`);
					assert.deepEqual(
						subject.backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages,
						reference.backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages,
						`${where}: persisted list`,
					);
					assert.deepEqual(
						deliveryCounts(subject, [...ids]),
						deliveryCounts(reference, [...ids]),
						`${where}: delivery counts`,
					);
				}
				assert.deepEqual(
					await archivedReceipts(subject.journal),
					await archivedReceipts(reference.journal),
					`seed ${seed}: archived receipts`,
				);
				await subject.backend.close();
				await reference.backend.close();
			}
			// Callers must actually fail mid-compaction, after earlier receipts were archived (Greptile #3947).
			assert.ok(archiveFaults > SEEDS, `only ${archiveFaults} callers hit an archive fault`);
			assert.ok(concurrentCalls > SEEDS * 100, `only ${concurrentCalls} calls ran concurrently`);
			// Batching must actually have shared persists between transitions.
			assert.ok(
				subjectPersists < referencePersists * 0.8,
				`batched execution persisted ${subjectPersists} times; sequential ${referencePersists}`,
			);
		},
		EQUIVALENCE_TEST_TIMEOUT_MS,
	);
});
