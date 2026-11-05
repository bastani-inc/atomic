import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { ADDRESS_ATTEMPTS, AzureRun } from "../distributed/harness/azure.mjs";
import { buildPlan, parseRunArgs, parseTopology, resolveRunOptions } from "../distributed/harness/config.mjs";
import {
	DistributedCommandError,
	isDistributedCommandError,
	isDistributedProvisionError,
} from "../distributed/harness/errors.mjs";
import { Manifest } from "../distributed/harness/manifest.mjs";
import {
	addressConflicts,
	allocateAddressSpaces,
	allocationSkip,
	cidrsOverlap,
} from "../distributed/harness/network.mjs";
import { EXPIRY_TAG, RUN_TAG } from "../distributed/harness/ownership.mjs";
import { removePathSync } from "../helpers/runtime.js";

const topology = parseTopology(
	JSON.parse(readFileSync(new URL("../distributed/topology.json", import.meta.url), "utf8")),
);
const control = { resourceGroup: "control-rg", vnet: "control-vnet", sshSourcePrefix: "10.20.1.0/24" };
const CONTROL_PREFIX = "10.20.0.0/16";
const directories: string[] = [];

afterEach(() => {
	for (const dir of directories.splice(0)) removePathSync(dir, { recursive: true, force: true });
});

function barrier(count: number) {
	let arrived = 0;
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return () => {
		arrived++;
		if (arrived >= count) open();
		return opened;
	};
}

function argAfter(args: readonly string[], flag: string): string {
	const index = args.indexOf(flag);
	assert.ok(index >= 0, `missing ${flag} in ${args.join(" ")}`);
	return args[index + 1];
}

type Gate = (runId: string, event: string, count: number) => Promise<void> | void;

class SimulatedCloud {
	readonly vnets = new Map<string, { id: string; prefix: string }>();
	readonly controlPeers = new Map<string, { remoteId: string; prefix: string | null }>();
	readonly created: { runId: string; vnet: string; prefix: string }[] = [];
	readonly deleted: { runId: string; kind: string; name: string }[] = [];
	private readonly counts = new Map<string, number>();
	constructor(
		readonly options: {
			enforce: boolean;
			gate?: Gate;
			rejectPeering?: (name: string) => boolean;
			failDelete?: boolean;
			abort?: { controller: AbortController; on: string; name?: string };
			nullWhenEmpty?: boolean;
		} = { enforce: true },
	) {}

	private aborted = false;

