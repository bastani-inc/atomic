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

const run = (az: (args: readonly string[], operation: string) => Promise<unknown>) => {
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

test("a failed straggler deletion does not stop the other deletions or any run teardown, and is reported (#4331)", async () => {
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

test("a sweep with no deletion failure reports none (#4331)", async () => {
	const fake = fakeAzure([], () => new Error("unused"));

	const result = await run(fake.az);

	assert.deepEqual(result.deleteFailures, []);
	assert.deepEqual([...fake.deletedResources].sort(), ["/stray-a", "/stray-c"]);
});

test("a cancelled deletion is not collected as a failure (#4331)", async () => {
	const cancelled = Object.assign(new Error("aborted"), { name: "AbortError" });
	const fake = fakeAzure(["/stray-a"], () => cancelled);

	await assert.rejects(run(fake.az), (error) => error === cancelled);
	assert.deepEqual(fake.deletedGroups, []);
});

test("a dry run reports no deletion failures and deletes nothing (#4331)", async () => {
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

test("the sweeper exits nonzero for any failed deletion or run (#4331)", () => {
	assert.equal(sweepExitCode({ runs: [], deleteFailures: [] }), 0);
	assert.equal(sweepExitCode({ runs: [{ ok: true }, { ok: true }], deleteFailures: [] }), 0);
	assert.equal(sweepExitCode({ runs: [{ ok: true }, { ok: false }], deleteFailures: [] }), 1);
	assert.equal(sweepExitCode({ runs: [{ ok: true }], deleteFailures: [{ id: "resource-a" }] }), 1);
	assert.equal(sweepExitCode({ runs: [], deleteFailures: [{ id: "resource-a" }] }), 1);
	assert.equal(sweepExitCode({ runs: [{ ok: false }], deleteFailures: [{ id: "resource-a" }] }), 1);
});

const LIVE = "adt2611050230-0003";

function liveGroupWithExpiredStray(options: {
	groupTagged: boolean;
	groupInFullListing?: boolean;
	failStrayDelete?: unknown;
}) {
	const calls: string[][] = [];
	const az = async (args: readonly string[], _operation: string) => {
		calls.push([...args]);
		const line = args.join(" ");
		if (line.startsWith("group list --query [?tags."))
			return options.groupTagged ? [{ id: "/live-group", name: `${LIVE}-rg` }] : [];
		if (line.startsWith(`group show --name ${LIVE}-rg`))
			return {
				id: "/live-group",
				name: `${LIVE}-rg`,
				tags: { "atomic-distributed-test": LIVE, "atomic-distributed-test-expiry": "2026-11-06T00:00:00Z" },
			};
		if (line.startsWith("resource list --tag atomic-distributed-test --query"))
			return [{ id: "/moved-disk", name: "moved-disk", resourceGroup: "shared" }];
		if (line.startsWith("resource show --ids /moved-disk"))
			return { "atomic-distributed-test": LIVE, "atomic-distributed-test-expiry": "2026-11-04T00:00:00Z" };
		if (line.startsWith("network vnet peering list"))
			return line.endsWith("[].name")
				? [`${LIVE}-eastus2-from-control`]
				: [{ name: `${LIVE}-eastus2-from-control` }];
		if (line === `group exists --name ${LIVE}-rg`) return true;
		if (line === "group list --query [].name")
			return options.groupInFullListing === false ? ["shared"] : [`${LIVE}-rg`, "shared"];
		if (line.startsWith("resource delete") && options.failStrayDelete !== undefined) throw options.failStrayDelete;
		return null;
	};
	return { az, calls };
}

const mutations = (calls: readonly string[][]) =>
	calls.filter((args) => args.includes("delete")).map((args) => args.join(" "));

for (const groupTagged of [true, false]) {
	test(`an expired stray resource of a run whose group is still present ${groupTagged ? "and unexpired" : "but unlisted"} deletes only that resource (#4331)`, async () => {
		const fake = liveGroupWithExpiredStray({ groupTagged });

		const result = await run(fake.az);

		assert.deepEqual(mutations(fake.calls), ["resource delete --ids /moved-disk"]);
		assert.deepEqual(result.plan.resources, [{ id: "/moved-disk", runId: LIVE }]);
		assert.deepEqual(result.plan.groups, []);
		assert.deepEqual(result.plan.controlPeerings, []);
		assert.deepEqual(result.runs, [], "the run that still owns a present group is not torn down");
		assert.deepEqual(result.deleteFailures, []);
		assert.equal(sweepExitCode(result), 0);
	});
}

test("a live tagged group missing from a stale full group listing still keeps its run (#4331)", async () => {
	const fake = liveGroupWithExpiredStray({ groupTagged: true, groupInFullListing: false });

	const result = await run(fake.az);

	assert.deepEqual(mutations(fake.calls), ["resource delete --ids /moved-disk"]);
	assert.deepEqual(result.runs, []);
});

test("a cancelled stray deletion of a run with a live group propagates without touching the group (#4331)", async () => {
	const cancelled = Object.assign(new Error("aborted"), { name: "AbortError" });
	const fake = liveGroupWithExpiredStray({ groupTagged: true, failStrayDelete: cancelled });

	await assert.rejects(run(fake.az), (error) => error === cancelled);
	assert.deepEqual(mutations(fake.calls), ["resource delete --ids /moved-disk"]);
});
