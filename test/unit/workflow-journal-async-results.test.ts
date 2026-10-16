import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

for (const operation of ["prompt", "complete", "unused", "exit"]) {
	test(`cached-stage persistence failure is contained during delayed ${operation}`, () => {
		const result = spawnSyncCollect([
			process.execPath,
			"--unhandled-rejections=strict",
			join(moduleDir(import.meta.url), "../fixtures/journal-cached-stage-rejection.mjs"),
			operation,
		]);
		assert.equal(result.exitCode, 0, result.stderr.toString() + result.stdout.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString()), {
			operation,
			status: "failed",
			unhandled: 0,
			stageCallbacks: 1,
			metadataWrites: 1,
		});
	});
}
