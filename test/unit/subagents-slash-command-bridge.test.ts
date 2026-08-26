import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import { test } from "vitest";
import { BUNDLED_EXTENSION_SLASH_COMMANDS } from "../../packages/coding-agent/src/core/slash-commands.js";
import type { SubagentState } from "../../packages/subagents/src/shared/types.js";
import { registerSlashCommands } from "../../packages/subagents/src/slash/slash-commands.js";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

test("removed slash commands are not registered", () => {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-slash-removed-"));
	try {
		const commands = new Map<string, CommandOptions>();
		const pi = {
			registerCommand: (name: string, options: CommandOptions) => {
				commands.set(name, options);
			},
		} as Pick<ExtensionAPI, "registerCommand"> as ExtensionAPI;
		registerSlashCommands(pi, { baseCwd: cwd } as SubagentState);
		const removed = ["run", "parallel", "chain", "run-chain"];
		assert.deepEqual(
			[...commands.keys()].filter((command) => removed.includes(command)),
			[],
		);
		assert.deepEqual(
			BUNDLED_EXTENSION_SLASH_COMMANDS.filter((command) => removed.includes(command.name)),
			[],
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
