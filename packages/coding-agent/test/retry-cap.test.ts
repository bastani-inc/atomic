import assert from "node:assert/strict";
import { test } from "vitest";
import { nextRetryDecision } from "../src/core/retry-policy.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

test("shared main-chat and workflow retry policy caps backoff (#8826)", () => {
	const defaults = SettingsManager.inMemory().getRetrySettings();
	assert.equal(defaults.maxAgentDelayMs, 60_000);
	assert.equal(nextRetryDecision({ ...defaults, maxRetries: 2000 }, 1024, true)?.delayMs, 60_000);
	for (const cap of [0, 5]) {
		const settings = SettingsManager.inMemory({ retry: { maxRetries: 10, maxAgentDelayMs: cap } });
		assert.equal(nextRetryDecision(settings.getRetrySettings(), 4, true)?.delayMs, cap);
		assert.equal(settings.getProviderRetrySettings().maxRetryDelayMs, 60_000);
	}
});

test("legacy retry.maxDelayMs remains a provider limit, independent of the agent cap", () => {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ retry: { maxDelayMs: 1234 } }));
	const settings = SettingsManager.fromStorage(storage);
	assert.equal(settings.getRetrySettings().maxAgentDelayMs, 60_000);
	assert.equal(settings.getProviderRetrySettings().maxRetryDelayMs, 1234);
});

test("transient retries use the configured time budget and server hint beyond maxRetries (#3623)", () => {
	const manager = SettingsManager.inMemory({ retry: { maxRetryTimeMs: 5000, provider: { maxRetryDelayMs: 3000 } } });
	const settings = manager.getRetrySettings();
	assert.equal(settings.maxRetryTimeMs, 5000);
	assert.equal(SettingsManager.inMemory().getRetrySettings().maxRetryTimeMs, 300_000);
	const message = { stopReason: "error", errorMessage: "522 unavailable", retryAfterMs: 60_000 } as const;
	const delayMs = nextRetryDecision(settings, 8, true, { message, elapsedMs: 1000 })?.delayMs ?? -1;
	assert.ok(delayMs >= 3000 && delayMs <= 4000, `hint floor and remaining budget bound the delay: ${delayMs}`);
	assert.equal(nextRetryDecision(settings, 8, true, { message, elapsedMs: 5000 }), undefined);
});

test("session-only retryable failures keep the maxRetries limit (#3623)", () => {
	const settings = SettingsManager.inMemory().getRetrySettings();
	const message = { stopReason: "error", errorMessage: "I'm sorry, but I cannot assist with that request." } as const;
	assert.equal(nextRetryDecision(settings, 0, true, { message, elapsedMs: 0 })?.delayMs, 2000);
	assert.equal(nextRetryDecision(settings, 3, true, { message, elapsedMs: 0 }), undefined);
});
