import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

test("shared task clocks keep live owners but release clocks after their last owner leaves (#5224)", () => {
	const moduleUrl = new URL("../../packages/coding-agent/src/core/tasks/live-elapsed.ts", import.meta.url).href;
	const script = `
		import assert from "node:assert/strict";
		const clocks = await import(${JSON.stringify(moduleUrl)});
		async function collect() {
			for (let index = 0; index < 8; index++) {
				await new Promise(setImmediate);
				global.gc();
			}
			await new Promise(setImmediate);
		}
		clocks.liveElapsedMs("released", 0, true, 0);
		await collect();
		assert.equal(clocks.liveElapsedMs("released", undefined, false, 1000), undefined);
		const owner = new clocks.TaskElapsedClocks();
		owner.elapsedMs("retained", 0, true, 0);
		await collect();
		assert.equal(owner.elapsedMs("retained", 0, true, 1000), 1000);
		owner.clear();
		await collect();
		assert.equal(clocks.liveElapsedMs("retained", undefined, false, 2000), undefined);
	`;
	const result = spawnSyncCollect([
		process.execPath,
		"--expose-gc",
		"--experimental-strip-types",
		"--input-type=module",
		"-e",
		script,
	]);
	assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
});
