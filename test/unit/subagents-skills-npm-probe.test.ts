import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	__setGlobalNpmRootExecForTest,
	clearSkillCache,
	discoverAvailableSkills,
} from "../../packages/subagents/src/agents/skills.js";
import type { GlobalNpmRootExecOptions } from "../../packages/subagents/src/agents/skills-paths.js";

const cleanupPaths = new Set<string>();

afterEach(() => {
	__setGlobalNpmRootExecForTest();
	for (const cleanupPath of cleanupPaths) rmSync(cleanupPath, { recursive: true, force: true });
	cleanupPaths.clear();
	clearSkillCache();
});

describe("subagent skill discovery npm probe", () => {
	test("caches a failed global npm root probe for the process", async () => {
		const calls: Array<{ command: string; options: GlobalNpmRootExecOptions }> = [];
		__setGlobalNpmRootExecForTest(async (command, options) => {
			calls.push({ command, options });
			throw new Error(`simulated npm probe failure: ${command}`);
		});

		const firstCwd = mkdtempSync(join(tmpdir(), "atomic-skills-first-"));
		const secondCwd = mkdtempSync(join(tmpdir(), "atomic-skills-second-"));
		const afterClearCwd = mkdtempSync(join(tmpdir(), "atomic-skills-after-clear-"));
		cleanupPaths.add(firstCwd);
		cleanupPaths.add(secondCwd);
		cleanupPaths.add(afterClearCwd);

		await discoverAvailableSkills(firstCwd);
		await discoverAvailableSkills(secondCwd);

		assert.equal(calls.length, 1, "failed npm root probe should be cached as absent");
		assert.equal(calls[0]?.command, "npm root -g");
		assert.equal(calls[0]?.options.timeout, 2500);
		assert.equal(calls[0]?.options.windowsHide, true);

		clearSkillCache();
		await discoverAvailableSkills(afterClearCwd);
		assert.equal(calls.length, 2, "clearSkillCache should allow the optional npm root probe to be retried");
	});

	test("concurrent skill discoveries share one global npm root probe", async () => {
		let calls = 0;
		const globalRoot = mkdtempSync(join(tmpdir(), "atomic-skills-global-root-"));
		cleanupPaths.add(globalRoot);
		__setGlobalNpmRootExecForTest(async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { stdout: `${globalRoot}\n` };
		});
		const cwds = [0, 1, 2].map(() => mkdtempSync(join(tmpdir(), "atomic-skills-concurrent-")));
		for (const cwd of cwds) cleanupPaths.add(cwd);

		await Promise.all(cwds.map((cwd) => discoverAvailableSkills(cwd)));

		assert.equal(calls, 1, "discoveries that overlap must not each run `npm root -g`");
	});
});
