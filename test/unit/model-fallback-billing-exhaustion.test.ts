import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { normalizeModelFailureSignal } from "../../packages/coding-agent/src/core/model-fallback-failures.js";

const ANTHROPIC_CREDIT =
	"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

/** Provider wording for an account that has run out of credit or money: nothing serves it again until it is topped up. */
const BILLING_EXHAUSTION_MESSAGES: readonly (readonly [string, string])[] = [
	["Anthropic", ANTHROPIC_CREDIT],
	[
		"Anthropic, raw adapter text",
		`400 {"type":"error","error":{"type":"invalid_request_error","message":"${ANTHROPIC_CREDIT}"}}`,
	],
	["OpenAI", "You exceeded your current quota, please check your plan and billing details."],
	["OpenRouter", "Insufficient credits. Add more using https://openrouter.ai/settings/credits"],
	[
		"OpenRouter, affordability",
		"This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1200.",
	],
	["DeepSeek", "Insufficient Balance"],
	[
		"xAI",
		"Your team has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.",
	],
	["OpenCode Go", "Monthly usage limit reached. Enable usage from your available balance to continue."],
	["gateway budget", "Request rejected: this key is out of budget"],
];

describe("billing and credit exhaustion is an exhausted quota, not a short rate limit", () => {
	for (const [provider, message] of BILLING_EXHAUSTION_MESSAGES) {
		test(`${provider} wording classifies as quota_exhausted`, () => {
			assert.equal(normalizeModelFailureSignal(new Error(message)).kind, "quota_exhausted");
			assert.equal(
				normalizeModelFailureSignal({ stopReason: "error", errorMessage: message }).kind,
				"quota_exhausted",
			);
		});
	}

	test("Anthropic's credit error with its HTTP 400 status classifies as quota_exhausted", () => {
		const failure = { status: 400, error: { type: "invalid_request_error", message: ANTHROPIC_CREDIT } };
		assert.equal(normalizeModelFailureSignal(failure).kind, "quota_exhausted");
		assert.equal(normalizeModelFailureSignal({ status: 400, message: ANTHROPIC_CREDIT }).kind, "quota_exhausted");
	});

	test("a rate limit counted in credits stays a rate limit", () => {
		assert.equal(
			normalizeModelFailureSignal(new Error("Rate limit reached: 40 credits per minute")).kind,
			"rate_limit",
		);
	});
});
