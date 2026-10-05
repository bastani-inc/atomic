import assert from "node:assert/strict";
import { test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { buildInteractiveEngineArgs } from "../src/modes/interactive-engine/engine-args.ts";

for (const disableMcp of [false, true]) {
	test(`interactive engine preserves MCP policy and wildcard selections with --no-mcp ${disableMcp}`, () => {
		const parsed = parseArgs([
			"--tools",
			"read,codemode,mcp__evidence__*",
			"--exclude-tools",
			"mcp__*__e*",
			...(disableMcp ? ["--no-mcp"] : []),
		]);
		const child = parseArgs(buildInteractiveEngineArgs(parsed, SessionManager.inMemory(), {}));
		assert.equal(child.noMcp, parsed.noMcp);
		assert.deepEqual(child.tools, parsed.tools);
		assert.deepEqual(child.excludeTools, parsed.excludeTools);
		assert.deepEqual(child.diagnostics, []);
	});
}
