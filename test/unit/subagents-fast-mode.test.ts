import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	resolveSubagentCodexFastModeScope,
	resolveSubagentModelFastMode,
	resolveSubagentModelFastModeMetadata,
} from "../../packages/subagents/src/shared/fast-mode.js";

const cwd = process.cwd();

describe("subagent fast-mode scope", () => {
	test("uses chat settings for main-chat subagents only", () => {
		const settings = { chat: true, workflow: false };

		assert.equal(resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "chat" }), true);
		assert.equal(
			resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "workflow" }),
			false,
		);
	});

	test("uses workflow settings for workflow-stage subagents only", () => {
		const settings = { chat: false, workflow: true };

		assert.equal(
			resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "chat" }),
			false,
		);
		assert.equal(
			resolveSubagentModelFastMode({ model: "openai/gpt-5.1-codex", cwd, settings, scope: "workflow" }),
			true,
		);
	});

	test("supports openai-codex models with thinking suffixes", () => {
		const settings = { chat: false, workflow: true };

		assert.equal(
			resolveSubagentModelFastMode({ model: "openai-codex/gpt-5.1-codex:medium", cwd, settings, scope: "workflow" }),
			true,
		);
		assert.equal(
			resolveSubagentModelFastMode({ model: "anthropic/claude-sonnet-4:medium", cwd, settings, scope: "workflow" }),
			false,
		);
	});

	test("builds scoped metadata for primary and fallback candidates", () => {
		const metadata = resolveSubagentModelFastModeMetadata({
			model: "openai/gpt-5.1-codex",
			modelCandidates: ["openai/gpt-5.1-codex", "anthropic/claude-sonnet-4"],
			cwd,
			settings: { chat: false, workflow: true },
			scope: "workflow",
		});

		assert.equal(metadata.fastMode, true);
		assert.deepEqual(metadata.modelFastModes, {
			"openai/gpt-5.1-codex": true,
			"anthropic/claude-sonnet-4": false,
		});
	});

	test("derives scope from workflow-stage guard", () => {
		assert.equal(resolveSubagentCodexFastModeScope(false), "chat");
		assert.equal(resolveSubagentCodexFastModeScope(undefined), "chat");
		assert.equal(resolveSubagentCodexFastModeScope(true), "workflow");
	});
});
