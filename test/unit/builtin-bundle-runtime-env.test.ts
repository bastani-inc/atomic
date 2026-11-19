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

// A bundle built under NODE_ENV=test must not select stub sessions in production.
test("shipped subagent extension bundle decides test-host stubbing at runtime, not at bundle time", () => {
	const bundle = join(distBuiltinRoot, "subagents", INSTALLED_EXTENSION_ENTRIES.subagents);
	requireBuiltPath(bundle);
	const source = readTextSync(bundle, "utf8");
	assert.match(source, /process\.env(?:\.NODE_ENV|\["NODE_ENV"\]) === "test"/);
});
