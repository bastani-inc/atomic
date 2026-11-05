import assert from "node:assert/strict";
import { test } from "vitest";
import { isDistributedTeardownError } from "../distributed/harness/errors.mjs";
import {
	classifyExpiry,
	EXPIRY_TAG,
	networkNames,
	planSweep,
	RUN_TAG,
	remainingFromQueries,
	runIdOfName,
	runTags,
	tagArguments,
} from "../distributed/harness/ownership.mjs";
import { absenceQueries, teardownRun } from "../distributed/harness/teardown.mjs";

const RUN = "adt2611050230-beef";
const OTHER = "adt2611050230-0001";
const NOW = new Date("2026-11-05T12:00:00Z");
const control = { resourceGroup: "control-rg", vnet: "control-vnet" };
const tagged = (name: string, runId: string | undefined, expiresAt: string | undefined) => ({
	id: `/subscriptions/s/resourceGroups/${name}`,
	name,
	tags: {
		...(runId === undefined ? {} : { [RUN_TAG]: runId }),
		...(expiresAt === undefined ? {} : { [EXPIRY_TAG]: expiresAt }),
	},
});

test("tags and names carry the run id", () => {
	assert.deepEqual(runTags(RUN, "2026-11-05T08:30:00.000Z"), {
		"atomic-distributed-test": RUN,
		"atomic-distributed-test-expiry": "2026-11-05T08:30:00.000Z",
	});
	assert.deepEqual(tagArguments(runTags(RUN, "x")), [
		`atomic-distributed-test=${RUN}`,
		"atomic-distributed-test-expiry=x",
	]);
	const names = networkNames(RUN, "eastus2");
	assert.deepEqual(
		{ ...names, toRegion: names.toRegion("westus3") },
		{
			vnet: `${RUN}-eastus2-vnet`,
			subnet: `${RUN}-eastus2-snet`,
			nsg: `${RUN}-eastus2-nsg`,
			toControl: `${RUN}-eastus2-to-control`,
			fromControl: `${RUN}-eastus2-from-control`,
			toRegion: `${RUN}-eastus2-to-westus3`,
		},
	);
	assert.equal(runIdOfName(`${RUN}-eastus2-from-control`), RUN);
	assert.equal(runIdOfName(RUN), RUN);
	assert.equal(runIdOfName(`${RUN}x-eastus2`), undefined);
	assert.equal(runIdOfName("shared-runners-peer"), undefined);
	assert.equal(runIdOfName(`x${RUN}-a`), undefined);
});

test("classifies expiry strictly after the instant and never deletes without a parseable expiry", () => {
	assert.deepEqual(classifyExpiry(tagged("g", RUN, "2026-11-05T11:59:59Z"), NOW), {
		kind: "expired",
		runId: RUN,
		expiresAt: "2026-11-05T11:59:59Z",
	});
	assert.equal(classifyExpiry(tagged("g", RUN, "2026-11-05T12:00:00Z"), NOW).kind, "unexpired");
	assert.equal(classifyExpiry(tagged("g", RUN, "2026-11-05T12:00:00.000Z"), NOW).kind, "unexpired");
	assert.equal(classifyExpiry(tagged("g", RUN, "2026-11-05T11:59:59.999Z"), NOW).kind, "expired");
	assert.equal(classifyExpiry(tagged("g", RUN, "2026-11-05T12:00:01Z"), NOW).kind, "unexpired");
	assert.deepEqual(classifyExpiry(tagged("g", RUN, undefined), NOW), { kind: "missing-expiry", runId: RUN });
	for (const bad of [
		"tomorrow",
		"2026-11-05",
		"2026-11-05T11:00:00+00:00",
		"2026-13-45T99:99:99Z",
		" 2026-11-05T11:00:00Z",
	]) {
		assert.deepEqual(
			classifyExpiry(tagged("g", RUN, bad), NOW),
			{ kind: "malformed-expiry", runId: RUN, expiresAt: bad },
			bad,
		);
	}
	assert.deepEqual(classifyExpiry(tagged("g", undefined, "2020-01-01T00:00:00Z"), NOW), { kind: "foreign" });
	assert.deepEqual(classifyExpiry(tagged("g", "shared-runners", "2020-01-01T00:00:00Z"), NOW), { kind: "foreign" });
	assert.deepEqual(classifyExpiry({ id: "i", name: "n", tags: null }, NOW), { kind: "foreign" });
	assert.deepEqual(classifyExpiry({ id: "i", name: "n" }, NOW), { kind: "foreign" });
});