	async handle(runId: string, args: readonly string[], operation: string): Promise<unknown> {
		const command = args.slice(0, 4).join(" ");
		const event = command.startsWith("network vnet peering list")
			? "control peering list"
			: command.startsWith("network vnet list")
				? "vnet list"
				: command.startsWith("network vnet peering create") &&
						argAfter(args, "--resource-group") === control.resourceGroup
					? "control peering create"
					: command;
		const key = `${runId} ${event}`;
		const count = (this.counts.get(key) ?? 0) + 1;
		this.counts.set(key, count);
		await this.options.gate?.(runId, event, count);
		await Promise.resolve();
		const abort = this.options.abort;
		if (
			abort !== undefined &&
			!this.aborted &&
			command.startsWith(abort.on) &&
			(abort.name === undefined || argAfter(args, "--name").endsWith(abort.name))
		) {
			this.aborted = true;
			abort.controller.abort(new Error("cancelled by the operator"));
			throw abort.controller.signal.reason;
		}
		if (this.options.failDelete === true && args[3] === "delete")
			throw new DistributedCommandError({ tool: "az", operation, exitCode: 1, signal: null, detail: "throttled" });
		const empty = this.options.nullWhenEmpty === true ? null : [];
		if (event === "control peering list") {
			assert.equal(operation, "list control peerings");
			assert.equal(argAfter(args, "--resource-group"), control.resourceGroup);
			assert.equal(argAfter(args, "--vnet-name"), control.vnet);
			assert.equal(argAfter(args, "--query"), "[].{name:name,prefixes:remoteAddressSpace.addressPrefixes}");
			if (this.controlPeers.size === 0) return empty;
			return [...this.controlPeers].map(([name, peer]) => ({
				name,
				prefixes: peer.prefix === null ? null : [peer.prefix],
			}));
		}
		if (event === "vnet list") {
			if (this.vnets.size === 0) return empty;
			return [...this.vnets.values()].map((vnet) => [vnet.prefix]);
		}
		if (command === "network vnet peering create") {
			assert.equal(operation, `create VNet peering ${argAfter(args, "--name")}`);
			assert.equal(argAfter(args, "--allow-vnet-access"), "true");
			assert.equal(argAfter(args, "--allow-forwarded-traffic"), "false");
			if (event === "control peering create") assert.equal(argAfter(args, "--vnet-name"), control.vnet);
			else assert.match(argAfter(args, "--vnet-name"), new RegExp(`^${runId}-[a-z0-9]+-vnet$`));
		}
		if (args[3] === "delete")
			assert.equal(operation, `release conflicting address space ${argAfter(args, "--name")}`);
		if (command === "network vnet create --resource-group") {
			assert.equal(operation, `create VNet ${argAfter(args, "--name")}`);
			assert.ok(["eastus2", "westus3"].includes(argAfter(args, "--location")));
			assert.equal(argAfter(args, "--resource-group"), `${runId}-rg`);
			const tags = args.slice(args.indexOf("--tags") + 1);
			assert.ok(args.includes("--tags"));
			assert.ok(tags.includes(`${RUN_TAG}=${runId}`));
			assert.ok(tags.some((tag) => tag.startsWith(`${EXPIRY_TAG}=`)));
			assert.equal(args.includes("--subnet-name"), false);
			const name = argAfter(args, "--name");
			const prefix = argAfter(args, "--address-prefixes");
			const id = `/vnets/${name}`;
			this.vnets.set(name, { id, prefix });
			this.created.push({ runId, vnet: name, prefix });
			return { newVNet: { id } };
		}
		if (event === "control peering create") {
			const name = argAfter(args, "--name");
			const remoteId = argAfter(args, "--remote-vnet");
			const remote = [...this.vnets.values()].find((vnet) => vnet.id === remoteId);
			assert.ok(remote !== undefined, `peering ${name} to a missing VNet`);
			const overlapping = [...this.controlPeers.values()].some(
				(peer) => peer.prefix !== null && cidrsOverlap(peer.prefix, remote.prefix),
			);
			if ((this.options.enforce && overlapping) || this.options.rejectPeering?.(name) === true)
				throw new DistributedCommandError({
					tool: "az",
					operation,
					exitCode: 1,
					signal: null,
					detail: "(VnetAddressSpacesOverlap) remote address space overlaps",
				});
			this.controlPeers.set(name, { remoteId, prefix: remote.prefix });
			return {};
		}
		if (command === "network vnet peering delete") {
			assert.equal(argAfter(args, "--resource-group"), control.resourceGroup);
			assert.equal(argAfter(args, "--vnet-name"), control.vnet);
			const name = argAfter(args, "--name");
			this.controlPeers.delete(name);
			this.deleted.push({ runId, kind: "peering", name });
			return null;
		}
		if (command === "network vnet delete --resource-group") {
			assert.equal(argAfter(args, "--resource-group"), `${runId}-rg`);
			const name = argAfter(args, "--name");
			this.vnets.delete(name);
			this.deleted.push({ runId, kind: "vnet", name });
			return null;
		}
		return {};
	}
}

class SimulatedRun extends AzureRun {
	cloud!: SimulatedCloud;
	override az<T>(args: readonly string[], operation: string): Promise<T> {
		return this.cloud.handle(this.plan.runId, args, operation) as Promise<T>;
	}
}

function simulatedRun(cloud: SimulatedCloud, runId: string, signal?: AbortSignal, runTopology = topology) {
	const dir = mkdtempSync(join(tmpdir(), "adt-claim-"));
	directories.push(dir);
	const options = resolveRunOptions(parseRunArgs(["--ref", "main"]), topology, { randomSeed: 1 });
	const plan = buildPlan(options, topology, { runId, now: new Date("2026-11-05T02:30:00Z") });
	const manifest = new Manifest(dir, {
		runId,
		resourceGroup: plan.resourceGroup,
		expiresAt: plan.expiresAt,
		subscription: "s",
		control,
		entries: [],
	});
	const run = new SimulatedRun({
		context: { secrets: new Set<string>() },
		plan,
		topology: runTopology,
		manifest,
		control,
		controlVnetId: "/vnets/control",
		controlPrefixes: [CONTROL_PREFIX],
		sshPublicKey: "/k.pub",
		signal,
	});
	run.cloud = cloud;
	return { run, plan, dir };
}

