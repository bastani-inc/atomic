import assert from "node:assert/strict";
import type { ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	__setGlobalNpmRootExecSyncForTest,
	clearSkillCache,
	discoverAvailableSkills,
} from "../../packages/subagents/src/agents/skills.js";

const cleanupPaths = new Set<string>();

afterEach(() => {
	__setGlobalNpmRootExecSyncForTest();
	for (const cleanupPath of cleanupPaths) rmSync(cleanupPath, { recursive: true, force: true });
	cleanupPaths.clear();
	clearSkillCache();
});

describe("subagent skill discovery npm probe", () => {
	test("caches a failed global npm root probe for the process", () => {
		const calls: Array<{ command: string; options?: ExecSyncOptionsWithStringEncoding }> = [];
		const failingExecSync = ((command: string, options?: ExecSyncOptionsWithStringEncoding): string => {
			calls.push({ command, options });
			throw new Error(`simulated npm probe failure: ${command}`);
		}) as typeof import("node:child_process").execSync;
		__setGlobalNpmRootExecSyncForTest(failingExecSync);

		const firstCwd = mkdtempSync(join(tmpdir(), "atomic-skills-first-"));
		const secondCwd = mkdtempSync(join(tmpdir(), "atomic-skills-second-"));
		const afterClearCwd = mkdtempSync(join(tmpdir(), "atomic-skills-after-clear-"));
		cleanupPaths.add(firstCwd);
		cleanupPaths.add(secondCwd);
		cleanupPaths.add(afterClearCwd);

		assert.doesNotThrow(() => discoverAvailableSkills(firstCwd));
		assert.doesNotThrow(() => discoverAvailableSkills(secondCwd));

		assert.equal(calls.length, 1, "failed npm root probe should be cached as absent");
		assert.equal(calls[0]?.command, "npm root -g");
		assert.equal(calls[0]?.options?.timeout, 2500);
		assert.deepEqual(calls[0]?.options?.stdio, ["ignore", "pipe", "ignore"]);
		assert.equal(calls[0]?.options?.windowsHide, true);

		clearSkillCache();
		assert.doesNotThrow(() => discoverAvailableSkills(afterClearCwd));
		assert.equal(calls.length, 2, "clearSkillCache should allow the optional npm root probe to be retried");
	});
});
