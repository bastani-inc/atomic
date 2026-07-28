/**
 * RFC §8 — Integration: the rung ladder end to end through a real AgentSession.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import type { CompactionEntry } from "../../packages/coding-agent/src/core/session-manager.js";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { createRungSession, plannerScript } from "./compaction-rung-session.js";

const THROTTLED = { errorMessage: "429 Too Many Requests" };

function boundary(manager: { getBranch(): Array<{ type: string }> }): CompactionEntry<VerbatimCompactionDetails> | undefined {
	return manager.getBranch().find((entry) => entry.type === "compaction") as
		| CompactionEntry<VerbatimCompactionDetails>
		| undefined;
}

test("rate-limit rescue: a healthy fallback keeps the boundary at rung planned and the UI quiet", async () => {
	const { streamFn, calls } = plannerScript({ anthropic: [THROTTLED], openai: [{ text: "3,9\n" }] });
	const built = createRungSession({ streamFn, fallbackModels: ["openai/gpt-5.1"] });
	try {
		const sessionModelBefore = built.session.model;
		const result = await built.session.compact({ preserve_recent: 2 });

		assert.equal(result.rung, "planned");
		assert.deepEqual(result.plannerModel, { provider: "openai", id: "gpt-5.1", thinkingLevel: "high" });
		assert.deepEqual(calls.map((call) => call.provider), ["anthropic", "openai"]);

		const entry = boundary(built.manager);
		assert.ok(entry);
		assert.equal(entry.details!.rung, "planned");
		assert.deepEqual(entry.details!.plannerModel, { provider: "openai", id: "gpt-5.1", thinkingLevel: "high" });
		assert.equal(built.session.model, sessionModelBefore);

		const ends = built.events.filter((event) => event.type === "compaction_end");
		assert.equal(ends.length, 1);
		assert.equal((ends[0] as { errorMessage?: string }).errorMessage, undefined);
		assert.deepEqual(
			(ends[0] as { result?: { plannerModel?: unknown } }).result?.plannerModel,
			{ provider: "openai", id: "gpt-5.1", thinkingLevel: "high" },
		);
		assert.equal(built.continueCalls(), 0);
	} finally {
		built.dispose();
	}
});

test("starvation rescue: exactly two planner requests, both at the inherited reasoning level", async () => {
	const { streamFn, calls } = plannerScript({
		anthropic: [{ text: "", stopReason: "length", reasoningTokens: 4096 }],
		openai: [{ text: "3,9\n" }],
	});
	const built = createRungSession({ streamFn, fallbackModels: ["openai/gpt-5.1"], thinkingLevel: "high" });
	try {
		const result = await built.session.compact({ preserve_recent: 2 });
		assert.equal(result.rung, "planned");
		assert.equal(calls.length, 2);
		assert.deepEqual(calls.map((call) => call.reasoning), ["high", "high"]);
		assert.equal(built.session.thinkingLevel, "high");
	} finally {
		built.dispose();
	}
});

test("overflow trimming retries the same model on a smaller region before advancing", async () => {
	// The session model overflows once, then succeeds on the trimmed region.
	const { streamFn, calls } = plannerScript({
		anthropic: [{ errorMessage: "prompt is too long: context_length_exceeded" }, { text: "1,4\n" }],
	});
	const built = createRungSession({ streamFn });
	try {
		const result = await built.session.compact({ preserve_recent: 2 });
		assert.equal(result.rung, "planned");
		assert.equal(result.plannerModel, undefined);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].provider, "anthropic");
		assert.equal(calls[1].provider, "anthropic");
		// The retry showed the planner strictly fewer numbered lines.
		assert.ok(calls[1].regionLines < calls[0].regionLines, `${calls[1].regionLines} < ${calls[0].regionLines}`);
	} finally {
		built.dispose();
	}
});

test("overflow trimming that cannot fix the region advances to a fallback model", async () => {
	const { streamFn, calls } = plannerScript({
		anthropic: [{ errorMessage: "prompt is too long: context_length_exceeded" }],
		openai: [{ text: "3,9\n" }],
	});
	const built = createRungSession({ streamFn, fallbackModels: ["openai/gpt-5.1"] });
	try {
		const result = await built.session.compact({ preserve_recent: 2 });
		assert.equal(result.rung, "planned");
		assert.deepEqual(result.plannerModel, { provider: "openai", id: "gpt-5.1", thinkingLevel: "high" });
		// One initial attempt plus the bounded trim retries, then exactly one borrow.
		assert.equal(calls.filter((call) => call.provider === "anthropic").length, 4);
		assert.equal(calls.filter((call) => call.provider === "openai").length, 1);
	} finally {
		built.dispose();
	}
});

test("manual honesty: every model rate limited writes no boundary and leaves the session usable", async () => {
	const { streamFn, calls } = plannerScript({ anthropic: [THROTTLED], openai: [THROTTLED] });
	const built = createRungSession({ streamFn, fallbackModels: ["openai/gpt-5.1"] });
	try {
		await assert.rejects(() => built.session.compact({ preserve_recent: 2 }), /429 Too Many Requests/);
		assert.deepEqual(calls.map((call) => call.provider), ["anthropic", "openai"]);
		assert.equal(boundary(built.manager), undefined);

		const ends = built.events.filter((event) => event.type === "compaction_end") as Array<{
			result?: unknown;
			errorMessage?: string;
			aborted: boolean;
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].result, undefined);
		assert.equal(ends[0].aborted, false);
		assert.match(ends[0].errorMessage ?? "", /Compaction failed/);

		// Still usable: a second attempt runs and can succeed.
		const rescued = plannerScript({ default: [{ text: "3,9\n" }] });
		built.agent.streamFunction = rescued.streamFn;
		const result = await built.session.compact({ preserve_recent: 2 });
		assert.equal(result.rung, "planned");
	} finally {
		built.dispose();
	}
});

test("threshold auto-compaction is recoverable and cannot clear context", async () => {
	const { streamFn } = plannerScript({ anthropic: [THROTTLED] });
	const built = createRungSession({ streamFn });
	try {
		const runAutoCompaction = (
			built.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(built.session);
		await runAutoCompaction("threshold", false);

		assert.equal(boundary(built.manager), undefined);
		const ends = built.events.filter((event) => event.type === "compaction_end") as Array<{ errorMessage?: string }>;
		assert.match(ends[0]?.errorMessage ?? "", /Auto-compaction failed/);
	} finally {
		built.dispose();
	}
});

test("overflow recovery is load-bearing and completes on the fresh rung when every model fails", async () => {
	const { streamFn } = plannerScript({ anthropic: [THROTTLED], openai: [THROTTLED] });
	const built = createRungSession({ streamFn, fallbackModels: ["openai/gpt-5.1"] });
	try {
		const runAutoCompaction = (
			built.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(built.session);
		await runAutoCompaction("overflow", false);

		const entry = boundary(built.manager);
		assert.ok(entry);
		assert.equal(entry.details!.rung, "fresh");
		assert.equal(entry.details!.plannerModel, undefined);

		const ends = built.events.filter((event) => event.type === "compaction_end") as Array<{
			result?: { rung?: string };
			errorMessage?: string;
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].errorMessage, undefined);
		assert.equal(ends[0].result?.rung, "fresh");
	} finally {
		built.dispose();
	}
});

test("post-tool preflight is load-bearing: it completes without scheduling a continuation", async () => {
	const { streamFn } = plannerScript({ anthropic: [THROTTLED] });
	const built = createRungSession({ streamFn, contextWindow: 4_000, reserveTokens: 3_999, turns: 12 });
	try {
		const preflight = (
			built.session as unknown as {
				_preflightPostToolContext: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]>;
			}
		)._preflightPostToolContext.bind(built.session);
		const finish = (
			built.session as unknown as { _finishPostToolCompactionPreflight: (messages: unknown[]) => unknown[] }
		)._finishPostToolCompactionPreflight.bind(built.session);

		const rebuilt = await preflight(built.agent.state.messages);
		const entry = boundary(built.manager);
		assert.ok(entry);
		assert.equal(entry.details!.rung, "fresh");

		// The gate accepts the rebuilt context, so the follow-up request is sent.
		const gated = finish(rebuilt);
		assert.ok(Array.isArray(gated));
		assert.equal(built.continueCalls(), 0);

		const ends = built.events.filter((event) => event.type === "compaction_end") as Array<{
			midTurn?: boolean;
			result?: { rung?: string };
			errorMessage?: string;
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].midTurn, true);
		assert.equal(ends[0].errorMessage, undefined);
		assert.equal(ends[0].result?.rung, "fresh");
	} finally {
		built.dispose();
	}
});
