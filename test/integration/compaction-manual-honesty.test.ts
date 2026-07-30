/**
 * RFC §8 — Integration: manual honesty on a *persisted* session.
 *
 * A recoverable `/compact` that exhausts every configured model must write no
 * boundary, must surface the real diagnostic sidecar path through
 * `compaction_end`, and must leave the session usable. An in-memory session
 * cannot prove the diagnostic half, so this one is written to disk.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { MIN_COMPACTABLE_REGION_LINES } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { createRungSession, plannerScript } from "./compaction-rung-session.js";

const THROTTLED = { errorMessage: "429 Too Many Requests" };

function diagnostics(directory: string): string[] {
	return readdirSync(directory)
		.filter((name) => name.includes("compaction-diagnostic"))
		.map((name) => join(directory, name));
}

test("manual compaction with every model rate limited reports a real diagnostic path", async () => {
	const directory = mkdtempSync(join(tmpdir(), "compaction-manual-honesty-"));
	const { streamFn, calls } = plannerScript({ anthropic: [THROTTLED], openai: [THROTTLED] });
	const built = await createRungSession({
		streamFn,
		fallbackModels: ["openai/gpt-5.1"],
		sessionDir: directory,
	});
	try {
		await assert.rejects(() => built.session.compact({ preserve_recent: 2 }), /429 Too Many Requests/);

		// Recoverable: every configured model was tried once, and nothing was written.
		assert.deepEqual(
			calls.map((call) => call.provider),
			["anthropic", "openai"],
		);
		assert.deepEqual(
			built.manager.getBranch().filter((entry) => entry.type === "compaction"),
			[],
		);

		const ends = built.events.filter((event) => event.type === "compaction_end") as Array<{
			result?: { rung?: string };
			errorMessage?: string;
			aborted: boolean;
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].result, undefined);
		assert.equal(ends[0].aborted, false);
		// No fresh rung, and no fresh notice: /compact fails honestly.
		assert.ok(!(ends[0].errorMessage ?? "").includes("cleared"));

		// The reported path exists and records the typed cause.
		const written = diagnostics(directory);
		assert.ok(written.length >= 1, "no diagnostic sidecar was written");
		const reported = written.find((path) => (ends[0].errorMessage ?? "").includes(path));
		assert.ok(reported, `compaction_end did not name a written sidecar: ${ends[0].errorMessage}`);
		const payload = JSON.parse(readFileSync(reported, "utf-8")) as {
			failureCategory: string;
			rateLimitExhausted?: boolean;
			model: { provider: string };
		};
		assert.equal(payload.failureCategory, "rate_limited");
		// Retry is disabled in this fixture, so no backoff budget was spent.
		assert.equal(payload.rateLimitExhausted, false);

		// Still usable: a later attempt runs and succeeds.
		const rescued = plannerScript({ default: [{ text: "3,9\n" }] });
		built.agent.streamFunction = rescued.streamFn;
		const result = await built.session.compact({ preserve_recent: 2 });
		assert.equal(result.rung, "planned");
	} finally {
		built.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("an over-limit post-tool context with a tiny region persists a fresh boundary", async () => {
	// Two seeded turns leave fewer than the planner minimum of compactable lines,
	// while the reported usage puts the whole context past the hard input limit.
	const { streamFn, calls } = plannerScript({ default: [{ text: "1,2\n" }] });
	const built = await createRungSession({
		streamFn,
		turns: 2,
		contextWindow: 4_000,
		reserveTokens: 3_999,
		usageTokens: 40_000,
	});
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

		const boundary = built.manager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(boundary, "no boundary was persisted for the small load-bearing region");
		const details = (boundary as { details?: VerbatimCompactionDetails }).details;
		assert.equal(details?.rung, "fresh");
		// A region this small cannot be made rankable by changing models.
		assert.ok(
			(boundary as { details?: VerbatimCompactionDetails }).details!.stats.linesBefore <
				MIN_COMPACTABLE_REGION_LINES,
			"the seeded region was not below the planner minimum",
		);
		assert.equal(calls.length, 0);

		// The final gate accepts the rebuilt context, so the follow-up request is sent.
		assert.ok(Array.isArray(finish(rebuilt)));
		assert.equal(built.continueCalls(), 0);
	} finally {
		built.dispose();
	}
});

test("a fitting post-tool threshold crossing with a tiny region is a safe no-op", async () => {
	// The threshold sits far below the hard limit, so this context still fits.
	// Clearing a sub-minimum region here would destroy conversation for nothing;
	// the follow-up provider request can be sent unchanged.
	const { streamFn, calls } = plannerScript({ default: [{ text: "1,2\n" }] });
	const built = await createRungSession({
		streamFn,
		turns: 2,
		contextWindow: 1_000_000,
		reserveTokens: 960_000,
		usageTokens: 45_000,
	});
	try {
		const preflight = (
			built.session as unknown as {
				_preflightPostToolContext: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]>;
			}
		)._preflightPostToolContext.bind(built.session);

		const before = built.agent.state.messages;
		const rebuilt = await preflight(before);

		// No throw, no boundary, no planner call, and the context is untouched.
		assert.equal(rebuilt, before);
		assert.deepEqual(
			built.manager.getBranch().filter((entry) => entry.type === "compaction"),
			[],
		);
		assert.equal(calls.length, 0);
		assert.equal(built.continueCalls(), 0);

		const ends = built.events.filter((event) => event.type === "compaction_end") as Array<{
			errorMessage?: string;
			result?: unknown;
			midTurn?: boolean;
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].errorMessage, undefined);
		assert.equal(ends[0].result, undefined);
		assert.equal(ends[0].midTurn, true);
	} finally {
		built.dispose();
	}
});

test("an over-hard-limit post-tool crossing with a tiny region reaches fresh", async () => {
	const { streamFn, calls } = plannerScript({ default: [{ text: "1,2\n" }] });
	const built = await createRungSession({
		streamFn,
		turns: 2,
		contextWindow: 4_000,
		reserveTokens: 3_999,
		usageTokens: 40_000,
	});
	try {
		const preflight = (
			built.session as unknown as {
				_preflightPostToolContext: (messages: unknown[], signal?: AbortSignal) => Promise<unknown[]>;
			}
		)._preflightPostToolContext.bind(built.session);

		await preflight(built.agent.state.messages);

		const boundary = built.manager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(boundary, "no boundary was persisted for the over-limit small region");
		assert.equal((boundary as { details?: VerbatimCompactionDetails }).details?.rung, "fresh");
		// A region this small cannot be made rankable by changing models.
		assert.equal(calls.length, 0);
		assert.equal(built.continueCalls(), 0);
	} finally {
		built.dispose();
	}
});

test("real overflow recovery keeps fresh reachable for a tiny region", async () => {
	const { streamFn, calls } = plannerScript({ default: [{ text: "1,2\n" }] });
	const built = await createRungSession({ streamFn, turns: 2, contextWindow: 1_000_000 });
	try {
		const runAutoCompaction = (
			built.session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			}
		)._runAutoCompaction.bind(built.session);
		await runAutoCompaction("overflow", false);

		const boundary = built.manager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(boundary, "overflow recovery persisted no boundary");
		assert.equal((boundary as { details?: VerbatimCompactionDetails }).details?.rung, "fresh");
		assert.equal(calls.length, 0);
	} finally {
		built.dispose();
	}
});

test("a small recoverable region is still refused, never cleared", async () => {
	const { streamFn, calls } = plannerScript({ default: [{ text: "1,2\n" }] });
	const built = await createRungSession({ streamFn, turns: 2 });
	try {
		const apply = (
			built.session as unknown as {
				_applyVerbatimCompaction: (options: Record<string, unknown>) => Promise<unknown>;
			}
		)._applyVerbatimCompaction.bind(built.session);

		const result = await apply({
			resolvePlannerAuth: async () => ({ apiKey: "anthropic-key" }),
			abortController: new AbortController(),
			backupLabel: "compact",
			reason: "manual",
			urgency: "recoverable",
		});

		assert.equal(result, undefined);
		assert.deepEqual(
			built.manager.getBranch().filter((entry) => entry.type === "compaction"),
			[],
		);
		assert.equal(calls.length, 0);
	} finally {
		built.dispose();
	}
});

test("a caller cannot inject load_bearing urgency through the public compact door", async () => {
	// `session.compact()` projects only compaction parameters, so a widened or
	// cast object cannot smuggle urgency in and reach the destructive rung.
	const { streamFn, calls } = plannerScript({ anthropic: [THROTTLED] });
	const built = await createRungSession({ streamFn });
	try {
		const injected = { preserve_recent: 2, urgency: "load_bearing" } as unknown as { preserve_recent: number };
		await assert.rejects(() => built.session.compact(injected), /429 Too Many Requests/);

		assert.deepEqual(
			built.manager.getBranch().filter((entry) => entry.type === "compaction"),
			[],
		);
		assert.equal(calls.length, 1);
		assert.equal(built.continueCalls(), 0);

		const ends = built.events.filter((event) => event.type === "compaction_end") as Array<{
			result?: { rung?: string };
		}>;
		assert.equal(ends.length, 1);
		assert.equal(ends[0].result, undefined);
	} finally {
		built.dispose();
	}
});