test("plans a sweep of expired runs, their stragglers and their control peerings only", () => {
	const plan = planSweep({
		groups: [
			tagged(`${RUN}-rg`, RUN, "2026-11-05T00:00:00Z"),
			tagged(`${OTHER}-rg`, OTHER, "2026-11-06T00:00:00Z"),
			tagged("shared-runners", undefined, undefined),
		],
		resources: [
			{
				id: "/r/in-expired-group",
				name: "a",
				resourceGroup: `${RUN}-RG`,
				tags: runTags(RUN, "2026-11-05T00:00:00Z"),
			},
			{
				id: "/r/straggler",
				name: "b",
				resourceGroup: "shared",
				tags: runTags("adt2611050230-0002", "2026-11-05T00:00:00Z"),
			},
			{
				id: "/r/fresh",
				name: "c",
				resourceGroup: "shared",
				tags: runTags("adt2611050230-0003", "2026-11-07T00:00:00Z"),
			},
			{ id: "/r/foreign", name: "d", resourceGroup: "shared", tags: { owner: "someone" } },
			{ id: "/r/no-expiry", name: "e", resourceGroup: "shared", tags: { [RUN_TAG]: "adt2611050230-0004" } },
		],
		controlPeerings: [
			{ name: `${RUN}-eastus2-from-control` },
			{ name: `${OTHER}-westus3-from-control` },
			{ name: "adt2611050230-0005-eastus2-from-control" },
			{ name: "adt2611050230-0006-eastus2-from-control" },
			{ name: "crabbox-peering" },
		],
		existingGroups: ["adt2611050230-0006-rg", "control-rg"],
		now: NOW,
	});
	assert.deepEqual(plan.groups, [{ name: `${RUN}-rg`, runId: RUN }]);
	assert.deepEqual(plan.resources, [{ id: "/r/straggler", runId: "adt2611050230-0002" }]);
	assert.deepEqual(plan.controlPeerings, [
		{ name: `${RUN}-eastus2-from-control`, runId: RUN },
		{ name: "adt2611050230-0005-eastus2-from-control", runId: "adt2611050230-0005" },
	]);
	assert.deepEqual(plan.kept, [
		{ subject: `${OTHER}-rg`, reason: "unexpired", runId: OTHER },
		{ subject: "/r/fresh", reason: "unexpired", runId: "adt2611050230-0003" },
		{ subject: "/r/no-expiry", reason: "missing-expiry", runId: "adt2611050230-0004" },
		{ subject: `${OTHER}-westus3-from-control`, reason: "group-unexpired", runId: OTHER },
		{ subject: "adt2611050230-0006-eastus2-from-control", reason: "group-unknown", runId: "adt2611050230-0006" },
	]);
});

test("limits a sweep to one run, and --force ignores only that run's TTL", () => {
	const input = {
		groups: [tagged(`${RUN}-rg`, RUN, "2026-11-06T00:00:00Z"), tagged(`${OTHER}-rg`, OTHER, "2026-11-01T00:00:00Z")],
		resources: [{ id: "/r/x", name: "x", resourceGroup: "shared", tags: runTags(RUN, "2026-11-06T00:00:00Z") }],
		controlPeerings: [{ name: `${RUN}-a` }, { name: `${OTHER}-a` }],
		existingGroups: [`${RUN}-rg`, `${OTHER}-rg`],
		now: NOW,
	};
	const unforced = planSweep({ ...input, onlyRunId: RUN });
	assert.deepEqual([unforced.groups, unforced.resources, unforced.controlPeerings], [[], [], []]);
	assert.deepEqual(
		unforced.kept.map((item) => item.reason),
		["unexpired", "unexpired", "group-unexpired"],
	);
	const forced = planSweep({ ...input, onlyRunId: RUN, force: true });
	assert.deepEqual(forced.groups, [{ name: `${RUN}-rg`, runId: RUN }]);
	assert.deepEqual(forced.resources, [{ id: "/r/x", runId: RUN }]);
	assert.deepEqual(forced.controlPeerings, [{ name: `${RUN}-a`, runId: RUN }]);
	const forceWithoutRun = planSweep({ ...input, force: true });
	assert.deepEqual(forceWithoutRun.groups, [{ name: `${OTHER}-rg`, runId: OTHER }]);
	assert.deepEqual(forceWithoutRun.controlPeerings, [{ name: `${OTHER}-a`, runId: OTHER }]);
});

