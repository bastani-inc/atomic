import assert from "node:assert/strict";
import {
	type Api,
	getCacheWarmingDelayMs,
	isCacheWarmingReplayable,
	type Model,
	type TranscriptContext,
} from "@bastani/pi-ai";
import { afterEach, describe, it, vi } from "vitest";
import {
	CacheWarmer,
	formatCacheWarmingStatus,
	formatCacheWarmingUsage,
	getPromptCacheTtlMs,
} from "../src/core/cache-warmer.js";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.js";

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
		vi.unstubAllEnvs();
	});

	it("schedules a refresh before TTL expiry and refuses short lifetimes", () => {
		assert.equal(getCacheWarmingDelayMs(60_000), 50_000);
		assert.equal(getCacheWarmingDelayMs(10_000), undefined);
	});

	it("resolves the cache lifetime from the request, the environment, then the model default", () => {
		vi.stubEnv("PI_CACHE_RETENTION", "");
		const openaiModel = {
			...model,
			id: "gpt-5.4-mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		} as Model<Api>;
		assert.equal(getPromptCacheTtlMs(model, undefined), 3_600_000);
		assert.equal(getPromptCacheTtlMs(openaiModel, undefined), 300_000);
		assert.equal(getPromptCacheTtlMs(model, { cacheRetention: "short" }), 300_000);
		assert.equal(getPromptCacheTtlMs(model, { cacheRetention: "none" }), undefined);
		assert.equal(getPromptCacheTtlMs(model, { env: { PI_CACHE_RETENTION: "short" } }), 300_000);
		assert.equal(getPromptCacheTtlMs(openaiModel, { env: { PI_CACHE_RETENTION: "long" } }), 3_600_000);
		assert.equal(getPromptCacheTtlMs(model, { env: { PI_CACHE_RETENTION: "none" } }), undefined);
		assert.equal(getPromptCacheTtlMs(model, { env: { PI_CACHE_RETENTION: "unknown" } }), 3_600_000);
		assert.equal(
			getPromptCacheTtlMs(model, { cacheRetention: "short", env: { PI_CACHE_RETENTION: "long" } }),
			300_000,
		);
		assert.equal(getPromptCacheTtlMs({ ...model, promptCache: undefined }, undefined), undefined);
	});

	it("does not replay budget-based Anthropic thinking", () => {
		assert.equal(isCacheWarmingReplayable(model, { reasoning: "high" }), false);
		assert.equal(isCacheWarmingReplayable(model, undefined), true);
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

	it("does not start for a request that cannot be replayed safely", () => {
		const warmer = new CacheWarmer({ streamSimple: vi.fn() }, sessionManager(), () => "idle");
		warmer.start({ model, context, options: { cacheRetention: "short", reasoning: "high" } }, () => true);

		assert.deepEqual(warmer.status, { state: "inactive", reason: "request cannot be replayed safely" });
	});

	describe("safety limits", () => {
		function warmingRefreshes() {
			const streamSimple = vi.fn(() => ({
				result: async () => ({ stopReason: "stop", provider: "anthropic", model: model.id, usage: {} }),
			}));
			return {
				streamSimple,
				models: { streamSimple } as unknown as ConstructorParameters<typeof CacheWarmer>[0],
			};
		}

		it("refreshes every 4m30s between runs until the 30-minute idle limit", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const { streamSimple, models } = warmingRefreshes();
			const warmer = new CacheWarmer(
				models,
				sessionManager(),
				() => "idle",
				async () => "warm",
			);
			warmer.start({ model, context, options: { cacheRetention: "short" } }, () => true);
			warmer.onAgentSettled();

			await vi.advanceTimersByTimeAsync(60 * 60_000);

			assert.equal(streamSimple.mock.calls.length, 6);
			assert.deepEqual(warmer.status, { state: "inactive", reason: "30-minute idle safety limit reached" });
		});

		it("refreshes every 4m30s during a run until the one-hour limit", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const { streamSimple, models } = warmingRefreshes();
			const warmer = new CacheWarmer(
				models,
				sessionManager(),
				() => "streaming",
				async () => "warm",
			);
			warmer.start({ model, context, options: { cacheRetention: "short" } }, () => true);

			await vi.advanceTimersByTimeAsync(90 * 60_000);

			assert.equal(streamSimple.mock.calls.length, 13);
			assert.deepEqual(warmer.status, { state: "inactive", reason: "one-hour safety limit reached" });
		});

		it("stops when a run settles after the idle horizon has passed", () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const warmer = new CacheWarmer({ streamSimple: vi.fn() }, sessionManager(), () => "idle");
			warmer.start({ model, context, options: { cacheRetention: "short" } }, () => true);

			vi.setSystemTime(30 * 60_000);
			warmer.onAgentSettled();

			assert.deepEqual(warmer.status, { state: "inactive", reason: "30-minute idle safety limit reached" });
		});

		it("stops at once when a settled run's next refresh falls past the idle horizon", () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const warmer = new CacheWarmer({ streamSimple: vi.fn() }, sessionManager(), () => "idle");
			warmer.start({ model, context, options: { cacheRetention: "long" } }, () => true);

			warmer.onAgentSettled();

			assert.deepEqual(warmer.status, { state: "inactive", reason: "30-minute idle safety limit reached" });
		});
	});

	it("formats an inactive status without leaking economics", () => {
		assert.equal(
			formatCacheWarmingStatus({ state: "inactive", reason: "cache warming disabled" }),
			"Inactive (cache warming disabled)",
		);
	});

	it("formats the total cost of one or more cache warms", async () => {
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 98_024,
			cacheWrite: 0,
			totalTokens: 98_026,
			cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
		};
		const entry = await SessionManager.inMemory().appendUsage(
			"cache_warm",
			model.provider,
			model.id,
			usage,
			"extension override",
		);
		assert.equal(
			formatCacheWarmingUsage(entry.usage.cost.total, entry.note),
			"Cache warmed (extension override): $0.029497",
		);
		assert.equal(formatCacheWarmingUsage(0.013 + 0.0165), "Cache warmed: $0.0295");
		assert.equal(formatCacheWarmingUsage(0.12, ""), "Cache warmed: $0.120");
		assert.equal(formatCacheWarmingUsage(1.5, "manual"), "Cache warmed (manual): $1.500");
		assert.equal(formatCacheWarmingUsage(0.123045), "Cache warmed: $0.123045");
	});
});