function assertDisjointClaims(cloud: SimulatedCloud, runIds: readonly string[], regions: number) {
	const byRun = runIds.map((runId) =>
		[...cloud.controlPeers]
			.filter(([name]) => name.startsWith(`${runId}-`))
			.flatMap(([, peer]) => (peer.prefix === null ? [] : [peer.prefix])),
	);
	for (const prefixes of byRun) assert.equal(prefixes.length, regions);
	const all = byRun.flat();
	for (const [index, prefix] of all.entries())
		for (const other of all.slice(index + 1)) assert.ok(!cidrsOverlap(prefix, other), `${prefix} overlaps ${other}`);
	for (const [index, runId] of runIds.entries()) {
		const vnets = [...cloud.vnets].filter(([name]) => name.startsWith(`${runId}-`)).map(([, vnet]) => vnet.prefix);
		assert.deepEqual(vnets.sort(), [...byRun[index]].sort());
	}
	return byRun;
}

test("allocation passes over `skip` free /16s, wrapping within the room left", () => {
	const used = [CONTROL_PREFIX, "10.61.0.0/16"];
	const small = { firstSecondOctet: 60, lastSecondOctet: 64 };
	assert.deepEqual(
		[...(allocateAddressSpaces(["a", "b"], used, small, 0) ?? [])],
		[
			["a", "10.60.0.0/16"],
			["b", "10.62.0.0/16"],
		],
	);
	assert.deepEqual(
		[...(allocateAddressSpaces(["a", "b"], used, small, 1) ?? [])],
		[
			["a", "10.62.0.0/16"],
			["b", "10.63.0.0/16"],
		],
	);
	assert.deepEqual(
		[...(allocateAddressSpaces(["a", "b"], used, small, 2) ?? [])],
		[
			["a", "10.63.0.0/16"],
			["b", "10.64.0.0/16"],
		],
	);
	assert.deepEqual(
		[...(allocateAddressSpaces(["a", "b"], used, small, 3) ?? [])],
		[
			["a", "10.60.0.0/16"],
			["b", "10.62.0.0/16"],
		],
	);
	assert.deepEqual(
		[...(allocateAddressSpaces(["a"], [], { firstSecondOctet: 60, lastSecondOctet: 60 }, 7) ?? [])],
		[["a", "10.60.0.0/16"]],
	);
});

test("the first attempt never skips and retries skip by a run-specific amount", () => {
	assert.equal(allocationSkip("adt2611050230-aaaa", 1), 0);
	assert.equal(allocationSkip("adt2611050230-aaaa", 0), 0);
	const a = allocationSkip("adt2611050230-aaaa", 2);
	assert.equal(a, allocationSkip("adt2611050230-aaaa", 2));
	assert.notEqual(a, allocationSkip("adt2611050230-bbbb", 2));
	assert.notEqual(a, allocationSkip("adt2611050230-aaaa", 3));
	assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xffffffff);
	assert.equal(allocationSkip("x", 2), 0x860177ef);
});

test("address conflicts list other peerings that overlap an allocated prefix", () => {
	const allocated = new Map([
		["eastus2", "10.60.0.0/16"],
		["westus3", "10.61.0.0/16"],
	]);
	const peers = [
		{ name: "run-a-eastus2-from-control", prefixes: ["10.60.0.0/16"] },
		{ name: "other-run", prefixes: ["10.70.0.0/16", "10.61.4.0/24"] },
		{ name: "no-space", prefixes: null },
		{ name: "elsewhere", prefixes: ["10.62.0.0/16"] },
	];
	assert.deepEqual(addressConflicts(allocated, peers, ["run-a-eastus2-from-control"]), [
		{ region: "westus3", prefix: "10.61.0.0/16", peering: "other-run", remotePrefix: "10.61.4.0/24" },
	]);
	assert.deepEqual(addressConflicts(allocated, peers, []), [
		{
			region: "eastus2",
			prefix: "10.60.0.0/16",
			peering: "run-a-eastus2-from-control",
			remotePrefix: "10.60.0.0/16",
		},
		{ region: "westus3", prefix: "10.61.0.0/16", peering: "other-run", remotePrefix: "10.61.4.0/24" },
	]);
	assert.deepEqual(addressConflicts(new Map(), peers, []), []);
});