test("names leftovers from absence query results", () => {
	assert.deepEqual(
		remainingFromQueries([{ result: ["/id/a", { id: "/id/b", name: "n" }, { name: "peer" }, 7] }, { result: [] }]),
		["/id/a", "/id/b", "peer", "7"],
	);
	assert.deepEqual(remainingFromQueries([{ result: [null] }]), ["null"]);
	assert.deepEqual(remainingFromQueries([]), []);
});

test("absence queries cover tags, groups, both peering sides and the run group", () => {
	assert.deepEqual(
		absenceQueries({ runId: RUN, resourceGroup: `${RUN}-rg`, control }).map((query) => [
			query.label,
			query.args.join(" "),
		]),
		[
			["tagged resources", `resource list --tag atomic-distributed-test=${RUN} --query [].id`],
			["tagged resource groups", `group list --tag atomic-distributed-test=${RUN} --query [].id`],
			[
				"control VNet peerings",
				`network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [?contains(name, '${RUN}')].name`,
			],
			["test VNets (both peering sides)", `network vnet list --query [?contains(name, '${RUN}')].id`],
			["run resource group", `group list --query [?name=='${RUN}-rg'].id`],
		],
	);
});

type Call = { args: readonly string[]; operation: string };
/** A scripted az: each handler matches a command prefix; unmatched commands return []. */
function fakeAz(handlers: [string, (call: Call, count: number) => unknown][]) {
	const calls: Call[] = [];
	const counts = new Map<string, number>();
	const az = async (args: readonly string[], operation: string) => {
		calls.push({ args, operation });
		const line = args.join(" ");
		for (const [prefix, handler] of handlers) {
			if (line.startsWith(prefix)) {
				const count = (counts.get(prefix) ?? 0) + 1;
				counts.set(prefix, count);
				const value = handler({ args, operation }, count);
				if (value instanceof Error) throw value;
				return value;
			}
		}
		return [];
	};
	return { az, calls };
}
const timing = () => {
	let clock = 0;
	return {
		sleep: async (ms: number) => {
			clock += ms;
		},
		now: () => clock,
	};
};

test("tears down control peerings and the group, then proves absence", async () => {
	const { az, calls } = fakeAz([
		[
			"network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].name",
			() => [`${RUN}-eastus2-from-control`, `${OTHER}-eastus2-from-control`, "unrelated"],
		],
		["group exists", () => true],
	]);
	const result = await teardownRun({
		az,
		runId: RUN,
		resourceGroup: `${RUN}-rg`,
		control,
		knownPeerings: [`${RUN}-westus3-from-control`],
		...timing(),
		deadlineMs: 60_000,
		pollMs: 1000,
	});
	assert.equal(result.ok, true);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.remaining, []);
	assert.deepEqual(
		calls.map((call) => call.operation),
		[
			"list control peerings",
			`delete control peering ${RUN}-westus3-from-control`,
			`delete control peering ${RUN}-eastus2-from-control`,
			"check resource group",
			`delete resource group ${RUN}-rg`,
			"absence query: tagged resources",
			"absence query: tagged resource groups",
			"absence query: control VNet peerings",
			"absence query: test VNets (both peering sides)",
			"absence query: run resource group",
		],
	);
	assert.deepEqual(calls[4].args, [
		"group",
		"delete",
		"--name",
		`${RUN}-rg`,
		"--yes",
		"--force-deletion-types",
		"Microsoft.Compute/virtualMachines",
	]);
	assert.deepEqual(
		result.queries.map((query) => [query.ok, query.result]),
		Array(5).fill([true, []]),
	);
	assert.equal(result.queries[0].command, `az resource list --tag "atomic-distributed-test=${RUN}" --query "[].id"`);
	assert.deepEqual(
		result.steps.map((step) => step.ok),
		[true, true, true, true, true],
	);
});

test("skips deleting an absent group and is idempotent", async () => {
	const { az, calls } = fakeAz([["group exists", () => false]]);
	const result = await teardownRun({
		az,
		runId: RUN,
		resourceGroup: `${RUN}-rg`,
		control,
		knownPeerings: [],
		...timing(),
		deadlineMs: 0,
		pollMs: 1,
	});
	assert.equal(result.ok, true);
	assert.ok(!calls.some((call) => call.args[1] === "delete"));
});

