import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.ts";

const probe = fileURLToPath(new URL("../fixtures/blueprint-timeout-diagnostic.mjs", import.meta.url));

for (const [host, executable] of [
	["Node", process.execPath],
	["Bun", bunExecutable()],
] as const) {
	test(`a NaN blueprint timeout preserves ${host}'s native warning on the first timer (#5707)`, () => {
		const root = makeTempDirectory("blueprint-timeout-warning-");
		try {
			const observe = (mode: string) => {
				const result = spawnSyncCollect([executable, probe, mode, root]);
				assert.equal(result.exitCode, 0, result.stderr.toString());
				return JSON.parse(result.stdout.toString());
			};
			assert.deepEqual(observe("blueprint"), observe("native"));
		} finally {
			removeTempDirectory(root);
		}
	});
}
