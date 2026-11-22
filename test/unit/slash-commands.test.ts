import assert from "node:assert/strict";
import { BUNDLED_COMMAND_NAMES, CORE_COMMAND_NAMES } from "@bastani/atomic-tui/dist/builtin-command-names.js";
import { afterEach, describe, test, vi } from "vitest";
import { APP_NAME } from "../../packages/coding-agent/src/config.js";
import {
	BUILTIN_SLASH_COMMANDS,
	BUNDLED_EXTENSION_SLASH_COMMANDS,
} from "../../packages/coding-agent/src/core/slash-commands.js";

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
		assert.match(compactCommand.description, /session history/i);
		assert.equal(compactCommand.argumentHint, "[instructions]");
		assert.equal(compactCommand.getArgumentCompletions, undefined);
	});

	test("does not list the removed Atomic guide command", () => {
		const atomicCommand = BUILTIN_SLASH_COMMANDS.find((item) => item.name === "atomic");

		assert.equal(atomicCommand, undefined);
	});

	test("describes every command name the terminal lists", () => {
		const undescribed = [
			...CORE_COMMAND_NAMES.filter(
				(name) => !BUILTIN_SLASH_COMMANDS.find((item) => item.name === name)?.description,
			),
			...BUNDLED_COMMAND_NAMES.filter(
				(name) => !BUNDLED_EXTENSION_SLASH_COMMANDS.find((item) => item.name === name)?.description,
			),
		];
		assert.deepEqual(undescribed, []);
	});
});

describe("built-in slash commands against an earlier release's command names", () => {
	afterEach(() => {
		vi.doUnmock("@bastani/atomic-tui/dist/builtin-command-names.js");
		vi.resetModules();
	});

	// A session that started on 0.10.4-alpha.1 and was updated in place holds that release's list of names, with
	// /mcp-auth and without /llama, when it loads the updated module.
	test("load with a name they do not describe, which gets no description", async () => {
		vi.resetModules();
		vi.doMock("@bastani/atomic-tui/dist/builtin-command-names.js", () => ({
			CORE_COMMAND_NAMES,
			BUNDLED_COMMAND_NAMES: [
				"agents",
				"mcp",
				"mcp-auth",
				"curator",
				"google-account",
				"search",
				"websearch",
				"intercom",
			],
		}));
		const { BUNDLED_EXTENSION_SLASH_COMMANDS: commands } = await import(
			"../../packages/coding-agent/src/core/slash-commands.js"
		);
		assert.deepEqual(
			commands.map(({ name }) => name),
			["agents", "mcp", "mcp-auth", "curator", "google-account", "search", "websearch", "intercom"],
		);
		assert.equal(commands.find(({ name }) => name === "mcp-auth")?.description, "");
		assert.equal(
			commands.find(({ name }) => name === "agents")?.description,
			"Browse available subagents and inspect their configuration",
		);
	});
});
