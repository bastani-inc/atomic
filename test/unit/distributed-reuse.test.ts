import assert from "node:assert/strict";
import { chmodSync, readFileSync as readFile, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { buildPlan, parseRunArgs, parseTopology, resolveRunOptions } from "../distributed/harness/config.mjs";
import { DistributedCommandError, DistributedConfigError } from "../distributed/harness/errors.mjs";
import { loadState, reuseCommand } from "../distributed/harness/state.mjs";
import { verifyReuseContext } from "../distributed/run.mjs";
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

const SAVED_SUBSCRIPTION = "11111111-1111-1111-1111-111111111111";
const SAVED_VNET =
	"/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/control-rg/providers/Microsoft.Network/virtualNetworks/control-vnet";
const savedContext = { subscription: SAVED_SUBSCRIPTION, controlVnetId: SAVED_VNET };
const controlNetwork = { resourceGroup: "control-rg", vnet: "control-vnet" };

function currentAzure(subscription: unknown, vnetId: unknown, failure?: unknown) {
	const calls: string[][] = [];
	const operations: string[] = [];
	const az = async (args: readonly string[], operation: string) => {
		calls.push([...args]);
		operations.push(operation);
		if (failure !== undefined) throw failure;
		if (args[0] === "account") return subscription;
		if (args[0] === "network") return vnetId;
		throw new Error(`unexpected az ${args.join(" ")}`);
	};
	return { az, calls, operations };
}

test("reuse accepts the kept run's own subscription and control VNet, compared as Azure IDs (#4331)", async () => {
	const fake = currentAzure(SAVED_SUBSCRIPTION.toUpperCase(), SAVED_VNET.replace("control-rg", "CONTROL-RG"));

	await verifyReuseContext({ az: fake.az, saved: savedContext, control: controlNetwork });

	assert.deepEqual(fake.calls, [
		["account", "show", "--query", "id"],
		["network", "vnet", "show", "--resource-group", "control-rg", "--name", "control-vnet", "--query", "id"],
	]);
	assert.deepEqual(
		fake.operations,
		["reuse: current subscription", "reuse: current control VNet"],
		"each az call is named in the command log and in any command failure",
	);
});

test("reuse rejects a current subscription or control VNet that az did not report as an ID (#4331)", async () => {
	for (const [subscription, vnetId, field] of [
		[null, SAVED_VNET, "--reuse"],
		[42, SAVED_VNET, "--reuse"],
		[SAVED_SUBSCRIPTION, null, "ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP/ATOMIC_DISTRIBUTED_CONTROL_VNET"],
		[
			SAVED_SUBSCRIPTION,
			{ id: SAVED_VNET },
			"ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP/ATOMIC_DISTRIBUTED_CONTROL_VNET",
		],
	] as const) {
		const fake = currentAzure(subscription, vnetId);
		await assert.rejects(
			verifyReuseContext({ az: fake.az, saved: savedContext, control: controlNetwork }),
			(error) => {
				assert.ok(
					error instanceof DistributedConfigError,
					`typed rejection for ${String(subscription)}/${String(vnetId)}`,
				);
				assert.equal(error.fields.field, field);
				assert.equal(error.fields.actual, String(field === "--reuse" ? subscription : vnetId));
				return true;
			},
		);
	}
});

test("reuse rejects another Azure subscription before reading or changing anything else (#4331)", async () => {
	const fake = currentAzure("22222222-2222-2222-2222-222222222222", SAVED_VNET);

	await assert.rejects(verifyReuseContext({ az: fake.az, saved: savedContext, control: controlNetwork }), (error) => {
		assert.ok(error instanceof DistributedConfigError);
		assert.equal(error.code, "invalid-config");
		assert.equal(error.fields.source, "cli");
		assert.equal(error.fields.field, "--reuse");
		assert.equal(error.fields.reason, "invalid-value");
		assert.equal(error.fields.actual, "22222222-2222-2222-2222-222222222222");
		assert.ok(String(error.fields.expected).includes(SAVED_SUBSCRIPTION));
		assert.ok(
			error.message.startsWith(
				"Invalid distributed-test configuration: cli --reuse is invalid-value (invalid-config).",
			),
			error.message,
		);
		return true;
	});
	assert.deepEqual(fake.calls, [["account", "show", "--query", "id"]]);
});

test("reuse rejects a control network other than the one the run was peered to (#4331)", async () => {
	const other = SAVED_VNET.replace("control-vnet", "other-vnet");
	const fake = currentAzure(SAVED_SUBSCRIPTION, other);

	await assert.rejects(verifyReuseContext({ az: fake.az, saved: savedContext, control: controlNetwork }), (error) => {
		assert.ok(error instanceof DistributedConfigError);
		assert.equal(error.fields.source, "env");
		assert.equal(error.fields.field, "ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP/ATOMIC_DISTRIBUTED_CONTROL_VNET");
		assert.equal(error.fields.reason, "invalid-value");
		assert.equal(error.fields.actual, other);
		assert.ok(String(error.fields.expected).includes(SAVED_VNET));
		return true;
	});
});

test("reuse rejects state that never recorded its Azure context (#4331)", async () => {
	for (const saved of [{}, { subscription: SAVED_SUBSCRIPTION }]) {
		const fake = currentAzure(SAVED_SUBSCRIPTION, SAVED_VNET);
		await assert.rejects(
			verifyReuseContext({ az: fake.az, saved, control: controlNetwork }),
			(error) => error instanceof DistributedConfigError,
		);
	}
});

test("reuse context checks keep cancellation and command failures as they are (#4331)", async () => {
	const cancelled = Object.assign(new Error("aborted"), { name: "AbortError" });
	const failed = new DistributedCommandError({ tool: "az", operation: "show", exitCode: 1, signal: null });
	for (const failure of [cancelled, failed]) {
		const fake = currentAzure(SAVED_SUBSCRIPTION, SAVED_VNET, failure);
		await assert.rejects(
			verifyReuseContext({ az: fake.az, saved: savedContext, control: controlNetwork }),
			(error) => error === failure,
		);
	}
});

test.skipIf(process.platform === "win32")(
	"a reuse in another Azure context exits before any cleanup or other Azure change (#4331)",
	() => {
		const dir = makeTempDirectory("distributed-reuse-context-");
		try {
			const topology = parseTopology(
				JSON.parse(readFileSync(new URL("../distributed/topology.json", import.meta.url), "utf8")),
			);
			const options = resolveRunOptions(parseRunArgs(["--ref", "main"]), topology, { randomSeed: 7 });
			const plan = buildPlan(options, topology, {
				runId: "adt2611050230-abcd",
				now: new Date("2026-11-05T02:30:00Z"),
			});
			const out = join(dir, "out");
			makeDirectorySync(out);
			writeTextSync(
				join(out, "state.json"),
				JSON.stringify({ plan, options, sha: "a".repeat(40), ...savedContext, vms: [], networks: [] }),
			);
			writeTextSync(
				join(out, "manifest.json"),
				JSON.stringify({
					runId: plan.runId,
					resourceGroup: plan.resourceGroup,
					expiresAt: plan.expiresAt,
					subscription: SAVED_SUBSCRIPTION,
					control: controlNetwork,
					entries: [{ kind: "group", name: plan.resourceGroup, scope: "subscription", state: "created" }],
				}),
			);
			const bin = join(dir, "bin");
			makeDirectorySync(bin);
			const calls = join(dir, "az-calls");
			writeTextSync(
				join(bin, "az"),
				[
					"#!/bin/sh",
					`printf '%s\\n' "$*" >> '${calls}'`,
					'case "$1 $2" in',
					`  "account show") echo '"22222222-2222-2222-2222-222222222222"' ;;`,
					`  "network vnet") if [ "$3" = show ]; then echo '"${SAVED_VNET}"'; else echo '[]'; fi ;;`,
					`  "group exists") echo false ;;`,
					"  *) echo '[]' ;;",
					"esac",
				].join("\n"),
			);
			chmodSync(join(bin, "az"), 0o755);

			const result = spawnSyncCollect(
				[process.execPath, "test/distributed/run.mjs", "--reuse", plan.runId, "--out", out],
				{
					timeout: 60_000,
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP: "control-rg",
						ATOMIC_DISTRIBUTED_CONTROL_VNET: "control-vnet",
						ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX: "10.0.1.0/24",
					},
				},
			);

			assert.equal(result.exitCode, 2, result.stdout.toString() + result.stderr.toString());
			assert.ok(result.stderr.toString().includes("--reuse is invalid-value"), result.stderr.toString());
			assert.deepEqual(readFile(calls, "utf8").trim().split("\n"), [
				"account show --query id -o json --only-show-errors",
			]);
		} finally {
			removeTempDirectory(dir);
		}
	},
);
