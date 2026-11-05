import assert from "node:assert/strict";
import { test } from "vitest";
import { DistributedCommandError } from "../distributed/harness/errors.mjs";
import { sweep, sweepExitCode } from "../distributed/sweep.mjs";

const EXPIRED_A = "adt2611050230-0001";
const EXPIRED_B = "adt2611050230-0002";
const control = { resourceGroup: "control-rg", vnet: "control-vnet" };

function fakeAzure(failDeleteOf: readonly string[], failure: (id: string) => unknown) {
	const calls: string[] = [];
	const deletedGroups: string[] = [];
	const deletedResources = new Set<string>();
	const az = async (args: readonly string[], operation: string) => {
		calls.push(operation);
		const line = args.join(" ");
		if (line.startsWith("group list --query [?tags.")) return [{ id: "/g", name: `${EXPIRED_B}-rg` }];
		if (line.startsWith(`group show --name ${EXPIRED_B}-rg`))
			return {
				id: "/g",
				name: `${EXPIRED_B}-rg`,
				tags: { "atomic-distributed-test": EXPIRED_B, "atomic-distributed-test-expiry": "2026-11-04T00:00:00Z" },
			};
		if (line.startsWith("resource list --tag atomic-distributed-test --query"))
			return [
				{ id: "/stray-a", name: "stray-a", resourceGroup: "shared" },
				{ id: "/stray-c", name: "stray-c", resourceGroup: "shared" },
			];
		if (line.startsWith("resource show --ids /stray-a"))
			return { "atomic-distributed-test": EXPIRED_A, "atomic-distributed-test-expiry": "2026-11-04T00:00:00Z" };
		if (line.startsWith("resource show --ids /stray-c"))
			return { "atomic-distributed-test": EXPIRED_A, "atomic-distributed-test-expiry": "2026-11-04T00:00:00Z" };
		if (args[0] === "resource" && args[1] === "delete") {
			const id = args[args.indexOf("--ids") + 1];
			if (failDeleteOf.includes(id)) throw failure(id);
			deletedResources.add(id);
			return null;
		}
		if (line.startsWith("group delete")) {
			deletedGroups.push(args[args.indexOf("--name") + 1]);
			return null;
		}
		if (line.startsWith("group exists")) return args[3] === `${EXPIRED_B}-rg` && !deletedGroups.includes(args[3]);
		if (line.startsWith("resource list --tag"))
			return [...["/stray-a", "/stray-c"]].filter((id) => !deletedResources.has(id));
		return [];
	};
	return { az, calls, deletedGroups, deletedResources };
}

const run = (az: ReturnType<typeof fakeAzure>["az"]) => {
	let elapsedMs = 0;
	return sweep({
		az,
		control,
		now: new Date("2026-11-05T12:00:00Z"),
		force: false,
		dryRun: false,
		sleep: async (ms) => {
			elapsedMs += ms;
		},
		clock: () => elapsedMs,
		log: () => {},
	});
};

test("a failed straggler deletion does not stop the other deletions or any run teardown, and is reported", async () => {
	const fake = fakeAzure(
		["/stray-a"],
		(id) => new DistributedCommandError({ tool: "az", operation: `delete ${id}`, exitCode: 1, signal: null }),
	);

	const result = await run(fake.az);

	assert.deepEqual([...fake.deletedResources], ["/stray-c"], "the deletion after the failing one still ran");
	assert.deepEqual(fake.deletedGroups, [`${EXPIRED_B}-rg`], "the expired run group was still torn down");
	assert.deepEqual(result.runs.map((entry) => entry.runId).sort(), [EXPIRED_A, EXPIRED_B]);
	assert.equal(result.deleteFailures.length, 1);
	assert.equal(result.deleteFailures[0].id, "/stray-a");
	assert.equal(result.deleteFailures[0].runId, EXPIRED_A);
	assert.equal(result.deleteFailures[0].error.name, "DistributedCommandError");
	assert.equal(result.deleteFailures[0].error.code, "command-failed");
	assert.equal(result.deleteFailures[0].error.fields.operation, "delete /stray-a");
});

test("a sweep with no deletion failure reports none", async () => {
	const fake = fakeAzure([], () => new Error("unused"));

	const result = await run(fake.az);

	assert.deepEqual(result.deleteFailures, []);
	assert.deepEqual([...fake.deletedResources].sort(), ["/stray-a", "/stray-c"]);
});

test("a cancelled deletion is not collected as a failure", async () => {
	const cancelled = Object.assign(new Error("aborted"), { name: "AbortError" });
	const fake = fakeAzure(["/stray-a"], () => cancelled);

	await assert.rejects(run(fake.az), (error) => error === cancelled);
	assert.deepEqual(fake.deletedGroups, []);
});

test("a dry run reports no deletion failures and deletes nothing", async () => {
	const fake = fakeAzure([], () => new Error("unused"));

	const result = await sweep({
		az: fake.az,
		control,
		now: new Date("2026-11-05T12:00:00Z"),
		force: false,
		dryRun: true,
		sleep: async () => {},
		clock: () => 0,
		log: () => {},
	});

	assert.deepEqual(result.deleteFailures, []);
	assert.equal(fake.deletedResources.size, 0);
});

test("the sweeper exits nonzero for any failed deletion or run", () => {
	assert.equal(sweepExitCode({ runs: [], deleteFailures: [] }), 0);
	assert.equal(sweepExitCode({ runs: [{ ok: true }, { ok: true }], deleteFailures: [] }), 0);
	assert.equal(sweepExitCode({ runs: [{ ok: true }, { ok: false }], deleteFailures: [] }), 1);
	assert.equal(sweepExitCode({ runs: [{ ok: true }], deleteFailures: [{ id: "resource-a" }] }), 1);
	assert.equal(sweepExitCode({ runs: [], deleteFailures: [{ id: "resource-a" }] }), 1);
	assert.equal(sweepExitCode({ runs: [{ ok: false }], deleteFailures: [{ id: "resource-a" }] }), 1);
});
