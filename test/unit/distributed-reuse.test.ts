import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { buildPlan, parseRunArgs, parseTopology, resolveRunOptions } from "../distributed/harness/config.mjs";
import { DistributedConfigError } from "../distributed/harness/errors.mjs";
import { loadState, reuseCommand } from "../distributed/harness/state.mjs";
import {
	makeDirectorySync,
	makeTempDirectory,
	removeTempDirectory,
	spawnSyncCollect,
	symlinkSync,
	writeTextSync,
} from "../helpers/runtime.js";

test("reuse reads a kept topology from its custom output directory (#4331)", () => {
	const dir = makeTempDirectory("distributed-reuse-");
	try {
		const topology = parseTopology(
			JSON.parse(readFileSync(new URL("../distributed/topology.json", import.meta.url), "utf8")),
		);
		const options = resolveRunOptions(parseRunArgs(["--ref", "main"]), topology, { randomSeed: 7 });
		const plan = buildPlan(options, topology, { runId: "adt2611050230-abcd", now: new Date("2026-11-05T02:30:00Z") });
		writeTextSync(join(dir, "state.json"), JSON.stringify({ plan, options, sha: "a".repeat(40) }));
		assert.deepEqual(loadState(plan.runId, join(dir, "unused"), dir).plan, plan);
		const result = spawnSyncCollect([
			process.execPath,
			"test/distributed/run.mjs",
			"--reuse",
			plan.runId,
			"--out",
			dir,
			"--plan-only",
		]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString()), plan);
	} finally {
		removeTempDirectory(dir);
	}
});

test("reuse preserves default lookup and rejects another run's custom directory (#4331)", () => {
	const dir = makeTempDirectory("distributed-reuse-");
	const runId = "adt2611050230-abcd";
	try {
		makeDirectorySync(join(dir, runId));
		const state = { plan: { runId } };
		writeTextSync(join(dir, runId, "state.json"), JSON.stringify(state));
		assert.deepEqual(loadState(runId, dir, undefined), state);
		for (const value of [
			null,
			1,
			{},
			{ plan: null },
			{ plan: 1 },
			{ plan: {} },
			{ plan: { runId: "another-run" } },
		]) {
			writeTextSync(join(dir, "state.json"), JSON.stringify(value));
			assert.throws(
				() => loadState(runId, dir, dir),
				(error) => {
					assert.ok(error instanceof DistributedConfigError);
					assert.equal(error.code, "invalid-config");
					assert.equal(error.fields.field, "--reuse");
					assert.equal(error.fields.reason, "invalid-value");
					assert.equal(error.fields.source, "cli");
					assert.equal(error.fields.expected, "state.json for the requested run ID");
					return true;
				},
			);
		}
	} finally {
		removeTempDirectory(dir);
	}
});

test.skipIf(process.platform === "win32")("controller commands run when invoked through symlinks", () => {
	const dir = makeTempDirectory("distributed-entrypoint-");
	try {
		for (const name of ["run", "sweep"]) {
			const link = join(dir, `${name}.mjs`);
			symlinkSync(resolve(`test/distributed/${name}.mjs`), link);
			const result = spawnSyncCollect([process.execPath, link, "--unsupported-flag"]);
			assert.equal(result.exitCode, 2, result.stderr.toString());
			assert.ok(result.stderr.toString().includes("cli --unsupported-flag is unknown-flag"));
		}
	} finally {
		removeTempDirectory(dir);
	}
});

test("state loading preserves readable-file diagnostics for custom output", () => {
	const dir = makeTempDirectory("distributed-state-errors-");
	try {
		for (const reason of ["unreadable", "invalid-json"] as const) {
			if (reason === "invalid-json") writeTextSync(join(dir, "state.json"), "not JSON");
			assert.throws(
				() => loadState("adt2611050230-abcd", "unused", dir),
				(error) => {
					assert.ok(error instanceof DistributedConfigError);
					assert.equal(error.code, "invalid-config");
					assert.equal(error.fields.field, "--reuse");
					assert.equal(error.fields.source, "cli");
					assert.equal(error.fields.reason, reason);
					assert.equal(error.fields.expected, "the id of a run kept with --keep whose topology was provisioned");
					assert.ok(error.cause instanceof Error);
					return true;
				},
			);
		}
	} finally {
		removeTempDirectory(dir);
	}
});

test("reuse commands include and quote only an explicitly custom output directory", () => {
	assert.equal(reuseCommand("run-a", undefined), "node test/distributed/run.mjs --reuse run-a");
	assert.equal(
		reuseCommand("run-a", "reports/custom output"),
		"node test/distributed/run.mjs --reuse run-a --out 'reports/custom output'",
	);
});
