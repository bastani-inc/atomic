import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";
import { fileExistsSync, readDirectorySync } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

type VitestProject = { test?: { name?: string; clearMocks?: boolean } };

/**
 * vitest 4's `vi.restoreAllMocks()` puts spied methods back but keeps every spy, with the arguments, `this` and result
 * of each call it saw, for the rest of the file, so a file that spies on busy code grows with every test (#5552).
 * Every project therefore clears all mock records before each test; test/unit/spy-records-test-boundary.test.ts shows
 * the records are released. A config added for another package must do the same.
 */
test("every vitest project clears mock call records before each test (#5552)", async () => {
	const configs = [
		"vitest.config.ts",
		...readDirectorySync(join(root, "packages")).map((p) => `packages/${p}/vitest.config.ts`),
	].filter((config) => fileExistsSync(join(root, config)));
	assert.ok(configs.includes("packages/coding-agent/vitest.config.ts"), "the coding-agent config was not found");
	for (const config of configs) {
		const loaded = (await import(pathToFileURL(join(root, config)).href)) as {
			default: VitestProject & { test?: { projects?: VitestProject[] } };
		};
		const projects = loaded.default.test?.projects ?? [loaded.default];
		assert.ok(projects.length > 0, `${config} declares no vitest project`);
		for (const project of projects) {
			assert.equal(
				project.test?.clearMocks,
				true,
				`${config} project ${project.test?.name ?? "(unnamed)"} must set clearMocks: true`,
			);
		}
	}
});