test("two runs that observed the same free prefixes end on disjoint address spaces (#4331)", async () => {
	const listed = barrier(2);
	const cloud = new SimulatedCloud({
		enforce: true,
		gate: (_runId, event, count) => (event === "vnet list" && count === 1 ? listed() : undefined),
	});
	const a = simulatedRun(cloud, "adt2611050230-aaaa");
	const b = simulatedRun(cloud, "adt2611050230-bbbb");
	const regions = a.plan.vnetRegions.length;
	assert.ok(regions >= 1);
	await Promise.all([a.run.createNetworks(), b.run.createNetworks()]);

	const firsts = [a, b].map(({ plan }) =>
		cloud.created
			.filter((entry) => entry.runId === plan.runId)
			.slice(0, regions)
			.map((entry) => entry.prefix),
	);
	assert.deepEqual(firsts[0], firsts[1], "both runs first chose the same prefixes");
	assertDisjointClaims(cloud, [a.plan.runId, b.plan.runId], regions);
	for (const { run } of [a, b]) {
		for (const network of run.networks.values())
			assert.equal(cloud.vnets.get(network.names.vnet)?.prefix, network.prefix);
	}
	assert.ok(cloud.deleted.some((entry) => entry.kind === "vnet"));
	for (const { plan, dir } of [a, b]) {
		const entries = Manifest.load(dir).data.entries;
		for (const region of plan.vnetRegions) {
			assert.ok(
				entries.some(
					(entry) =>
						entry.kind === "vnet" && entry.name === `${plan.runId}-${region}-vnet` && entry.state === "created",
				),
			);
			assert.ok(
				entries.some(
					(entry) =>
						entry.kind === "peering" &&
						entry.name === `${plan.runId}-${region}-from-control` &&
						entry.scope === "control-rg/control-vnet" &&
						entry.state === "created",
				),
			);
		}
	}
});

test("when overlapping control peerings are both accepted, the runs never both keep the range (#4331)", async () => {
	const checked = barrier(2);
	const cloud = new SimulatedCloud({
		enforce: false,
		gate: (_runId, event, count) => (event === "control peering list" && count === 2 ? checked() : undefined),
	});
	const a = simulatedRun(cloud, "adt2611050230-aaaa");
	const b = simulatedRun(cloud, "adt2611050230-bbbb");
	const regions = a.plan.vnetRegions.length;
	await Promise.all([a.run.createNetworks(), b.run.createNetworks()]);
	assertDisjointClaims(cloud, [a.plan.runId, b.plan.runId], regions);
	for (const { plan } of [a, b])
		assert.equal(
			cloud.deleted.filter((entry) => entry.runId === plan.runId && entry.kind === "peering").length,
			regions,
			"each run deleted the control peerings it yielded",
		);
});

test("a run that loses every attempt fails typed and leaves no claim behind", async () => {
	const cloud = new SimulatedCloud({
		enforce: false,
		gate: (runId, event) => {
			if (event !== "control peering list" || cloud.controlPeers.size === 0) return;
			for (const [name, peer] of [...cloud.controlPeers])
				if (name.startsWith(runId)) cloud.controlPeers.set(`intruder-${name}`, { ...peer });
		},
	});
	const { run, plan, dir } = simulatedRun(cloud, "adt2611050230-aaaa");
	let detail = "";
	await assert.rejects(run.createNetworks(), (error) => {
		assert.ok(isDistributedProvisionError(error));
		const fields = Reflect.get(error as object, "fields");
		assert.equal(fields.step, "allocate address space");
		assert.equal(fields.resource, "10.60.0.0-10.255.255.255 pool");
		detail = fields.detail;
		return true;
	});
	const ownCreates = cloud.created.filter((entry) => entry.runId === plan.runId);
	const match = /^concurrent runs took (.+) on all (\d+) attempts$/.exec(detail);
	assert.ok(match !== null, detail);
	assert.equal(Number(match[2]), ADDRESS_ATTEMPTS);
	assert.deepEqual(match[1].split(", ").sort(), ownCreates.map((entry) => entry.prefix).sort());
	const entries = Manifest.load(dir).data.entries;
	for (const region of plan.vnetRegions)
		for (const [kind, name] of [
			["vnet", `${plan.runId}-${region}-vnet`],
			["peering", `${plan.runId}-${region}-from-control`],
		])
			assert.equal(entries.find((entry) => entry.kind === kind && entry.name === name)?.state, "deleted", name);
	assert.equal(ownCreates.length, ADDRESS_ATTEMPTS * plan.vnetRegions.length);
	assert.equal(
		new Set(ownCreates.map((entry) => entry.prefix)).size,
		ownCreates.length,
		"never retried a lost prefix",
	);
	assert.deepEqual(
		[...cloud.controlPeers.keys()].filter((name) => name.startsWith(plan.runId)),
		[],
	);
	assert.deepEqual(
		[...cloud.vnets.keys()].filter((name) => name.startsWith(plan.runId)),
		[],
	);
});

