import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { APP_NAME } from "../../packages/coding-agent/src/config.js";
import { BUILTIN_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";

describe("built-in slash commands", () => {
	test("lists /exit as a graceful shutdown command", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "exit");

		assert.ok(command, "expected /exit to be listed as a built-in command");
		assert.equal(command.description, `Exit ${APP_NAME}`);
	});

	test("advertises the /model provider and model argument", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "model");

		assert.ok(command, "expected /model to be listed as a built-in command");
		assert.equal(command.argumentHint, "<provider/model>");
	});

	test("lists /thinking with its level argument", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "thinking");

		assert.ok(command, "expected /thinking to be listed as a built-in command");
		assert.equal(command.description, "Set thinking level");
		assert.equal(command.argumentHint, "<level>");
	});

	// Upstream a2f369d63a ("order tree above thinking") ranks /tree ahead of
	// /thinking so typing "/t" surfaces branch navigation first.
	test("orders /tree above /thinking", () => {
		const treeIndex = BUILTIN_SLASH_COMMANDS.findIndex((item) => item.name === "tree");
		const thinkingIndex = BUILTIN_SLASH_COMMANDS.findIndex((item) => item.name === "thinking");

		assert.notEqual(treeIndex, -1, "expected /tree to be listed as a built-in command");
		assert.notEqual(thinkingIndex, -1, "expected /thinking to be listed as a built-in command");
		assert.ok(treeIndex < thinkingIndex, `expected /tree (${treeIndex}) before /thinking (${thinkingIndex})`);
	});

	test("removes /context-compact and keeps /compact as the compaction command", () => {
		const contextCommand = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "context-compact");
		const compactCommand = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "compact");

		assert.equal(contextCommand, undefined);
		assert.ok(compactCommand, "expected /compact to be listed as a built-in command");
		assert.match(compactCommand.description, /verbatim/i);
		assert.equal(compactCommand.getArgumentCompletions, undefined);
	});

	test("does not list the removed Atomic guide command", () => {
		const atomicCommand = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "atomic");

		assert.equal(atomicCommand, undefined);
	});
});
