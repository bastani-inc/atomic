/**
 * RFC §8 — Integration: manual honesty on a *persisted* session.
 *
 * A recoverable `/compact` that exhausts every configured model must write no
 * boundary, must surface the real diagnostic sidecar path through
 * `compaction_end`, and must leave the session usable. An in-memory session
 * cannot prove the diagnostic half, so this one is written to disk.
 */

import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_COMPACTABLE_REGION_LINES } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import type { VerbatimCompactionDetails } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
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
	const built = createRungSession({
		streamFn,
		fallbackModels: ["openai/gpt-5.1"],
		sessionDir: directory,
	});
	try {
		await assert.rejects(() => built.session.compact({ preserve_recent: 2 }), /429 Too Many Requests/);

		// Recoverable: every configured model was tried once, and nothing was written.
		assert.deepEqual(calls.map((call) => call.provider), ["anthropic", "openai"]);
		assert.deepEqual(built.manager.getBranch().filter((entry) => entry.type === "compaction"), []);

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
	const built = createRungSession({
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
			(boundary as { details?: VerbatimCompactionDetails }).details!.stats.linesBefore < MIN_COMPACTABLE_REGION_LINES,
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

test("a small load-bearing region reaches fresh even when the context fits", async () => {
	// The threshold can fire far below the provider hard limit. A load-bearing
	// caller must still reach a terminal rung: refusing here is what left the
	// mid-turn preflight with nothing to do and killed the active turn.
	const { streamFn, calls } = plannerScript({ default: [{ text: "1,2\n" }] });
	const built = createRungSession({
		streamFn,
		turns: 2,
		contextWindow: 1_000_000,
		reserveTokens: 960_000,
		usageTokens: 45_000,
	});
	try {
		const apply = (
			built.session as unknown as {
				_applyVerbatimCompaction: (options: Record<string, unknown>) => Promise<{ rung?: string } | undefined>;
			}
		)._applyVerbatimCompaction.bind(built.session);

		const result = await apply({
			resolvePlannerAuth: async () => ({ apiKey: "anthropic-key" }),
			abortController: new AbortController(),
			backupLabel: "auto-compact",
			reason: "threshold",
			urgency: "load_bearing",
		});

		assert.equal(result?.rung, "fresh");
		// A region this small cannot be made rankable by changing models.
		assert.equal(calls.length, 0);
		const boundary = built.manager.getBranch().find((entry) => entry.type === "compaction");
		assert.ok(boundary, "no boundary was persisted for the small load-bearing region");
		assert.equal((boundary as { details?: VerbatimCompactionDetails }).details?.rung, "fresh");
	} finally {
		built.dispose();
	}
});

test("a small recoverable region is still refused, never cleared", async () => {
	const { streamFn, calls } = plannerScript({ default: [{ text: "1,2\n" }] });
	const built = createRungSession({ streamFn, turns: 2 });
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
		assert.deepEqual(built.manager.getBranch().filter((entry) => entry.type === "compaction"), []);
		assert.equal(calls.length, 0);
	} finally {
		built.dispose();
	}
});
