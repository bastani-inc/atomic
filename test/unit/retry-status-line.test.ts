import assert from "node:assert/strict";
import { test } from "vitest";
import {
	retryReason,
	retrySecondsLeft,
	retryWaitFromEvent,
	retryWaitMessage,
	retryWaitText,
} from "../../packages/coding-agent/src/modes/interactive/components/retry-status-line.ts";

test.each([
	["Provider stream timed out after 300000ms without a new event (stream deadline exceeded)", "response timed out"],
	["Request timed out after 60000ms", "response timed out"],
	["504 Gateway Timeout", "response timed out"],
	["connect ETIMEDOUT 104.18.0.1:443", "connection timed out"],
	["429 Too Many Requests", "rate limited"],
	['429 {"error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}', "rate limited"],
	['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
	["The model is at capacity, try again later", "overloaded"],
	["503 Service Unavailable", "server error 503"],
	["502 Bad Gateway", "server error 502"],
	["The service is temporarily unavailable", "service unavailable"],
	["500 internal_error: Internal server error", "server error 500"],
	["Provider returned error", "server error"],
	["read ECONNRESET", "connection reset"],
	["socket hang up", "connection reset"],
	["connect ECONNREFUSED 127.0.0.1:8080", "connection refused"],
	["fetch failed", "network error"],
	["getaddrinfo ENOTFOUND api.example.com", "network error"],
	["Anthropic stream ended before message_stop", "stream interrupted"],
	["TypeError: terminated", "stream interrupted"],
	["Library error: zlib error: incorrect header check", "unreadable response"],
] as const)("a retry after %j reads %j", (errorMessage, reason) => {
	assert.equal(retryReason(errorMessage), reason);
});

test("an error no cause matches reads as its first line, shortened, and no error names no reason", () => {
	assert.equal(retryReason("Error: the gateway said no\nstack line"), "the gateway said no");
	assert.equal(
		retryReason("Error: a very long provider explanation of what went wrong somewhere today"),
		"a very long provider explanation of wha…",
	);
	assert.equal(retryReason("\x1b[31mshaky\x1b[39m"), "shaky", "terminal sequences never reach the line");
	assert.equal(retryReason(undefined), undefined);
	assert.equal(retryReason(""), undefined);
	assert.equal(retryReason("Unknown error"), undefined);
});

test("the line names the reason, the attempt and the countdown, in sentence case", () => {
	const now = 1_000_000;
	const wait = retryWaitFromEvent(
		{ attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: "stream deadline exceeded" },
		undefined,
		now,
	);
	assert.equal(retrySecondsLeft(wait, now), 4);
	assert.equal(retrySecondsLeft(wait, now + 3001), 1, "the countdown reads 1s until the attempt starts");
	assert.equal(retryWaitText(wait, 4), "Retrying · response timed out · attempt 2/3 in 4s");
	assert.equal(retryWaitText(wait, 75), "Retrying · response timed out · attempt 2/3 in 1m 15s");
	assert.equal(
		retryWaitMessage(wait, 4, "esc cancel"),
		"Retrying · response timed out · attempt 2/3 in 4s   esc cancel",
	);
	assert.equal(retryWaitMessage(wait, 0, "esc cancel"), "Working…", "the next attempt is under way");
	const summary = retryWaitFromEvent({ attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "503" }, "summary");
	assert.equal(retryWaitText(summary, 2), "Retrying summary · server error 503 · attempt 1/3 in 2s");
});

test("a detail the retry does not carry is left out, down to the plain line", () => {
	assert.equal(
		retryWaitText(retryWaitFromEvent({ attempt: 1, maxAttempts: 3, delayMs: 2000 }), 2),
		"Retrying · attempt 1/3 in 2s",
	);
	assert.equal(retryWaitText(retryWaitFromEvent({ errorMessage: "429" }), undefined), "Retrying · rate limited");
	assert.equal(retryWaitMessage(retryWaitFromEvent({}), undefined), "Retrying…");
	assert.equal(
		retryWaitMessage(retryWaitFromEvent({}, "summary"), undefined, "esc cancel"),
		"Retrying summary…   esc cancel",
	);
	assert.deepEqual(retryWaitFromEvent({ attempt: "1", maxAttempts: 3, delayMs: Number.NaN }), {});
	assert.equal(
		retryWaitFromEvent({ retryAt: 5_000, delayMs: 1 }).retryAt,
		5_000,
		"a scheduled time wins over a delay",
	);
});
