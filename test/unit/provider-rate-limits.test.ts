import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import type { Model } from "@bastani/pi-ai";
import { stream as streamAnthropicMessages } from "@bastani/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	providerCooldownMs,
	providerRateLimitSnapshot,
	providerRetryHint,
	providerUnavailableMs,
	recordProviderRateLimit,
	recordProviderSuccess,
} from "../../packages/coding-agent/src/core/provider-rate-limits.js";
import { admitProviderStream } from "../../packages/coding-agent/src/core/provider-request-admission.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

test("Retry-After accepts seconds and HTTP dates through wrapped failures (#3864)", () => {
	vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
	assert.deepEqual(providerRetryHint({ cause: { status: 429, headers: new Headers({ "Retry-After": "2.5" }) } }), {
		retryAfterMs: 2500,
	});
	assert.deepEqual(providerRetryHint({ headers: new Headers({ "retry-after": "Thu, 22 Oct 2026 12:00:03 GMT" }) }), {
		retryAfterMs: 3000,
	});
	assert.deepEqual(providerRetryHint({ headers: new Headers({ "Retry-After": "not a date" }) }), {});
	assert.deepEqual(providerRetryHint({ retryAfterMs: Number.POSITIVE_INFINITY }), {});
});

test("missing retry hints use bounded exponential jitter, and success resets the backoff (#3864)", () => {
	vi.spyOn(Math, "random").mockReturnValue(0);
	const error = { status: 429 };
	assert.equal(recordProviderRateLimit("jitter", error), 500);
	vi.advanceTimersByTime(500);
	assert.equal(recordProviderRateLimit("jitter", error), 1000);
	vi.spyOn(Math, "random").mockReturnValue(1);
	for (let i = 0; i < 20; i++) {
		vi.advanceTimersByTime(60_000);
		const delay = recordProviderRateLimit("jitter", error);
		assert.ok(delay !== undefined && delay >= 1000 && delay <= 60_000);
	}
	vi.advanceTimersByTime(60_000);
	recordProviderSuccess("jitter");
	assert.equal(recordProviderRateLimit("jitter", error), 1000);
	assert.equal(providerRateLimitSnapshot("jitter")?.rateLimitCount, 23);
	assert.equal(recordProviderRateLimit("ordinary", { status: 500 }), undefined);
	assert.equal(providerRateLimitSnapshot("ordinary"), undefined);
});

test("a later short retry hint never shortens an account's existing cooldown (#3864)", () => {
	recordProviderRateLimit("long-cooldown", { status: 429, retryAfterMs: 120_000 });
	recordProviderRateLimit("long-cooldown", { status: 429, retryAfterMs: 100 });
	assert.equal(providerCooldownMs("long-cooldown"), 120_000);
	assert.deepEqual(Object.keys(providerRateLimitSnapshot("long-cooldown") ?? {}).sort(), [
		"cooldownUntil",
		"provider",
		"rateLimitCount",
	]);
});

test("fractional jittered cooldowns round up to a whole millisecond that a millisecond clock can reach (#3864)", () => {
	vi.spyOn(Math, "random").mockReturnValue(0.0001);
	const jittered = recordProviderRateLimit("fractional", { status: 429 });
	assert.equal(jittered, 501);
	vi.advanceTimersByTime(jittered);
	assert.equal(providerCooldownMs("fractional"), 0);
	const hinted = recordProviderRateLimit("fractional-hint", { status: 429, retryAfterMs: 1500.4 });
	assert.equal(hinted, 1501);
	vi.advanceTimersByTime(hinted);
	assert.equal(providerCooldownMs("fractional-hint"), 0);
});

const anthropicModel: Model<"anthropic-messages"> = {
	id: "limited-claude",
	name: "Limited Claude",
	api: "anthropic-messages",
	provider: "anthropic-hints",
	baseUrl: "https://api.anthropic.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function anthropicFailure(status: number, headers: Record<string, string>, message: string): typeof fetch {
	return Object.assign(
		async () =>
			new Response(JSON.stringify({ type: "error", error: { type: "error", message } }), {
				status,
				headers: { "content-type": "application/json", ...headers },
			}),
		globalThis.fetch,
	);
}

test("an anthropic-messages 429 with Retry-After cools the provider for that long, not a backoff guess", async () => {
	vi.useRealTimers();
	vi.spyOn(Math, "random").mockReturnValue(0);
	const context = normalizeContext({ systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	const result = await streamAnthropicMessages(anthropicModel, context, {
		apiKey: "k",
		maxRetries: 0,
		fetch: anthropicFailure(429, { "retry-after": "7" }, "rate limited"),
	}).result();
	vi.useFakeTimers();
	assert.equal(recordProviderRateLimit("anthropic-hints", result), 7000);
	assert.equal(providerCooldownMs("anthropic-hints"), 7000);
});

test("an exhausted quota marks the account unavailable until its reset without holding back requests", () => {
	vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
	const failure = {
		stopReason: "error",
		errorMessage: "402 Payment Required",
		retryAfterMs: 3 * 60 * 60 * 1000,
	};
	assert.equal(recordProviderRateLimit("quota-account", failure), 3 * 60 * 60 * 1000);
	assert.equal(providerUnavailableMs("quota-account"), 3 * 60 * 60 * 1000);
	assert.equal(providerCooldownMs("quota-account"), 0);
});

test("a limit that names the failing model cools only that model; an unnamed one cools the provider", () => {
	const named = { status: 429, message: "Rate limit reached for model-a on requests per minute", retryAfterMs: 5000 };
	assert.equal(recordProviderRateLimit("scoped", named, "model-a"), 5000);
	assert.equal(providerCooldownMs("scoped", "model-a"), 5000);
	assert.equal(providerCooldownMs("scoped", "model-a-mini"), 0);
	assert.equal(providerCooldownMs("scoped"), 0);
	assert.equal(recordProviderRateLimit("scoped", { status: 429, retryAfterMs: 2000 }, "model-b"), 2000);
	assert.equal(providerCooldownMs("scoped", "model-c"), 2000);
	assert.equal(providerCooldownMs("scoped", "model-a"), 5000);
});

test("HTTP admission scopes a 429 to the model its response body names", async () => {
	const fetcher: typeof fetch = Object.assign(
		async () =>
			new Response(JSON.stringify({ error: { message: "Rate limit exceeded for limited-claude" } }), {
				status: 429,
				headers: { "Retry-After": "9" },
			}),
		globalThis.fetch,
	);
	const admission = await admitProviderStream(anthropicModel, { fetch: fetcher }, false);
	const response = await admission.run(() => admission.options.fetch!("https://example.invalid"));
	assert.equal(response.status, 429);
	assert.equal(providerCooldownMs("anthropic-hints", "limited-claude"), 9000);
	assert.equal(providerCooldownMs("anthropic-hints", "other-claude"), 0);
});