test("polls until eventual absence and reports leftovers after the deadline", async () => {
	const clock = timing();
	const slow = fakeAz([
		["group exists", () => true],
		["resource list", (_call, count) => (count < 3 ? [`/subscriptions/s/${RUN}/disk`] : [])],
	]);
	const settled = await teardownRun({
		az: slow.az,
		runId: RUN,
		resourceGroup: `${RUN}-rg`,
		control,
		knownPeerings: [],
		...clock,
		deadlineMs: 60_000,
		pollMs: 20_000,
	});
	assert.equal(settled.ok, true);
	assert.equal(slow.calls.filter((call) => call.operation === "absence query: tagged resources").length, 3);
	const stuck = fakeAz([
		["group exists", () => true],
		[
			"network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [?contains",
			() => [`${RUN}-eastus2-from-control`],
		],
	]);
	const left = await teardownRun({
		az: stuck.az,
		runId: RUN,
		resourceGroup: `${RUN}-rg`,
		control,
		knownPeerings: [],
		...timing(),
		deadlineMs: 40_000,
		pollMs: 20_000,
	});
	assert.equal(left.ok, false);
	assert.deepEqual(left.remaining, [`${RUN}-eastus2-from-control`]);
	assert.ok(isDistributedTeardownError(left.error));
	assert.equal(left.error?.code, "teardown-incomplete");
	assert.deepEqual(left.error?.fields, { runId: RUN, remaining: [`${RUN}-eastus2-from-control`] });
	assert.equal(left.error?.retryable, true);
	assert.equal(stuck.calls.filter((call) => call.operation === "absence query: control VNet peerings").length, 3);
});

test("continues past failures, never treats a failed query as absence, and keeps every failure", async () => {
	const boom = (what: string) =>
		Object.assign(new Error(what), { name: "DistributedCommandError", code: "command-failed" });
	const { az, calls } = fakeAz([
		[
			"network vnet peering list --resource-group control-rg --vnet-name control-vnet --query [].name",
			() => boom("list"),
		],
		["network vnet peering delete", () => boom("delete peering")],
		["group exists", () => true],
		["group delete", () => boom("delete group")],
		["network vnet list", () => boom("query")],
		["group list --query", () => "not a list"],
	]);
	const result = await teardownRun({
		az,
		runId: RUN,
		resourceGroup: `${RUN}-rg`,
		control,
		knownPeerings: [`${RUN}-a`],
		...timing(),
		deadlineMs: 0,
		pollMs: 1,
	});
	assert.equal(result.ok, false);
	assert.deepEqual(
		result.steps.map((step) => [step.operation, step.ok]),
		[
			["list control peerings", false],
			[`delete control peering ${RUN}-a`, false],
			["check resource group", true],
			[`delete resource group ${RUN}-rg`, false],
		],
	);
	assert.ok(calls.some((call) => call.operation === `delete resource group ${RUN}-rg`));
	const vnets = result.queries.find((query) => query.label === "test VNets (both peering sides)");
	assert.deepEqual(vnets, {
		label: "test VNets (both peering sides)",
		command: `az network vnet list --query "[?contains(name, '${RUN}')].id"`,
		ok: false,
		result: [],
	});
	assert.equal(result.queries.find((query) => query.label === "run resource group")?.ok, false);
	const error = result.error as unknown as { errors: Error[]; fields: { remaining: string[] } };
	assert.deepEqual(
		error.errors.map((item) => item.message),
		["list", "delete peering", "delete group", "query"],
	);
	assert.deepEqual(error.fields.remaining, [
		"not a list",
		"query failed: test VNets (both peering sides)",
		"query failed: run resource group",
	]);
});

test("a transient query failure that later clears does not fail teardown", async () => {
	const { az } = fakeAz([
		["group exists", () => false],
		["resource list", (_call, count) => (count === 1 ? new Error("throttled") : [])],
	]);
	const result = await teardownRun({
		az,
		runId: RUN,
		resourceGroup: `${RUN}-rg`,
		control,
		knownPeerings: [],
		...timing(),
		deadlineMs: 60_000,
		pollMs: 1000,
	});
	assert.equal(result.ok, true);
});

test("cancellation during teardown propagates as cancellation", async () => {
	const abort = new DOMException("stop", "AbortError");
	const { az } = fakeAz([["group exists", () => abort]]);
	await assert.rejects(
		teardownRun({
			az,
			runId: RUN,
			resourceGroup: `${RUN}-rg`,
			control,
			knownPeerings: [],
			...timing(),
			deadlineMs: 0,
			pollMs: 1,
		}),
		(error) => error === abort,
	);
	const queries = fakeAz([["resource list", () => abort]]);
	await assert.rejects(
		teardownRun({
			az: queries.az,
			runId: RUN,
			resourceGroup: `${RUN}-rg`,
			control,
			knownPeerings: [],
			...timing(),
			deadlineMs: 0,
			pollMs: 1,
		}),
		(error) => error === abort,
	);
});