test("a rejected control peering without an overlap is rethrown, not retried", async () => {
	const cloud = new SimulatedCloud({ enforce: true, rejectPeering: () => true });
	const { run, plan } = simulatedRun(cloud, "adt2611050230-aaaa");
	await assert.rejects(run.createNetworks(), (error) => {
		assert.ok(isDistributedProvisionError(error));
		const fields = Reflect.get(error as object, "fields");
		assert.equal(fields.step, "create VNet peering");
		assert.equal(fields.resource, `${plan.runId}-${plan.vnetRegions[0]}-from-control`);
		assert.ok(isDistributedCommandError(Reflect.get(error as object, "cause")));
		const others = Reflect.get(error as object, "concurrentFailures");
		assert.equal(others.length, plan.vnetRegions.length - 1);
		assert.equal(Reflect.get(others[0], "fields").resource, `${plan.runId}-${plan.vnetRegions[1]}-from-control`);
		return true;
	});
	assert.equal(cloud.created.length, plan.vnetRegions.length);
	assert.deepEqual(cloud.deleted, []);
});

function intrudeOn(cloud: () => SimulatedCloud, region: string): Gate {
	return (runId, event, count) => {
		if (event !== "control peering list" || count !== 2) return;
		const prefix = cloud().vnets.get(`${runId}-${region}-vnet`)?.prefix;
		assert.ok(prefix !== undefined);
		cloud().controlPeers.set(`intruder-${region}`, { remoteId: "/vnets/intruder", prefix });
	};
}

test("a non-overlap peering failure beside a conflict in another region is rethrown, not retried", async () => {
	const cloud: SimulatedCloud = new SimulatedCloud({
		enforce: false,
		gate: intrudeOn(() => cloud, "eastus2"),
		rejectPeering: (name) => name.endsWith("-westus3-from-control"),
	});
	const { run, plan } = simulatedRun(cloud, "adt2611050230-aaaa");
	await assert.rejects(run.createNetworks(), (error) => {
		assert.ok(isDistributedProvisionError(error));
		const fields = Reflect.get(error as object, "fields");
		assert.equal(fields.step, "create VNet peering");
		assert.equal(fields.resource, `${plan.runId}-westus3-from-control`);
		return true;
	});
	assert.equal(cloud.created.length, plan.vnetRegions.length);
	assert.deepEqual(cloud.deleted, []);
});

test("a conflict whose own peering was rejected releases only the VNet and then succeeds", async () => {
	const cloud: SimulatedCloud = new SimulatedCloud({
		enforce: true,
		gate: (_runId, event, count) => {
			if (event === "control peering create" && count === 1)
				cloud.controlPeers.set("intruder", { remoteId: "/vnets/intruder", prefix: "10.60.0.0/16" });
		},
	});
	const { run, plan } = simulatedRun(cloud, "adt2611050230-aaaa");
	await run.createNetworks();
	assert.deepEqual(
		cloud.deleted.map((entry) => `${entry.kind} ${entry.name}`).sort(),
		[
			`vnet ${plan.runId}-eastus2-vnet`,
			`peering ${plan.runId}-westus3-from-control`,
			`vnet ${plan.runId}-westus3-vnet`,
		].sort(),
	);
	const prefixes = [...run.networks.values()].map((network) => network.prefix);
	assert.ok(!prefixes.includes("10.60.0.0/16"));
	assertDisjointClaims(cloud, [plan.runId], plan.vnetRegions.length);
});

