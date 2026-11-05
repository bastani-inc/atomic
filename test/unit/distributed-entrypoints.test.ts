import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, type MockInstance, test, vi } from "vitest";
import { buildPlan, parseRunArgs, parseTopology, resolveRunOptions } from "../distributed/harness/config.mjs";
import { makeTempDirectory, removeTempDirectory, symlinkSync, writeTextSync } from "../helpers/runtime.js";

let argv: string[];
let exitCode: typeof process.exitCode;
let dir: string;
let stdout: MockInstance<typeof process.stdout.write>;
let stderr: MockInstance<typeof process.stderr.write>;
beforeEach(() => {
	argv = process.argv;
	exitCode = process.exitCode;
	dir = makeTempDirectory("distributed-entrypoint-");
	process.exitCode = undefined;
	vi.resetModules();
	vi.stubEnv("ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP", "");
	stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
	process.argv = argv;
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	removeTempDirectory(dir);
});
const entry = (name: "run" | "sweep") => fileURLToPath(new URL(`../distributed/${name}.mjs`, import.meta.url));
const load = (name: "run" | "sweep") =>
	name === "run" ? import("../distributed/run.mjs") : import("../distributed/sweep.mjs");

for (const name of ["run", "sweep"] as const) {
	test(`${name} import does not execute its CLI (#4331)`, async () => {
		process.argv = [process.execPath, fileURLToPath(import.meta.url), "--unsupported-flag"];
		await load(name);
		assert.equal(process.exitCode, undefined);
		assert.equal(stdout.mock.calls.length, 0);
		assert.equal(stderr.mock.calls.length, 0);
	});
	test(`${name} imports without a process entrypoint (#4331)`, async () => {
		process.argv = [process.execPath];
		await load(name);
		assert.equal(process.exitCode, undefined);
		assert.equal(stderr.mock.calls.length, 0);
	});
	test(`${name} executes its CLI when directly invoked (#4331)`, async () => {
		process.argv = [process.execPath, entry(name), "--unsupported-flag"];
		await load(name);
		assert.equal(process.exitCode, 2);
		assert.ok(
			stderr.mock.calls
				.map(([text]) => String(text))
				.join("")
				.includes("unknown-flag"),
		);
	});
	test.skipIf(process.platform === "win32")(`${name} executes through a symlinked entrypoint (#4331)`, async () => {
		const link = join(dir, `${name}.mjs`);
		symlinkSync(entry(name), link);
		process.argv = [process.execPath, link, "--unsupported-flag"];
		await load(name);
		assert.equal(process.exitCode, 2);
	});
}

test("the controller plans a new run without looking for reuse state (#4331)", async () => {
	process.argv = [process.execPath, entry("run"), "--ref", "a".repeat(40), "--plan-only"];
	await load("run");
	assert.equal(process.exitCode, 0);
	const plan = JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join(""));
	assert.equal(plan.vms.length, 5);
	assert.equal(stderr.mock.calls.length, 0);
});

test("the controller reads custom output state before planning reuse (#4331)", async () => {
	const topology = parseTopology(
		JSON.parse(readFileSync(new URL("../distributed/topology.json", import.meta.url), "utf8")),
	);
	const options = resolveRunOptions(parseRunArgs(["--ref", "main"]), topology, { randomSeed: 7 });
	const plan = buildPlan(options, topology, { runId: "adt2611050230-abcd", now: new Date("2026-11-05T02:30:00Z") });
	writeTextSync(join(dir, "state.json"), JSON.stringify({ plan, options, sha: "a".repeat(40) }));
	process.argv = [process.execPath, entry("run"), "--reuse", plan.runId, "--out", dir, "--plan-only"];
	await load("run");
	assert.equal(process.exitCode, 0);
	assert.deepEqual(JSON.parse(stdout.mock.calls.map(([text]) => String(text)).join("")), plan);
});
