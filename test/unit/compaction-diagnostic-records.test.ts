/**
 * Durable planner evidence: one record per attempt, each carrying its own
 * distinct category.
 *
 * Overflow is a typed outcome in code, so it must be distinguishable in the
 * sidecar too. And sidecar names were millisecond-only, so two attempts inside
 * one millisecond — routine across overflow trims or a fast fallback walk —
 * chose the same path and the second write replaced the first.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { planDeletedLineRanges } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import {
	writeDiagnosticSidecar,
	writeRecoveryDiagnosticSidecar,
	writeSuccessDiagnosticSidecar,
} from "../../packages/coding-agent/src/core/compaction/range-planner-diagnostics.js";
import { borrowed, PARAMETERS, region, scriptedStream, testModel } from "./compaction-rung-support.js";

const posixMode = process.platform === "win32" ? test.skip : test;

let directory: string;
let sessionFilePath: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "compaction-diagnostic-records-"));
	sessionFilePath = join(directory, "session.jsonl");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function sidecars(marker: string): string[] {
	return readdirSync(directory)
		.filter((name) => name.includes(marker))
		.map((name) => join(directory, name));
}

function payload(path: string): { failureCategory?: string; model?: { provider: string; id: string } } {
	return JSON.parse(readFileSync(path, "utf-8")) as {
		failureCategory?: string;
		model?: { provider: string; id: string };
	};
}

async function planFailure(entry: { errorMessage?: string; throws?: string }) {
	const stream = scriptedStream({ default: [entry] });
	return planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
		streamFn: stream.streamFn,
		sessionFilePath,
	});
}

test("a returned context overflow records the context_overflow category", async () => {
	const outcome = await planFailure({ errorMessage: "This model's maximum context length is 100000 tokens" });
	assert.equal(outcome.kind, "overflowed");

	const written = sidecars("compaction-diagnostic");
	assert.equal(written.length, 1);
	const record = payload(written[0]);
	assert.equal(record.failureCategory, "context_overflow");
	assert.equal(record.model?.provider, "primary");
	assert.equal(record.model?.id, "planner-a");
	// The outcome points at the record that was actually written.
	assert.equal((outcome as { diagnosticPath?: string }).diagnosticPath, written[0]);
});

test("a thrown overflow-shaped transport failure also records context_overflow", async () => {
	const outcome = await planFailure({ throws: "prompt is too long: context_length_exceeded" });
	assert.equal(outcome.kind, "overflowed");
	assert.equal(payload(sidecars("compaction-diagnostic")[0]).failureCategory, "context_overflow");
});

test("overflow stays distinct from every other failure category", async () => {
	const cases: Array<[{ errorMessage?: string; throws?: string }, string]> = [
		[{ errorMessage: "This model's maximum context length is 100000 tokens" }, "context_overflow"],
		[{ errorMessage: "429 Too Many Requests" }, "rate_limited"],
		[{ errorMessage: "insufficient_quota" }, "quota"],
		[{ errorMessage: "malformed tool schema" }, "provider_error"],
		[{ throws: "socket hang up" }, "stream_error"],
	];
	const observed: string[] = [];
	for (const [entry, expected] of cases) {
		rmSync(directory, { recursive: true, force: true });
		directory = mkdtempSync(join(tmpdir(), "compaction-diagnostic-records-"));
		sessionFilePath = join(directory, "session.jsonl");
		await planFailure(entry);
		const category = payload(sidecars("compaction-diagnostic")[0]).failureCategory ?? "";
		observed.push(category);
		assert.equal(category, expected);
	}
	assert.equal(new Set(observed).size, 5, `expected five distinct categories, saw ${observed.join(", ")}`);
});

test("two failure sidecars written in the same millisecond both survive", () => {
	const fixed = Date.now();
	const realNow = Date.now;
	Date.now = () => fixed;
	try {
		const paths = [1, 2].map((attempt) =>
			writeDiagnosticSidecar({
				sessionFilePath,
				model: testModel(),
				requestMaxTokens: undefined,
				response: undefined,
				rawResponseText: `attempt ${attempt}`,
				failureCategory: "context_overflow",
				failureMessage: `attempt ${attempt}`,
			}),
		);
		assert.ok(paths[0] && paths[1]);
		assert.notEqual(paths[0], paths[1]);
		// Both original payloads are intact; neither replaced the other.
		assert.equal(JSON.parse(readFileSync(paths[0]!, "utf-8")).rawResponse, "attempt 1");
		assert.equal(JSON.parse(readFileSync(paths[1]!, "utf-8")).rawResponse, "attempt 2");
		assert.equal(sidecars("compaction-diagnostic").length, 2);
	} finally {
		Date.now = realNow;
	}
});

test("repeated overflow trims against one model leave one record each", async () => {
	// Every trimmed attempt overflows, so the ladder writes a sidecar per attempt.
	const stream = scriptedStream({ default: [{ errorMessage: "context_length_exceeded" }] });
	for (let attempt = 0; attempt < 3; attempt++) {
		await planDeletedLineRanges(region(), PARAMETERS, borrowed(testModel(), "high"), 30, {
			streamFn: stream.streamFn,
			sessionFilePath,
		});
	}
	const written = sidecars("compaction-diagnostic");
	assert.equal(written.length, 3);
	for (const file of written) assert.equal(payload(file).failureCategory, "context_overflow");
});

test("recovery and success sidecars are collision-safe too", () => {
	const fixed = Date.now();
	const realNow = Date.now;
	Date.now = () => fixed;
	try {
		const recovery = [1, 2].map((attempt) =>
			writeRecoveryDiagnosticSidecar({
				sessionFilePath,
				model: testModel(),
				requestMaxTokens: undefined,
				response: { stopReason: "length", usage: undefined } as never,
				rawResponseText: `recovery ${attempt}`,
				recoveryCategory: "partial_length_recovery",
				recoveredRangeCount: attempt,
			}),
		);
		assert.notEqual(recovery[0], recovery[1]);
		assert.equal(sidecars("compaction-recovery").length, 2);

		const success = [1, 2].map(() =>
			writeSuccessDiagnosticSidecar({
				sessionFilePath,
				model: testModel(),
				successCategory: "borrowed_planner",
				thinkingLevel: "high",
			}),
		);
		assert.notEqual(success[0], success[1]);
		assert.equal(sidecars("compaction-success").length, 2);
	} finally {
		Date.now = realNow;
	}
});

posixMode("collision-safe sidecars stay owner-only and carry no credentials", async () => {
	await planFailure({ errorMessage: "429 Too Many Requests" });
	const written = sidecars("compaction-diagnostic");
	assert.equal(written.length, 1);
	for (const file of written) {
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const raw = readFileSync(file, "utf-8");
		assert.ok(!raw.includes("apiKey"), `${file} leaked an apiKey field`);
		assert.ok(!raw.includes("headers"), `${file} leaked headers`);
	}
});
