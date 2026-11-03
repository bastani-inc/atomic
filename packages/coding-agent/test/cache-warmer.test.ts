import assert from "node:assert/strict";
import type { Api, Model, TranscriptContext } from "@bastani/pi-ai";
import { afterEach, describe, it, vi } from "vitest";
import {
	CacheWarmer,
	formatCacheWarmingStatus,
	getCacheWarmingDelayMs,
	isReplayable,
} from "../src/core/cache-warmer.js";
import type { SessionEntry } from "../src/core/session-manager.js";

const model = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 16384,
	promptCache: { short: 300, long: 3600 },
} as Model<Api>;

const context = { messages: [] } as TranscriptContext;

function sessionManager(entries: SessionEntry[] = []) {
	return {
		appendUsage: vi.fn(),
		getBranch: () => entries,
	};
}

describe("cache warming", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("schedules a refresh before TTL expiry and refuses short lifetimes", () => {
		assert.equal(getCacheWarmingDelayMs(60_000), 50_000);
		assert.equal(getCacheWarmingDelayMs(10_000), undefined);
	});

	it("does not replay budget-based Anthropic thinking", () => {
		assert.equal(isReplayable(model, { reasoning: "high" }), false);
		assert.equal(isReplayable(model, undefined), true);
	});

	it("cancel stops an active run under owner cancellation", () => {
		vi.useFakeTimers();
		const warmer = new CacheWarmer({ streamSimple: vi.fn() }, sessionManager(), () => "idle");
		warmer.start({ model, context, options: { cacheRetention: "long" } }, () => true);
		warmer.cancel();
		assert.deepEqual(warmer.status, { state: "inactive", reason: "inactive" });
	});

	it("does not issue refreshes after their safe deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const streamSimple = vi.fn();
		const warmer = new CacheWarmer({ streamSimple }, sessionManager(), () => "idle");
		warmer.start({ model, context, options: { cacheRetention: "short" } }, () => true);

		// A five-minute cache is scheduled for 4m30s and retains 15 seconds of
		// the 30-second expiry margin. Simulate a timer delayed by sleep.
		vi.setSystemTime(285_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		assert.equal(streamSimple.mock.calls.length, 0);
		assert.deepEqual(warmer.status, { state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("rechecks the deadline after an extension decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const streamSimple = vi.fn();
		const warmer = new CacheWarmer(
			{ streamSimple },
			sessionManager(),
			() => "idle",
			async () => {
				await Promise.resolve();
				vi.setSystemTime(285_001);
				return "warm";
			},
		);
		warmer.start({ model, context, options: { cacheRetention: "short" } }, () => true);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		assert.equal(streamSimple.mock.calls.length, 0);
		assert.deepEqual(warmer.status, { state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("sends the warm replay with disableContinuation so it keeps the conversation's thread", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const streamSimple = vi.fn(() => ({
			result: async () => ({ stopReason: "stop", provider: "anthropic", model: model.id, usage: {} }),
		}));
		const warmer = new CacheWarmer(
			{ streamSimple } as unknown as ConstructorParameters<typeof CacheWarmer>[0],
			sessionManager(),
			() => "idle",
			async () => "warm",
		);
		warmer.start({ model, context, options: { cacheRetention: "short", sessionId: "s" } }, () => true);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		// The scheduled refresh time.
		vi.setSystemTime(270_000);
		await internal.refresh(internal.run);
		warmer.cancel();

		assert.equal(streamSimple.mock.calls.length, 1);
		const options = (streamSimple.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
		assert.equal(options.disableContinuation, true);
		assert.equal(options.maxTokens, 1);
		assert.equal(options.sessionId, "s");
	});

	it("formats an inactive status without leaking economics", () => {
		assert.equal(
			formatCacheWarmingStatus({ state: "inactive", reason: "cache warming disabled" }),
			"Inactive (cache warming disabled)",
		);
	});
});
