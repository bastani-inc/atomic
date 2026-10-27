import assert from "node:assert/strict";
import { test } from "vitest";
import { expectExitedCleanly, spawnWithinBudget } from "../helpers/budgeted-process.js";

const idle = [process.execPath, "-e", "setInterval(() => {}, 1_000)"];

test("a process its budget ends is reported as killed after that budget", async () => {
	const child = spawnWithinBudget(idle, { stdout: "ignore" }, Date.now() + 200);
	await assert.rejects(expectExitedCleanly(child), /killed after its \d+ ms budget/);
});

test("a process another signal ends is reported with that signal, not as out of budget", async () => {
	const child = spawnWithinBudget(idle, { stdout: "ignore" }, Date.now() + 60_000);
	child.process.kill("SIGTERM");
	await assert.rejects(expectExitedCleanly(child), (error: Error) => {
		assert.match(error.message, /killed by signal SIGTERM/);
		assert.doesNotMatch(error.message, /budget/);
		return true;
	});
});

test("a process that fails on its own is reported with its exit code and stderr", async () => {
	const child = spawnWithinBudget(
		[process.execPath, "-e", "console.error('boom'); process.exit(3)"],
		{ stdout: "ignore" },
		Date.now() + 60_000,
	);
	await assert.rejects(expectExitedCleanly(child), /exited with code 3[\s\S]*boom/);
});

test("a process that succeeds within its budget returns its stderr", async () => {
	const child = spawnWithinBudget(
		[process.execPath, "-e", "console.error('note')"],
		{ stdout: "ignore" },
		Date.now() + 60_000,
	);
	assert.match(await expectExitedCleanly(child), /note/);
});
