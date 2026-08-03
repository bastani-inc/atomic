import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, test } from "vitest";
import { flattenTruncatedString } from "../../packages/workflows/src/shared/flat-string.js";

/**
 * Large enough that a retained parent is unmistakable against ordinary test
 * churn, and built by joining materialized chunks: `"x".repeat(n)` leaves V8 an
 * unmaterialized rope, which measures as free while held and would make the
 * positive-control arm pass for the wrong reason.
 */
const PARENT_CHUNKS = 16 * 1024;
const CHUNK = 1024;
const PARENT_BYTES = PARENT_CHUNKS * CHUNK;
/** Half a parent: a collected one measures near zero, a pinned one near PARENT_BYTES. */
const RETAINED_PARENT_BYTES = PARENT_BYTES / 2;
const SUMMARY_LIMIT = 240;

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

function materializedParent(character: string): string {
	return new Array(PARENT_CHUNKS).fill(character.repeat(CHUNK)).join("");
}

/**
 * Truncate in its own frame. An interpreter frame keeps every register it held,
 * so a parent built inline would stay reachable through the measurement.
 */
function truncateInFrame(flatten: boolean): string {
	const parent = materializedParent("p");
	const sliced = parent.slice(0, SUMMARY_LIMIT);
	return flatten ? flattenTruncatedString(sliced) : sliced;
}

function retainedBytesFor(flatten: boolean): { retained: number; summary: string } {
	const baseline = heapUsedAfterCollection();
	const summary = truncateInFrame(flatten);
	const retained = heapUsedAfterCollection() - baseline;
	// Read the summary after measuring so it is not collected early.
	assert.equal(summary.length, SUMMARY_LIMIT);
	return { retained, summary };
}

describe("flattenTruncatedString", () => {
	test("a bare slice keeps its parent alive — the probe can observe retention", () => {
		const { retained } = retainedBytesFor(false);
		assert.ok(
			retained > RETAINED_PARENT_BYTES,
			`expected a bare slice to pin its parent, retained ${retained} bytes`,
		);
	});

	test("a flattened truncation releases the parent", () => {
		const { retained } = retainedBytesFor(true);
		assert.ok(
			retained < RETAINED_PARENT_BYTES,
			`expected a flattened truncation to release its parent, retained ${retained} bytes`,
		);
	});

	test("flattening is code-unit exact, including lone surrogates", () => {
		for (const value of ["", "a", "hello world", "héllo ☃", "\uD800", "a\uDC00b", "🙂 mixed \uD83D"]) {
			assert.equal(flattenTruncatedString(value), value);
			assert.equal(flattenTruncatedString(value).length, value.length);
		}
	});
});
