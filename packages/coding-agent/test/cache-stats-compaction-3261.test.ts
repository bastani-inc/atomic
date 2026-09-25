import assert from "node:assert/strict";
import type { AssistantMessage, Usage } from "@bastani/pi-ai/compat";
import { describe, it } from "vitest";
import {
	CACHE_PREFIX_CUSTOM_TYPE,
	type CachePrefixFingerprint,
	computeCachePrefixFingerprint,
	describeCachePrefixDifference,
	reconstructMessageHashes,
} from "../src/core/cache-prefix-fingerprint.ts";
import { collectCacheMisses } from "../src/core/cache-stats.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

const MODEL = { provider: "faux", modelId: "faux-1" };

function basePayload(): Record<string, unknown> {
	return {
		model: "faux-1",
		system: "You are a test assistant.",
		tools: [{ name: "read", description: "read tool", input_schema: {} }],
	};
}

function usage(cacheWrite: number, cacheRead: number): Usage {
	return {
		input: 5,
		output: 5,
		cacheRead,
		cacheWrite,
		totalTokens: 5 + cacheRead + cacheWrite + 5,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(timestamp: number, value: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "faux",
		provider: MODEL.provider,
		model: MODEL.modelId,
		usage: value,
		stopReason: "stop",
		timestamp,
	};
}

function cachePrefixEntry(id: string, parentId: string | null, fingerprint: CachePrefixFingerprint): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		customType: CACHE_PREFIX_CUSTOM_TYPE,
		data: fingerprint,
	};
}

function messageEntry(id: string, parentId: string | null, message: AssistantMessage): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
}

const prices = { getModel: () => ({ cost: { cacheRead: 0 } }) };

describe("issue #3261: cache-prefix attribution across a compaction boundary", () => {
	it("does not widen miss detection for the request immediately after compaction (matches the pre-#3261 suppression)", () => {
		const fingerprintA = computeCachePrefixFingerprint(basePayload(), MODEL);
		const fingerprintB = computeCachePrefixFingerprint(basePayload(), MODEL);
		const entries: SessionEntry[] = [
			cachePrefixEntry("cp-a", null, fingerprintA),
			messageEntry("m-a", "cp-a", assistant(0, usage(30_000, 0))),
			{
				type: "compaction",
				id: "compaction-1",
				parentId: "m-a",
				timestamp: new Date(1).toISOString(),
				summary: "compacted",
				firstKeptEntryId: null,
				tokensBefore: 30_000,
			},
			cachePrefixEntry("cp-b", "compaction-1", fingerprintB),
			messageEntry("m-b", "cp-b", assistant(2, usage(40_000, 0))),
		];
		const misses = collectCacheMisses(entries, prices);
		assert.equal(misses.size, 0, "compaction is an expected miss cause and stays suppressed, unchanged by #3261");
	});

	it("still computes an exact, correct diff across the compaction boundary when compared directly (not economically gated)", () => {
		// sdk.ts resets its baseline to empty right after a compaction/branch_summary
		// boundary, so the post-compaction fingerprint's own delta is a full snapshot —
		// verified here by computing it with no previous baseline, matching that reset.
		const preCompactionMessages = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: `line ${i}` }));
		const preCompaction = computeCachePrefixFingerprint({ ...basePayload(), messages: preCompactionMessages }, MODEL);
		const preCompactionHashes = reconstructMessageHashes(preCompaction, []);

		const postCompactionMessages = [{ role: "user", content: "compacted summary" }];
		const postCompaction = computeCachePrefixFingerprint(
			{ ...basePayload(), messages: postCompactionMessages },
			MODEL,
		);

		const label = describeCachePrefixDifference(preCompaction, preCompactionHashes, postCompaction);
		assert.equal(
			label,
			"message 1 rewritten",
			"the diff machinery scan()/collectCacheMisses rely on must resolve an exact position across the boundary, not 'prefix unchanged'",
		);
		assert.notEqual(label, "prefix unchanged");
	});
});
