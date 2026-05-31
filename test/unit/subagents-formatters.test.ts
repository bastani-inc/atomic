import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { formatDuration, formatModelThinking } from "../../packages/subagents/src/shared/formatters.js";

describe("subagent formatModelThinking", () => {
	test("appends fast after model and inferred thinking suffix", () => {
		assert.equal(
			formatModelThinking("openai/gpt-5.1-codex:medium", undefined, true),
			"gpt-5.1-codex · thinking medium · fast",
		);
	});

	test("omits fast when fast mode metadata is missing or disabled", () => {
		assert.equal(formatModelThinking("openai/gpt-5.1-codex:medium"), "gpt-5.1-codex · thinking medium");
		assert.equal(formatModelThinking("openai/gpt-5.1-codex:medium", undefined, false), "gpt-5.1-codex · thinking medium");
	});

	test("appends fast after explicit thinking metadata", () => {
		assert.equal(
			formatModelThinking("openai/gpt-5.1-codex", "high", true),
			"gpt-5.1-codex · thinking high · fast",
		);
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
