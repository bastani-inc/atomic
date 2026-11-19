import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const fixture = join(moduleDir(import.meta.url), "fixtures", "panel-stop-resumer.mjs");
// Each subprocess loads the built SDK and the extension's SDK, including their native task host.
const HOST_START_TIMEOUT_MS = 60_000;

for (const [name, executable] of [
	["Node", process.execPath],
	["Bun", bunExecutable()],
] as const) {
	test(
		`the agent panel quits an extension's running task resumably under ${name} (#5688)`,
		() => {
			const result = spawnSyncCollect([executable, fixture], { timeout: HOST_START_TIMEOUT_MS });
			assert.equal(result.exitCode, 0, result.stderr.toString());
		},
		HOST_START_TIMEOUT_MS,
	);
}
