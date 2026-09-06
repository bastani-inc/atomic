import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const driver = join(moduleDir(import.meta.url), "../fixtures/stage-chat-skill-driver.mjs");

// RFC #2884: the credential-free terminal fixture must be reproducible from the checkout.
test("stage skill terminal driver documents invocation without requiring terminal tooling", () => {
	const result = spawnSyncCollect([process.execPath, driver, "--help"], { env: { ...process.env, PATH: "" } });
	assert.equal(result.exitCode, 0);
	assert.match(result.stdout.toString(), /--evidence-dir <fresh-directory>/);
});

test("stage skill terminal driver rejects missing or invalid arguments before launch", () => {
	for (const args of [
		[],
		["--evidence-dir", "unused", "--columns", "NaN"],
		["--evidence-dir", "unused", "--rows", "0"],
	]) {
		const result = spawnSyncCollect([process.execPath, driver, ...args], { env: { ...process.env, PATH: "" } });
		assert.notEqual(result.exitCode, 0);
		assert.match(result.stderr.toString(), /Usage:|must be an integer/);
	}
});

test("stage skill terminal driver refuses an existing evidence directory before launch", () => {
	const directory = makeTempDirectory("stage-skill-driver-");
	try {
		const result = spawnSyncCollect([process.execPath, driver, "--evidence-dir", directory], {
			env: { ...process.env, PATH: "" },
		});
		assert.notEqual(result.exitCode, 0);
		assert.match(result.stderr.toString(), /EEXIST/);
	} finally {
		removeTempDirectory(directory);
	}
});
