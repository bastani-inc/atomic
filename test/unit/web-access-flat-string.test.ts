import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { describe, test } from "vitest";
import { flattenTruncatedString } from "../../packages/web-access/flat-string.js";
import { readReadme } from "../../packages/web-access/github-extract.js";

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
const README_LIMIT = 8192;
const README_SUFFIX = "\n\n[README truncated at 8K chars]";

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

function writeLargeReadme(localPath: string): void {
	const parent = materializedParent("r");
	writeFileSync(join(localPath, "README.md"), parent, "utf-8");
}

function readBareReadmeInFrame(localPath: string): string {
	const content = readFileSync(join(localPath, "README.md"), "utf-8");
	return content.length > README_LIMIT ? content.slice(0, README_LIMIT) + README_SUFFIX : content;
}

function readReadmeInFrame(localPath: string): string {
	const readme = readReadme(localPath);
	if (readme === null) throw new Error("expected readReadme to find README.md");
	return readme;
}

/**
 * Where the README string lives depends on the Node/V8 build: `readFileSync`
 * with an encoding may hand back a V8 *external* string (counted only in
 * `external_memory`) or an ordinary in-heap string (counted only in
 * `heapUsed`), and which one you get varies by version and platform. Probe the
 * sum of both counters so a pinned parent is visible either way — and so the
 * positive-control arm still fails loudly if neither counter observes it.
 */
function totalMemoryAfterCollection(): number {
	collect();
	collect();
	return process.memoryUsage().heapUsed + v8.getHeapStatistics().external_memory;
}

function retainedReadme(read: (localPath: string) => string): { retained: number; summary: string } {
	const localPath = mkdtempSync(join(tmpdir(), "web-access-flat-string-"));
	try {
		writeLargeReadme(localPath);
		const baseline = totalMemoryAfterCollection();
		const summary = read(localPath);
		const retained = totalMemoryAfterCollection() - baseline;
		// Read the summary after measuring so it is not collected early.
		assert.equal(summary.length, README_LIMIT + README_SUFFIX.length);
		return { retained, summary };
	} finally {
		rmSync(localPath, { recursive: true, force: true });
	}
}

describe("web-access flattenTruncatedString", () => {
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

	test("a bare file-backed slice keeps its parent alive — the external probe can observe retention", () => {
		const { retained, summary } = retainedReadme(readBareReadmeInFrame);
		assert.equal(summary, "r".repeat(README_LIMIT) + README_SUFFIX);
		assert.ok(
			retained > RETAINED_PARENT_BYTES,
			`expected a bare file-backed slice to pin its parent, retained ${retained} bytes across heap and external memory`,
		);
	});

	test("readReadme returns exact text and releases the README source", () => {
		const { retained, summary } = retainedReadme(readReadmeInFrame);
		assert.equal(summary, "r".repeat(README_LIMIT) + README_SUFFIX);
		// A release can make the signed delta negative when external memory is reclaimed during the measurement.
		assert.ok(
			retained < RETAINED_PARENT_BYTES,
			`expected readReadme to release its README source, retained ${retained} bytes across heap and external memory`,
		);
	});
});
