import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
function evaluate(...args: string[]) {
	return spawnSyncCollect(["python3", resolve(root, "test/fixtures/skill-trigger-stream.py"), ...args], {
		env: {
			PATH: process.env.PATH,
			PYTHONPATH: resolve(root, "packages/subagents/skills/skill-creator"),
			PYTHONDONTWRITEBYTECODE: "1",
		},
	});
}

// The evaluator selects a child process pipe, a POSIX interface.
describe.skipIf(process.platform === "win32")("bundled skill trigger evaluator", () => {
	test("reports a timeout rather than counting a trigger observed after the deadline (#5566)", () => {
		const result = evaluate("late");
		assert.notEqual(result.exitCode, 0, result.stdout.toString());
		assert.match(result.stderr.toString(), /timed out/iu);
	});

	test("counts producer startup against the query timeout (#5566)", () => {
		const result = evaluate("slow-start", "1");
		assert.notEqual(result.exitCode, 0, result.stdout.toString());
		assert.match(result.stderr.toString(), /timed out/iu);
	});

	test("accepts a buffered trigger with a timeout larger than the platform timer (#5566)", () => {
		const result = evaluate("exited", `1${"0".repeat(350)}`);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString().trim(), "True");
	});

	test("counts a timely trigger still buffered after the producer exits (#5566)", () => {
		const result = evaluate("exited");
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.equal(result.stdout.toString().trim(), "True");
	});
});