test("a failed release of a lost claim is typed and stops the run", async () => {
	const cloud: SimulatedCloud = new SimulatedCloud({
		enforce: false,
		gate: intrudeOn(() => cloud, "eastus2"),
		failDelete: true,
	});
	const { run, plan, dir } = simulatedRun(cloud, "adt2611050230-aaaa");
	await assert.rejects(run.createNetworks(), (error) => {
		assert.ok(isDistributedProvisionError(error));
		const fields = Reflect.get(error as object, "fields");
		assert.equal(fields.step, "release conflicting address space");
		assert.match(fields.resource, new RegExp(`^${plan.runId}-(eastus2|westus3)-from-control$`));
		assert.ok(isDistributedCommandError(Reflect.get(error as object, "cause")));
		return true;
	});
	assert.equal(cloud.created.length, plan.vnetRegions.length);
	const peerings = Manifest.load(dir).data.entries.filter((entry) => entry.kind === "peering");
	assert.ok(peerings.length > 0 && peerings.every((entry) => entry.state === "created"));
});

for (const on of ["network vnet peering create", "network vnet peering delete", "network vnet delete"])
	test(`cancellation during "${on}" while claiming reaches the caller unwrapped`, async () => {
		const controller = new AbortController();
		const cloud: SimulatedCloud = new SimulatedCloud({
			enforce: false,
			gate: intrudeOn(() => cloud, "eastus2"),
			abort: { controller, on },
		});
		const { run } = simulatedRun(cloud, "adt2611050230-aaaa", controller.signal);
		await assert.rejects(run.createNetworks(), (error) => {
			assert.equal(error, controller.signal.reason);
			return true;
		});
	});

test("allocation skips foreign control peers and other runs' unpeered VNets, and tolerates missing address spaces", async () => {
	const cloud = new SimulatedCloud({ enforce: true });
	cloud.controlPeers.set("foreign", { remoteId: "/vnets/foreign", prefix: "10.60.0.0/16" });
	cloud.controlPeers.set("foreign-unknown-space", { remoteId: "/vnets/unknown", prefix: null });
	cloud.vnets.set("other-run-vnet", { id: "/vnets/other-run-vnet", prefix: "10.61.0.0/16" });
	const { run, plan } = simulatedRun(cloud, "adt2611050230-aaaa");
	await run.createNetworks();
	assert.deepEqual(
		cloud.created.map((entry) => [entry.vnet, entry.prefix]),
		[
			[`${plan.runId}-eastus2-vnet`, "10.62.0.0/16"],
			[`${plan.runId}-westus3-vnet`, "10.63.0.0/16"],
		],
	);
	assert.deepEqual(cloud.deleted, []);
});

test("empty listings that az prints as nothing allocate from the start of the pool", async () => {
	const cloud = new SimulatedCloud({ enforce: true, nullWhenEmpty: true });
	const { run } = simulatedRun(cloud, "adt2611050230-aaaa");
	await run.createNetworks();
	assert.deepEqual([...run.networks.values()].map((network) => network.prefix).sort(), [
		"10.60.0.0/16",
		"10.61.0.0/16",
	]);
});

test("a pool with too few free /16s fails typed before any VNet is created", async () => {
	const cloud = new SimulatedCloud({ enforce: true });
	cloud.controlPeers.set("foreign", { remoteId: "/vnets/foreign", prefix: "10.61.0.0/16" });
	const narrow = { ...topology, addressPool: { firstSecondOctet: 60, lastSecondOctet: 61 } };
	const { run } = simulatedRun(cloud, "adt2611050230-aaaa", undefined, narrow);
	await assert.rejects(run.createNetworks(), (error) => {
		assert.ok(isDistributedProvisionError(error));
		assert.deepEqual(Reflect.get(error as object, "fields"), {
			step: "allocate address space",
			resource: "10.60.0.0-10.61.255.255 pool",
			detail: "no free /16 left in the pool",
		});
		assert.equal(Reflect.get(error as object, "cause"), undefined);
		return true;
	});
	assert.deepEqual(cloud.created, []);
});

test("cancellation of a claim's peering is not mistaken for a lost address space", async () => {
	const controller = new AbortController();
	const cloud: SimulatedCloud = new SimulatedCloud({
		enforce: false,
		gate: (runId, event, count) => {
			intrudeOn(() => cloud, "eastus2")(runId, event, count);
			intrudeOn(() => cloud, "westus3")(runId, event, count);
		},
		abort: { controller, on: "network vnet peering create", name: "-eastus2-from-control" },
	});
	const { run } = simulatedRun(cloud, "adt2611050230-aaaa", controller.signal);
	await assert.rejects(run.createNetworks(), (error) => {
		assert.equal(error, controller.signal.reason);
		return true;
	});
	assert.equal(cloud.created.length, 2);
	assert.deepEqual(cloud.deleted, []);
});
