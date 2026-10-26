import "../helpers/provider-rate-limit-isolation.js";
import assert from "node:assert/strict";
import type { AssistantMessage, Model } from "@bastani/pi-ai";
import { stream as streamAnthropicMessages } from "@bastani/pi-ai/api/anthropic-messages";
import { normalizeContext } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	applyProviderRateLimitObservation,
	observeProviderRateLimits,
	type ProviderRateLimitObservation,
	providerCooldownMs,
	providerRateLimitObservations,
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

test("an anthropic-messages 429 with Retry-After cools the provider for that long, not a backoff guess (#3984)", async () => {
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

test("an exhausted quota marks the account unavailable until its reset without holding back requests (#3984)", () => {
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

test("a limit that names the failing model cools only that model; an unnamed one cools the provider (#3984)", () => {
	const named = { status: 429, message: "Rate limit reached for model-a on requests per minute", retryAfterMs: 5000 };
	assert.equal(recordProviderRateLimit("scoped", named, "model-a"), 5000);
	assert.equal(providerCooldownMs("scoped", "model-a"), 5000);
	assert.equal(providerCooldownMs("scoped", "model-a-mini"), 0);
	assert.equal(providerCooldownMs("scoped"), 0);
	assert.equal(recordProviderRateLimit("scoped", { status: 429, retryAfterMs: 2000 }, "model-b"), 2000);
	assert.equal(providerCooldownMs("scoped", "model-c"), 2000);
	assert.equal(providerCooldownMs("scoped", "model-a"), 5000);
});

test("HTTP admission scopes a 429 to the model its response body names (#3984)", async () => {
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

function assistantFailure(errorMessage: string, retryAfterMs?: number): AssistantMessage {
	return {
		role: "assistant",
		api: anthropicModel.api,
		provider: anthropicModel.provider,
		model: anthropicModel.id,
		content: [],
		stopReason: "error",
		errorMessage,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

test("HTTP admission reads the retry hint from a headerless 402 body (#3984)", async () => {
	const threeHours = 3 * 60 * 60 * 1000;
	const fetcher: typeof fetch = Object.assign(
		async () =>
			new Response(JSON.stringify({ error: { message: "quota spent" }, retry_after: threeHours / 1000 }), {
				status: 402,
			}),
		globalThis.fetch,
	);
	const model = { ...anthropicModel, provider: "headerless-quota" };
	const admission = await admitProviderStream(model, { fetch: fetcher }, false);
	const response = await admission.run(() => admission.options.fetch!("https://example.invalid"));
	assert.equal(response.status, 402);
	assert.equal(providerUnavailableMs("headerless-quota"), threeHours);
	assert.equal(providerRateLimitSnapshot("headerless-quota")?.rateLimitCount, 1);
});

test("a later retry hint for an already observed failure extends its cooldown without counting it twice (#3984)", async () => {
	vi.spyOn(Math, "random").mockReturnValue(0);
	const fetcher: typeof fetch = Object.assign(async () => new Response("{}", { status: 429 }), globalThis.fetch);
	const model = { ...anthropicModel, provider: "late-hint" };
	const admission = await admitProviderStream(model, { fetch: fetcher }, false);
	await admission.run(() => admission.options.fetch!("https://example.invalid"));
	assert.equal(providerCooldownMs("late-hint"), 500);
	const failure = assistantFailure("429 Too Many Requests", 45_000);
	admission.observeFailure(failure);
	assert.equal(providerCooldownMs("late-hint"), 45_000);
	assert.equal(recordProviderRateLimit("late-hint", failure, model.id), 45_000);
	assert.equal(providerRateLimitSnapshot("late-hint")?.rateLimitCount, 1);
});

test("a late retry hint keeps the model scope its response was recorded with after that cooldown ends (#3984)", async () => {
	const fetcher: typeof fetch = Object.assign(
		async () =>
			new Response(JSON.stringify({ error: { message: "Rate limit exceeded for limited-claude" } }), {
				status: 429,
				headers: { "Retry-After": "1" },
			}),
		globalThis.fetch,
	);
	const model = { ...anthropicModel, provider: "late-scoped" };
	const admission = await admitProviderStream(model, { fetch: fetcher }, false);
	await admission.run(() => admission.options.fetch!("https://example.invalid"));
	assert.equal(providerCooldownMs("late-scoped", "limited-claude"), 1000);
	assert.equal(providerCooldownMs("late-scoped", "other-claude"), 0);
	vi.advanceTimersByTime(1100);
	const failure = assistantFailure("429 Too Many Requests", 1000);
	admission.observeFailure(failure);
	assert.equal(providerCooldownMs("late-scoped", "other-claude"), 0);
	assert.equal(providerCooldownMs("late-scoped", "limited-claude"), 1000);
	recordProviderRateLimit("late-scoped", failure, model.id);
	assert.equal(providerCooldownMs("late-scoped", "other-claude"), 0);
	assert.equal(providerRateLimitSnapshot("late-scoped")?.rateLimitCount, 1);
});

test("a remote limit merges by its later end, keeps its model scope, and counts no failure (#4023)", () => {
	vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
	const now = Date.now();
	recordProviderRateLimit("shared", { status: 429, retryAfterMs: 10_000, message: "Rate limit reached for m1" }, "m1");
	assert.equal(
		applyProviderRateLimitObservation({
			provider: "shared",
			model: "m1",
			kind: "cooldown",
			untilEpochMs: now + 30_000,
		}),
		true,
	);
	assert.equal(providerCooldownMs("shared", "m1"), 30_000);
	assert.equal(providerCooldownMs("shared", "m2"), 0);
	assert.equal(providerCooldownMs("shared"), 0);
	// An earlier end never shortens the limit.
	assert.equal(
		applyProviderRateLimitObservation({
			provider: "shared",
			model: "m1",
			kind: "cooldown",
			untilEpochMs: now + 5_000,
		}),
		false,
	);
	assert.equal(providerCooldownMs("shared", "m1"), 30_000);
	assert.equal(
		applyProviderRateLimitObservation({ provider: "shared", kind: "unavailable", untilEpochMs: now + 3_600_000 }),
		true,
	);
	assert.equal(providerUnavailableMs("shared", "m2"), 3_600_000);
	assert.equal(providerCooldownMs("shared", "m2"), 0);
	assert.equal(providerRateLimitSnapshot("shared")?.rateLimitCount, 1);
	// The local backoff did not grow: the next local limit without a hint backs off from the first step.
	vi.spyOn(Math, "random").mockReturnValue(0);
	assert.equal(recordProviderRateLimit("shared", { status: 429 }), 500);
});

test("an expired remote limit is ignored and the current limits list only those still running (#4023)", () => {
	vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
	const now = Date.now();
	assert.equal(applyProviderRateLimitObservation({ provider: "late", kind: "cooldown", untilEpochMs: now }), false);
	assert.equal(
		applyProviderRateLimitObservation({ provider: "late", kind: "cooldown", untilEpochMs: now - 1 }),
		false,
	);
	assert.equal(providerCooldownMs("late"), 0);
	applyProviderRateLimitObservation({ provider: "listed", model: "m/1", kind: "cooldown", untilEpochMs: now + 1_000 });
	applyProviderRateLimitObservation({ provider: "listed", kind: "unavailable", untilEpochMs: now + 5_000 });
	assert.deepEqual(providerRateLimitObservations(), [
		{ provider: "listed", model: "m/1", kind: "cooldown", untilEpochMs: now + 1_000 },
		{ provider: "listed", kind: "unavailable", untilEpochMs: now + 5_000 },
	]);
	vi.advanceTimersByTime(1_000);
	assert.deepEqual(providerRateLimitObservations(), [
		{ provider: "listed", kind: "unavailable", untilEpochMs: now + 5_000 },
	]);
});

test("observers hear limits this process records or extends, not remote ones it applies (#4023)", () => {
	vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
	const now = Date.now();
	const heard: ProviderRateLimitObservation[] = [];
	const stop = observeProviderRateLimits((observation) => heard.push(observation));
	try {
		recordProviderRateLimit(
			"heard",
			{ status: 429, retryAfterMs: 30_000, message: "Rate limit reached for m1" },
			"m1",
		);
		recordProviderRateLimit(
			"heard",
			{ status: 429, retryAfterMs: 1_000, message: "Rate limit reached for m1" },
			"m1",
		);
		recordProviderRateLimit("heard", { status: 402, retryAfterMs: 60_000 });
		applyProviderRateLimitObservation({ provider: "heard", kind: "cooldown", untilEpochMs: now + 90_000 });
		recordProviderRateLimit("ordinary", { status: 500 });
	} finally {
		stop();
	}
	recordProviderRateLimit("heard", { status: 429, retryAfterMs: 120_000 });
	assert.deepEqual(heard, [
		{ provider: "heard", model: "m1", kind: "cooldown", untilEpochMs: now + 30_000 },
		{ provider: "heard", kind: "unavailable", untilEpochMs: now + 60_000 },
	]);
});

test("a throwing limit observer changes no request handling and does not block other observers (#4023)", async () => {
	vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
	const now = Date.now();
	const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
	const heard: ProviderRateLimitObservation[] = [];
	const stopThrowing = observeProviderRateLimits(() => {
		throw new Error("observer failed");
	});
	const stopHeard = observeProviderRateLimits((observation) => heard.push(observation));
	try {
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
		assert.equal(recordProviderRateLimit("observed-quota", { status: 402, retryAfterMs: 60_000 }), 60_000);
	} finally {
		stopThrowing();
		stopHeard();
	}
	assert.equal(providerCooldownMs("anthropic-hints", "limited-claude"), 9000);
	assert.equal(providerUnavailableMs("observed-quota"), 60_000);
	assert.deepEqual(heard, [
		{ provider: "anthropic-hints", model: "limited-claude", kind: "cooldown", untilEpochMs: now + 9000 },
		{ provider: "observed-quota", kind: "unavailable", untilEpochMs: now + 60_000 },
	]);
	assert.equal(debug.mock.calls.length, 1);
});
