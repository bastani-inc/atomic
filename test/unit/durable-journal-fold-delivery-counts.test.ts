/**
 * Folding journal events keeps every sticky entry's delivery count raised to its archived count.
 *
 * The fold used to re-read the archived count of every pending entry after every event. It now reads
 * only entries it has not reconciled and the entries of a message whose count an event raised. These
 * tests check the folded list against reconciling the whole persisted list, live and after replay.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";

const ROOT_RUN_ID = testRunId("journal-fold-delivery-counts-root");
const SEEDS = 40;
const STEPS = 80;

const backends: JournalDurableBackend<MemoryRunJournal>[] = [];
afterEach(async () => {
	for (const backend of backends.splice(0)) await backend.close();
});

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

async function open(journal: MemoryRunJournal): Promise<JournalDurableBackend<MemoryRunJournal>> {
	const backend = await JournalDurableBackend.open(journal);
	backends.push(backend);
	return backend;
}

/** The persisted list with every sticky entry raised to its archived count, as a full re-read gives. */
function reconciled(
	backend: JournalDurableBackend<MemoryRunJournal>,
	list: readonly PendingStageMessage[],
): PendingStageMessage[] {
	return list.map((message) => {
		if (message.sticky !== true) return message;
		const count = backend.getPendingStageMessageDeliveryCount(ROOT_RUN_ID, message.id, message.runId);
		return count > (message.deliveryCount ?? message.deliveries?.length ?? 0)
			? { ...message, deliveryCount: count }
			: message;
	});
}

test("folded sticky entries carry their archived delivery counts, live and after replay", async () => {
	let raised = 0;
	for (let seed = 1; seed <= SEEDS; seed++) {
		const next = random(seed);
		const journal = new MemoryRunJournal();
		const backend = await open(journal);
		await backend.commitWorkflowRegistration({
			workflowId: ROOT_RUN_ID,
			name: "fold",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		let list: PendingStageMessage[] = [];
		let serial = 0;
		for (let step = 0; step < STEPS; step++) {
			const roll = next();
			if (roll < 0.3 || list.length === 0) {
				const id = `message-${serial++ % 12}`;
				if (list.some((entry) => entry.id === id)) continue;
				list = [
					...list,
					{
						id,
						runId: ROOT_RUN_ID,
						stageKey: `workflow:${ROOT_RUN_ID}/**`,
						from: { id: "planner", name: "planner" },
						message: { id, timestamp: 1, content: { text: id } },
						queuedAt: "2026-10-25T00:00:00.000Z",
						admissionOrder: serial,
						status: "queued",
						...(next() < 0.85 ? { sticky: true as const, deliveries: [], deliveryCount: 0 } : {}),
					} as PendingStageMessage,
				];
				assert.equal(await backend.persistPendingStageMessages(ROOT_RUN_ID, list), true);
			} else if (roll < 0.4) {
				list = list.filter((_, index) => index !== Math.floor(next() * list.length));
				assert.equal(await backend.persistPendingStageMessages(ROOT_RUN_ID, list), true);
			} else if (roll < 0.45) {
				// Retention drops an entry while a send appends one: same length, every later entry shifted.
				const index = Math.floor(next() * list.length);
				list = [...list.filter((_, position) => position !== index), list[index]!];
				assert.equal(await backend.persistPendingStageMessages(ROOT_RUN_ID, list), true);
			} else if (roll < 0.55) {
				// The writer persists a stale count, as a store that missed a recovery would.
				const index = Math.floor(next() * list.length);
				list = list.map((entry, position) =>
					position === index && entry.sticky === true
						? { ...entry, deliveryCount: Math.floor(next() * 3) }
						: entry,
				);
				assert.equal(await backend.persistPendingStageMessages(ROOT_RUN_ID, list), true);
			} else {
				const entry = list[Math.floor(next() * list.length)]!;
				const before = backend.getPendingStageMessageDeliveryCount(ROOT_RUN_ID, entry.id, ROOT_RUN_ID);
				await backend.archivePendingStageDeliveryReceipt(
					ROOT_RUN_ID,
					entry.id,
					{
						runId: ROOT_RUN_ID,
						stageId: `stage-${Math.floor(next() * 4)}`,
						...(next() < 0.7 ? { sessionId: `session-${Math.floor(next() * 3)}` } : {}),
						...(next() < 0.8 ? { admission: next() < 0.6 ? "context" : "transport" } : {}),
						deliveredAt: "2026-10-25T00:00:01.000Z",
					},
					next() < 0.8 ? { messageRunId: ROOT_RUN_ID, deliveryCount: 1 + Math.floor(next() * 6) } : undefined,
				);
				if (backend.getPendingStageMessageDeliveryCount(ROOT_RUN_ID, entry.id, ROOT_RUN_ID) > before) raised++;
			}
			assert.deepEqual(
				backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages,
				reconciled(backend, list),
				`seed ${seed} step ${step}`,
			);
		}
		// Resume folds the same journal from the start (#3760).
		const replayed = await open(journal);
		await replayed.hydrateWorkflow(ROOT_RUN_ID);
		assert.deepEqual(
			replayed.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages,
			backend.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages,
			`seed ${seed}: replay`,
		);
	}
	// Archived counts must actually raise entries, or the comparison proves little.
	assert.ok(raised > SEEDS * 5, `only ${raised} receipts raised a count`);
});
