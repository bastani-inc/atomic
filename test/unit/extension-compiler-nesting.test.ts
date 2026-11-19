import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const entry = resolve(root, "test/fixtures/extension-compiler-nesting/index.cjs");

for (const runtime of ["Node", "Bun"]) {
	for (const mode of ["fallback", "strict"]) {
		test(`a cold helper load preserves the ${mode} compiler plugin's output on ${runtime} (#5669)`, () => {
			const agentDir = makeTempDirectory("extension-compiler-nesting-");
			try {
				const result = spawnSyncCollect(
					[
						runtime === "Bun" ? bunExecutable() : process.execPath,
						"--input-type=module",
						"--eval",
						`import { loadExtensionModule } from "./packages/coding-agent/dist/core/extensions/loader-virtual-modules.js";
const factory = await loadExtensionModule(${JSON.stringify(entry)}, undefined, ${JSON.stringify(agentDir)});
console.log(await factory(${mode === "strict"}));`,
					],
					{ cwd: root },
				);
				assert.equal(result.exitCode, 0, result.stderr.toString());
				assert.equal(result.stdout.toString().trim(), "42");
			} finally {
				removeTempDirectory(agentDir);
			}
		});
	}
}
