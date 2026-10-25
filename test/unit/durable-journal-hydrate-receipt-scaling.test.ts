/**
 * Hydrating a journal reads delivery counts in proportion to its events (#3951).
 *
 * After a long fan-out was killed, `/workflow status` from a new session folded about 800,000 delivery
 * receipts. Every folded receipt re-read the delivery count of every pending entry, so hydration cost
 * receipts × entries. Replay folds through the same path as live appends; this test counts the reads.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, test } from "vitest";
import { createJournalProjection } from "../../packages/workflows/src/durable/backend.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { MemoryRunJournal } from "../../packages/workflows/src/durable/journal/memory-run-journal.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { testRunId } from "../helpers/run-id.js";

const ROOT_RUN_ID = testRunId("journal-hydrate-receipt-scaling-root");
const ENTRIES = 8_000;
const RECEIPTS = 200_000;
/** A list write every this many receipts, as delivery transitions persist between their receipts. */
const RECEIPTS_PER_SNAPSHOT = 2_000;
const RECEIPT_BATCH = 1_000;
/** Writing 200,000 receipts and replaying them is structural setup and replay cost. */
const HYDRATE_TEST_TIMEOUT_MS = 300_000;

const backends: JournalDurableBackend<MemoryRunJournal>[] = [];
afterEach(async () => {
	for (const backend of backends.splice(0)) await backend.close();
});

async function open(journal: MemoryRunJournal): Promise<JournalDurableBackend<MemoryRunJournal>> {
	const backend = await JournalDurableBackend.open(journal);
	backends.push(backend);
	return backend;
}

function entry(index: number, deliveryCount: number): PendingStageMessage {
	const id = `sticky-${index}`;
	return {
		id,
		runId: ROOT_RUN_ID,
		stageKey: `workflow:${ROOT_RUN_ID}/child-c${index % 640}/**`,
		targetPath: `workflow:${ROOT_RUN_ID}/child-c${index % 640}/**`,
		from: { id: "planner", name: "planner" },
		message: { id, timestamp: 1, content: { text: id } },
		queuedAt: "2026-10-25T00:00:00.000Z",
		admissionOrder: index + 1,
		status: "queued",
		sticky: true,
		deliveries: [],
		deliveryCount,
	};
}

test(
	"hydrating 200,000 receipts over 8,000 sticky entries reads about one count per event",
	async () => {
		const journal = new MemoryRunJournal();
		const writer = await open(journal);
		await writer.commitWorkflowRegistration({
			workflowId: ROOT_RUN_ID,
			name: "hydrate",
			inputs: {},
			status: "running",
			createdAt: 1,
		});
		// The store persists each entry with its delivery count reconciled to the archived count.
		const counts = Array<number>(ENTRIES).fill(0);
		let list = Array.from({ length: ENTRIES }, (_, index) => entry(index, 0));
		assert.equal(await writer.persistPendingStageMessages(ROOT_RUN_ID, list), true);
		let snapshots = 1;
		for (let start = 0; start < RECEIPTS; start += RECEIPT_BATCH) {
			// Each receipt archives an entry's next delivery; the entry's count rises with it, as a delivery
			// transition archives before it persists the entry.
			await Promise.all(
				Array.from({ length: RECEIPT_BATCH }, (_, offset) => {
					const receipt = start + offset;
					const index = receipt % ENTRIES;
					const ordinal = Math.floor(receipt / ENTRIES) + 1;
					counts[index] = ordinal;
					return writer.archivePendingStageDeliveryReceipt(
						ROOT_RUN_ID,
						`sticky-${index}`,
						{
							runId: ROOT_RUN_ID,
							stageId: `stage-${ordinal}`,
							sessionId: `session-${ordinal}`,
							admission: "context",
							deliveredAt: "2026-10-25T00:00:01.000Z",
						},
						{ messageRunId: ROOT_RUN_ID, deliveryCount: ordinal },
					);
				}),
			);
			if ((start + RECEIPT_BATCH) % RECEIPTS_PER_SNAPSHOT === 0) {
				// One delivery transition persists its entry with the next delivery recorded.
				const index = (start / RECEIPT_BATCH) % ENTRIES;
				list = list.map((message, position) =>
					position === index || message.deliveryCount !== counts[position]
						? entry(position, counts[position]! + (position === index ? 1 : 0))
						: message,
				);
				assert.equal(await writer.persistPendingStageMessages(ROOT_RUN_ID, list), true);
				snapshots++;
			}
		}
		const expected = writer.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages;

		// Opening a backend folds the journal, and hydrating folds it again from the start. Each fold reads
		// about one count per receipt and per changed entry; the bound fails fast on a fold that re-reads
		// every entry for every receipt.
		const readLimit = 2 * (RECEIPTS + 2 * ENTRIES);
		const projection = Object.getPrototypeOf(createJournalProjection()) as {
			getPendingStageMessageDeliveryCount: (...args: never[]) => number;
		};
		const original = projection.getPendingStageMessageDeliveryCount;
		let reads = 0;
		projection.getPendingStageMessageDeliveryCount = function (this: unknown, ...args: never[]) {
			if (++reads > readLimit) throw new Error(`hydration read more than ${readLimit} delivery counts`);
			return original.apply(this, args);
		};
		const started = performance.now();
		const reader = await open(journal);
		const opened = { reads, ms: performance.now() - started };
		try {
			await reader.hydrateWorkflow(ROOT_RUN_ID);
		} finally {
			projection.getPendingStageMessageDeliveryCount = original;
		}
		const elapsed = performance.now() - started;
		console.log(
			`open + hydrate of ${RECEIPTS} receipts and ${snapshots} list writes over ${ENTRIES} entries: ${reads} count reads (${opened.reads} while opening), ${elapsed.toFixed(0)} ms (${opened.ms.toFixed(0)} ms opening)`,
		);
		assert.ok(reads <= readLimit, `${reads} count reads`);
		assert.deepEqual(reader.getWorkflow(ROOT_RUN_ID)?.pendingStageMessages, expected);
	},
	HYDRATE_TEST_TIMEOUT_MS,
);
