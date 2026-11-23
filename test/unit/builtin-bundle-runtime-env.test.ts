import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { INSTALLED_EXTENSION_ENTRIES } from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import { fileExistsSync, moduleDir, readTextSync } from "../helpers/runtime.js";

const root = join(moduleDir(import.meta.url), "../..");
const distBuiltinRoot = join(root, "packages", "coding-agent", "dist", "builtin");
const buildCommand = "npm --workspace=@bastani/atomic run build";

function requireBuiltPath(path: string): void {
	assert.ok(fileExistsSync(path), `Missing built artifact ${path}. Run \`${buildCommand}\` before this test.`);
}

// Shipped subagents must never enable stub sessions from ambient NODE_ENV or NODE_TEST_CONTEXT
// (neither at bundle time nor at runtime); only an explicit options.testSession opts in.
test("shipped subagent extension bundle never stubs sessions from NODE_ENV or NODE_TEST_CONTEXT", () => {
	const bundle = join(distBuiltinRoot, "subagents", INSTALLED_EXTENSION_ENTRIES.subagents);
	requireBuiltPath(bundle);
	const source = readTextSync(bundle, "utf8");
	assert.doesNotMatch(source, /process\.env(?:\.NODE_ENV|\["NODE_ENV"\])\s*===?\s*"test"/);
	assert.doesNotMatch(source, /NODE_TEST_CONTEXT/);
});
