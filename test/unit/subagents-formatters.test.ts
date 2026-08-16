import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { formatDuration, formatModelThinking } from "../../packages/subagents/src/shared/formatters.js";

describe("subagent formatModelThinking", () => {
	test("appends fast after model and inferred thinking suffix", () => {
		assert.equal(
			formatModelThinking("openai/gpt-5.1-codex:medium", undefined, true),
			"openai/gpt-5.1-codex · thinking medium · fast",
		);
	});

	test("omits fast when fast mode metadata is missing or disabled", () => {
		assert.equal(formatModelThinking("openai/gpt-5.1-codex:medium"), "openai/gpt-5.1-codex · thinking medium");
		assert.equal(
			formatModelThinking("openai/gpt-5.1-codex:medium", undefined, false),
			"openai/gpt-5.1-codex · thinking medium",
		);
	});

	test("appends fast after explicit thinking metadata", () => {
		assert.equal(
			formatModelThinking("openai/gpt-5.1-codex", "high", true),
			"openai/gpt-5.1-codex · thinking high · fast",
		);
	});

	test("keeps the provider prefix so the line matches the main chat model display", () => {
		assert.equal(formatModelThinking("anthropic/claude-fable-5", "high"), "anthropic/claude-fable-5 · thinking high");
		assert.equal(formatModelThinking("anthropic/claude-fable-5"), "anthropic/claude-fable-5");
	});

	test("keeps every segment of a multi-segment routed model id", () => {
		assert.equal(
			formatModelThinking("openrouter/anthropic/claude-fable-5:max"),
			"openrouter/anthropic/claude-fable-5 · thinking max",
		);
	});

	test("splits only a known thinking suffix", () => {
		assert.equal(formatModelThinking("openai/gpt-5.1-codex:preview"), "openai/gpt-5.1-codex:preview");
	});
});

describe("subagent formatDuration", () => {
	test("uses whole seconds without fractional or millisecond labels", () => {
		assert.equal(formatDuration(-100), "0s");
		assert.equal(formatDuration(0), "0s");
		assert.equal(formatDuration(999), "0s");
		assert.equal(formatDuration(1_900), "1s");
		assert.equal(formatDuration(59_900), "59s");
	});

	test("separates duration units with spaces", () => {
		assert.equal(formatDuration(60_000), "1m");
		assert.equal(formatDuration(62_000), "1m 2s");
		assert.equal(formatDuration(3_600_000), "1h");
		assert.equal(formatDuration(3_720_000), "1h 2m");
	});
});
