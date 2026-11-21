import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { NODE_TS_SOURCE_ARGS } from "../helpers/node-ts-sources.js";
import { bunExecutable } from "../helpers/runtime.js";

const fixture = fileURLToPath(new URL("../fixtures/startup-provider-errors.mjs", import.meta.url));

for (const [runtime, executable, args] of [
	["Node", process.execPath, NODE_TS_SOURCE_ARGS],
	["Bun", bunExecutable(), []],
] as const) {
	test.each([
		["independent", "leaves an independent provider rejection visible to the host"],
		["fulfilled", "does not observe a fulfilled provider promise when the command throws"],
	])(`%s: command registration on ${runtime} %s (#5639)`, (scenario) => {
		const result = spawnSync(executable, [...args, fixture, scenario], { encoding: "utf8", timeout: 60_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
	});
}
