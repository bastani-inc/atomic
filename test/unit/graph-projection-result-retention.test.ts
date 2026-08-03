import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, test } from "vitest";
import { COMPACT_RESULT_FIELD_LIMIT } from "../../packages/workflows/src/shared/graph-store-snapshot.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { Store } from "../../packages/workflows/src/shared/store-public-types.js";
import type { StoreSnapshot } from "../../packages/workflows/src/shared/store-types.js";

/**
 * One payload is COMPACT_RESULT_FIELD_LIMIT-sized chunks joined into a single
 * flat string, so its heap cost is exactly what a projected field drops.
 * `"x".repeat(n)` is unusable here: V8 leaves it unmaterialized, so it would
 * measure as free while held and only appear once something flattened it.
 */
const PAYLOAD_CHUNKS = 16 * 1024;
const PAYLOAD_BYTES = PAYLOAD_CHUNKS * COMPACT_RESULT_FIELD_LIMIT;

/**
 * Half of one payload. A collected parent measures near zero and a pinned one
 * near PAYLOAD_BYTES, so a single threshold decides both directions: the
 * "payload held" arm proves the probe sees what the other two arms deny.
 */
const RETAINED_PARENT_BYTES = PAYLOAD_BYTES / 2;

const RUN_ID = "run-big-result";

type Hold = "payload" | "nothing" | "projection";

interface RetentionProbe {
	readonly retainedBytes: number;
	readonly compactedLength: number | undefined;
	readonly compactedIsTruncatedPrefix: boolean;
}

interface SeededRun {
	readonly projection: StoreSnapshot | undefined;
	readonly payloads: readonly string[];
}

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		const exposed = vm.runInNewContext("gc") as () => void;
		assert.equal(typeof exposed, "function", "expected --expose-gc to expose gc()");
		return exposed;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();

function heapUsedAfterCollection(): number {
	collect();
	collect();
	return process.memoryUsage().heapUsed;
}

function materializedPayload(character: string): string {
	return new Array(PAYLOAD_CHUNKS).fill(character.repeat(COMPACT_RESULT_FIELD_LIMIT)).join("");
}

/**
 * The run is seeded in its own frame: an interpreter frame keeps every register
 * it ever held alive, so a payload passed as an argument here would stay
 * reachable through the measurement if this ran inline.
 */
function seedEndedRun(store: Store, hold: Hold): SeededRun {
	const summaryPayload = materializedPayload("s");
	const resultPayload = materializedPayload("r");
	store.recordRunStart({
		id: RUN_ID,
		name: "big-result",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now(),
	});
	assert.equal(store.recordRunEnd(RUN_ID, "completed", { summary: summaryPayload, result: resultPayload }), true);
	return {
		projection: hold === "projection" ? store.graphSnapshot() : undefined,
		payloads: hold === "payload" ? [summaryPayload, resultPayload] : [],
	};
}

function inspectCompactedSummary(projection: StoreSnapshot | undefined): Omit<RetentionProbe, "retainedBytes"> {
	const summary = projection?.runs[0]?.result?.summary;
	if (typeof summary !== "string") return { compactedLength: undefined, compactedIsTruncatedPrefix: false };
	return {
		compactedLength: summary.length,
		compactedIsTruncatedPrefix: summary.startsWith("s") && !summary.includes("r"),
	};
}

function probeRetention(hold: Hold): RetentionProbe {
	const store = createStore();
	const baseline = heapUsedAfterCollection();
	const seeded = seedEndedRun(store, hold);
	const compacted =
		hold === "projection" ? inspectCompactedSummary(seeded.projection) : inspectCompactedSummary(undefined);
	assert.equal(store.removeRun(RUN_ID), true);
	const retainedBytes = heapUsedAfterCollection() - baseline;

	// Read the intended holders after the measurement so nothing is collected
	// early for want of a later use.
	if (hold === "payload")
		assert.deepEqual(
			seeded.payloads.map((payload) => payload.length),
			[PAYLOAD_BYTES, PAYLOAD_BYTES],
		);
	if (hold === "projection") assert.equal(seeded.projection?.runs[0]?.id, RUN_ID);
	assert.equal(store.graphSnapshot().runs.length, 0);
	return { retainedBytes, ...compacted };
}

describe("graph projection result retention", () => {
	test("the probe observes a payload that is deliberately still held", () => {
		const probe = probeRetention("payload");
		assert.ok(
			probe.retainedBytes > RETAINED_PARENT_BYTES,
			`expected a held payload to stay on the heap, retained ${probe.retainedBytes} bytes`,
		);
	});

	test("a removed run frees its result when no projection was taken", () => {
		const probe = probeRetention("nothing");
		assert.ok(
			probe.retainedBytes < RETAINED_PARENT_BYTES,
			`expected a removed run to free its result, retained ${probe.retainedBytes} bytes`,
		);
	});

	test("a held projection truncates the result instead of pinning it", () => {
		const probe = probeRetention("projection");
		assert.equal(probe.compactedLength, COMPACT_RESULT_FIELD_LIMIT);
		assert.equal(probe.compactedIsTruncatedPrefix, true);
		assert.ok(
			probe.retainedBytes < RETAINED_PARENT_BYTES,
			`expected the projection to drop the untruncated result, retained ${probe.retainedBytes} bytes`,
		);
	});
});
