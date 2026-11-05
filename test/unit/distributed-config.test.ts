import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
	buildPlan,
	CHAOS_PROFILES,
	newRunId,
	parseControlEnv,
	parseRunArgs,
	parseTopology,
	RUN_ID_PATTERN,
	resolveRunOptions,
	SUITES,
} from "../distributed/harness/config.mjs";
import {
	DistributedConfigError,
	isDistributedConfigError,
	isDistributedPrerequisiteError,
} from "../distributed/harness/errors.mjs";

const topologyJson = JSON.parse(readFileSync(new URL("../distributed/topology.json", import.meta.url), "utf8"));
const topology = parseTopology(topologyJson);
const NOW = new Date("2026-11-05T02:30:00Z");

/** Captures the typed configuration error a call throws. */
function configError(action: () => unknown): DistributedConfigError {
	try {
		action();
	} catch (error) {
		assert.ok(isDistributedConfigError(error), `expected DistributedConfigError, got ${String(error)}`);
		assert.ok(error instanceof DistributedConfigError);
		return error;
	}
	assert.fail("expected a DistributedConfigError");
}

const options = (argv: string[], replay = {}) =>
	resolveRunOptions(parseRunArgs(argv), topology, { randomSeed: 7, replay });

test("parses the issue's CLI form verbatim", () => {
	const args = parseRunArgs([
		"--ref",
		"main",
		"--suite",
		"smoke",
		"--nodes",
		"3",
		"--regions",
		"eastus2,westus3",
		"--chaos",
		"smoke",
		"--keep",
	]);
	assert.deepEqual(args, {
		keep: true,
		planOnly: false,
		help: false,
		ref: "main",
		suite: "smoke",
		nodes: "3",
		regions: "eastus2,westus3",
		chaos: "smoke",
	});
	assert.deepEqual(parseRunArgs(["--plan-only", "--help"]), { keep: false, planOnly: true, help: true });
	assert.deepEqual(parseRunArgs([]), { keep: false, planOnly: false, help: false });
	assert.equal(parseRunArgs(["--reuse", "adt2611050230-beef"]).reuse, "adt2611050230-beef");
	const all = parseRunArgs([
		"--seed",
		"1",
		"--ttl-hours",
		"2",
		"--topology",
		"t.json",
		"--db-storage",
		"local-nvme",
		"--db-region",
		"centralus",
		"--out",
		"o",
		"--builder",
		"b",
		"--artifact",
		"a",
		"--replay",
		"r",
	]);
	assert.deepEqual(all, {
		keep: false,
		planOnly: false,
		help: false,
		seed: "1",
		ttlHours: "2",
		topology: "t.json",
		dbStorage: "local-nvme",
		dbRegion: "centralus",
		out: "o",
		builder: "b",
		artifact: "a",
		replay: "r",
	});
});

test("rejects unknown flags and missing values before any side effect", () => {
	const unknown = configError(() => parseRunArgs(["--ref", "main", "--nope"]));
	assert.equal(unknown.code, "invalid-config");
	assert.deepEqual(unknown.fields, {
		source: "cli",
		field: "--nope",
		reason: "unknown-flag",
		expected: "a documented flag (see --help)",
		actual: "--nope",
	});
	assert.equal(unknown.hint, "Remove --nope; expected a documented flag (see --help).");
	assert.equal(configError(() => parseRunArgs(["--ref"])).fields.reason, "missing-value");
	assert.equal(configError(() => parseRunArgs(["--ref", "--keep"])).fields.reason, "missing-value");
	assert.equal(configError(() => parseRunArgs(["--toString", "x"])).fields.reason, "unknown-flag");
	assert.equal(configError(() => parseRunArgs(["hasOwnProperty"])).fields.reason, "unknown-flag");
});

test("renders one configuration error message as a UX contract", () => {
	const error = configError(() => options(["--ref", "main", "--nodes", "0"]));
	assert.equal(
		error.message,
		"Invalid distributed-test configuration: cli --nodes is invalid-value (invalid-config). Set --nodes to a positive integer.",
	);
	assert.equal(error.hint, "Set --nodes to a positive integer.");
	assert.equal(error.retryable, false);
	assert.equal(error.name, "DistributedConfigError");
});

test("resolves defaults from the topology and keeps values verbatim", () => {
	const resolved = options(["--ref", "feature/x"]);
	assert.deepEqual(resolved, {
		ref: "feature/x",
		suite: "smoke",
		nodes: 3,
		regions: ["eastus2", "westus3"],
		chaos: [...CHAOS_PROFILES],
		chaosSelection: "smoke",
		keep: false,
		seed: 7,
		ttlHours: 6,
		dbStorage: "premium-ssd",
		dbRegion: "westus3",
	});
	const explicit = options([
		"--ref",
		"abc",
		"--regions",
		"westus3,eastus2,westus3",
		"--chaos",
		"none",
		"--seed",
		"0",
		"--ttl-hours",
		"0.5",
		"--nodes",
		"12",
		"--suite",
		"all",
		"--db-storage",
		"local-nvme",
		"--db-region",
		"centralus",
		"--keep",
	]);
	assert.deepEqual(explicit.regions, ["westus3", "eastus2", "westus3"]);
	assert.deepEqual(explicit.chaos, []);
	assert.equal(explicit.seed, 0);
	assert.equal(explicit.ttlHours, 0.5);
	assert.equal(explicit.nodes, 12);
	assert.equal(explicit.suite, "all");
	assert.equal(explicit.dbStorage, "local-nvme");
	assert.equal(explicit.dbRegion, "centralus");
	assert.equal(explicit.keep, true);
	assert.deepEqual(options(["--ref", "x", "--chaos", "io-error"]).chaos, ["io-error"]);
	assert.deepEqual(options(["--ref", "x", "--chaos", "sigkill,partition,sigkill"]).chaos, [
		"sigkill",
		"partition",
		"sigkill",
	]);
	assert.equal(options(["--ref", "x", "--chaos", "sigkill,partition"]).chaosSelection, "sigkill,partition");
	assert.equal(options(["--ref", "x", "--seed", "4294967295"]).seed, 4294967295);
});

test("takes replay values unless a flag overrides them", () => {
	const replay = {
		ref: "0123456789abcdef0123456789abcdef01234567",
		suite: "compaction",
		nodes: "4",
		regions: "a,b",
		chaos: "oom",
		seed: "99",
		dbStorage: "local-nvme",
		dbRegion: "c",
	};
	assert.deepEqual(options([], replay), {
		ref: replay.ref,
		suite: "compaction",
		nodes: 4,
		regions: ["a", "b"],
		chaos: ["oom"],
		chaosSelection: "oom",
		keep: false,
		seed: 99,
		ttlHours: 6,
		dbStorage: "local-nvme",
		dbRegion: "c",
	});
	const overridden = options(["--ref", "main", "--seed", "5", "--nodes", "2"], replay);
	assert.equal(overridden.ref, "main");
	assert.equal(overridden.seed, 5);
	assert.equal(overridden.nodes, 2);
});

test("rejects every invalid option with its field and reason", () => {
	const cases: [string[], string, string][] = [
		[[], "--ref", "required"],
		[["--ref", ""], "--ref", "required"],
		[["--ref", "m", "--suite", "nope"], "--suite", "unknown-name"],
		[["--ref", "m", "--suite", "toString"], "--suite", "unknown-name"],
		[["--ref", "m", "--nodes", "-1"], "--nodes", "invalid-value"],
		[["--ref", "m", "--nodes", "1.5"], "--nodes", "invalid-value"],
		[["--ref", "m", "--nodes", "03"], "--nodes", "invalid-value"],
		[["--ref", "m", "--regions", "eastus2,"], "--regions", "invalid-value"],
		[["--ref", "m", "--regions", ",eastus2"], "--regions", "invalid-value"],
		[["--ref", "m", "--chaos", "earthquake"], "--chaos", "unknown-name"],
		[["--ref", "m", "--chaos", "partition,earthquake"], "--chaos", "unknown-name"],
		[["--ref", "m", "--chaos", "partition,"], "--chaos", "unknown-name"],
		[["--ref", "m", "--chaos", "smoke,partition"], "--chaos", "unknown-name"],
		[["--ref", "m", "--seed", "-1"], "--seed", "invalid-value"],
		[["--ref", "m", "--seed", "4294967296"], "--seed", "invalid-value"],
		[["--ref", "m", "--seed", "1e3"], "--seed", "invalid-value"],
		[["--ref", "m", "--ttl-hours", "0"], "--ttl-hours", "invalid-value"],
		[["--ref", "m", "--ttl-hours", "abc"], "--ttl-hours", "invalid-value"],
		[["--ref", "m", "--ttl-hours", "1h"], "--ttl-hours", "invalid-value"],
		[["--ref", "m", "--db-storage", "hdd"], "--db-storage", "invalid-value"],
		[["--ref", "m", "--db-region", ""], "--db-region", "invalid-value"],
	];
	for (const [argv, field, reason] of cases) {
		const error = configError(() => options(argv));
		assert.equal(error.fields.field, field, argv.join(" "));
		assert.equal(error.fields.reason, reason, argv.join(" "));
		assert.equal(error.fields.source, "cli");
	}
	assert.equal(configError(() => options(["--ref", "m", "--seed", "x"])).fields.actual, "x");
	assert.equal(configError(() => options(["--ref", "m", "--chaos", "partition,quake"])).fields.actual, "quake");
});

test("lists every suite from the issue and every chaos profile once", () => {
	assert.deepEqual(Object.keys(SUITES), [
		"smoke",
		"multi-node-resume",
		"cross-host-pools",
		"shard-contention",
		"idle-density",
		"subscription-flood",
		"fork-under-load",
		"restore-cold",
		"team-ci",
		"pool-scale",
		"compaction",
	]);
	assert.equal(new Set(CHAOS_PROFILES).size, 17);
	for (const profile of [
		"latency",
		"jitter",
		"loss",
		"bandwidth",
		"reset",
		"partition",
		"asymmetric-partition",
		"sigkill",
		"sigstop",
		"disk-full",
		"slow-disk",
		"io-error",
		"clock-skew",
		"oom",
		"vm-deallocate",
		"vm-restart",
		"nic-detach",
	]) {
		assert.ok(CHAOS_PROFILES.includes(profile), profile);
	}
});

test("validates the topology file field by field", () => {
	assert.equal(topology.database.primary.region, "eastus2");
	assert.deepEqual(
		topology.nodes.map((node) => node.secondaryNic),
		[false, false, true],
	);
	assert.equal(topology.extraNode.secondaryNic, false);
	const broken = (mutate: (copy: Record<string, any>) => void) => {
		const copy = structuredClone(topologyJson);
		mutate(copy);
		return configError(() => parseTopology(copy));
	};
	const cases: [(copy: Record<string, any>) => void, string, string][] = [
		[(c) => (c.schemaVersion = 2), "schemaVersion", "invalid-value"],
		[(c) => delete c.repository, "repository", "required"],
		[(c) => (c.image = ""), "image", "invalid-value"],
		[(c) => (c.regions = []), "regions", "invalid-value"],
		[(c) => (c.regions = ["a", 3]), "regions", "invalid-value"],
		[(c) => delete c.addressPool, "addressPool", "required"],
		[(c) => (c.addressPool = []), "addressPool", "invalid-value"],
		[(c) => (c.addressPool.firstSecondOctet = 40), "addressPool.firstSecondOctet", "invalid-value"],
		[(c) => (c.addressPool.firstSecondOctet = 60.5), "addressPool.firstSecondOctet", "invalid-value"],
		[(c) => (c.addressPool.lastSecondOctet = 59), "addressPool.lastSecondOctet", "invalid-value"],
		[(c) => (c.addressPool.lastSecondOctet = 256), "addressPool.lastSecondOctet", "invalid-value"],
		[(c) => (c.database.storage = "tape"), "database.storage", "invalid-value"],
		[(c) => (c.database.gatewayPort = 0), "database.gatewayPort", "invalid-value"],
		[(c) => (c.database.replicationPort = 65536), "database.replicationPort", "invalid-value"],
		[(c) => (c.database.dataDiskGb = 3), "database.dataDiskGb", "invalid-value"],
		[(c) => delete c.database.primary, "database.primary", "required"],
		[(c) => (c.database.replica.size = ""), "database.replica.size", "invalid-value"],
		[(c) => (c.database.namespaces = [""]), "database.namespaces", "invalid-value"],
		[(c) => (c.ttlHours = 0), "ttlHours", "invalid-value"],
		[(c) => delete c.ttlHours, "ttlHours", "required"],
		[(c) => (c.nodes = []), "nodes", "invalid-value"],
		[(c) => delete c.nodes, "nodes", "required"],
		[(c) => (c.nodes = [null]), "nodes[0]", "invalid-value"],
		[(c) => (c.nodes[1].roles = "large"), "nodes[1].roles", "invalid-value"],
		[(c) => (c.nodes[2].secondaryNic = "yes"), "nodes[2].secondaryNic", "invalid-value"],
		[(c) => delete c.extraNode, "extraNode", "required"],
		[(c) => delete c.node.version, "node.version", "required"],
	];
	for (const [mutate, field, reason] of cases) {
		const error = broken(mutate);
		assert.equal(error.fields.field, field);
		assert.equal(error.fields.reason, reason, field);
		assert.equal(error.fields.source, "topology");
	}
	for (const root of [null, [], "x"]) assert.equal(configError(() => parseTopology(root)).fields.field, "(root)");
	assert.equal(topology.addressPool.firstSecondOctet, 60);
	const edges = structuredClone(topologyJson);
	Object.assign(edges.addressPool, { firstSecondOctet: 255, lastSecondOctet: 255 });
	Object.assign(edges.database, { gatewayPort: 65535, replicationPort: 1, dataDiskGb: 4 });
	edges.ttlHours = 0.01;
	const parsed = parseTopology(edges);
	assert.deepEqual(parsed.addressPool, { firstSecondOctet: 255, lastSecondOctet: 255 });
	assert.equal(parsed.database.gatewayPort, 65535);
	assert.equal(parsed.database.replicationPort, 1);
	assert.equal(parsed.ttlHours, 0.01);
});

test("names runs with the UTC minute and four hex digits", () => {
	assert.equal(newRunId(NOW, 0xbeef), "adt2611050230-beef");
	assert.equal(newRunId(new Date("2031-01-02T03:04:59Z"), 0x1_0001), "adt3101020304-0001");
	assert.match(newRunId(NOW, 15), RUN_ID_PATTERN);
	assert.ok(!RUN_ID_PATTERN.test("adt2611050230-BEEF"));
	assert.ok(!RUN_ID_PATTERN.test("xadt2611050230-beef"));
	assert.ok(!RUN_ID_PATTERN.test("adt2611050230-beef0"));
});

test("plans the default topology: three roles over two regions and a cross-region database", () => {
	const plan = buildPlan(options(["--ref", "main"]), topology, { runId: "adt2611050230-beef", now: NOW });
	assert.equal(plan.resourceGroup, "adt2611050230-beef-rg");
	assert.equal(plan.location, "eastus2");
	assert.equal(plan.expiresAt, "2026-11-05T08:30:00.000Z");
	assert.deepEqual(plan.vnetRegions, ["eastus2", "westus3"]);
	assert.deepEqual(
		plan.vms.map((vm) => [
			vm.name,
			vm.kind,
			vm.template,
			vm.roles,
			vm.region,
			vm.size,
			vm.hostIndex,
			vm.secondaryNic,
			vm.dataDisk,
			vm.encryptionAtHost,
			vm.dbRole,
		]),
		[
			[
				"adt2611050230-beef-n1",
				"node",
				"large",
				["large"],
				"eastus2",
				"Standard_E8s_v7",
				20,
				false,
				false,
				false,
				undefined,
			],
			[
				"adt2611050230-beef-n2",
				"node",
				"small",
				["small-memory"],
				"westus3",
				"Standard_D2ls_v7",
				21,
				false,
				false,
				false,
				undefined,
			],
			[
				"adt2611050230-beef-n3",
				"node",
				"gitless",
				["git-less", "vm-faults"],
				"eastus2",
				"Standard_D2s_v7",
				22,
				true,
				false,
				false,
				undefined,
			],
			[
				"adt2611050230-beef-db-primary",
				"database",
				"database-primary",
				["sqld-primary"],
				"eastus2",
				"Standard_D2s_v7",
				10,
				false,
				true,
				false,
				"primary",
			],
			[
				"adt2611050230-beef-db-replica",
				"database",
				"database-replica",
				["sqld-replica"],
				"westus3",
				"Standard_D2s_v7",
				11,
				false,
				true,
				false,
				"replica",
			],
		],
	);
});

test("plans extra nodes, the local-NVMe variant and a second database region", () => {
	const plan = buildPlan(
		options([
			"--ref",
			"main",
			"--nodes",
			"5",
			"--regions",
			"westus3",
			"--db-storage",
			"local-nvme",
			"--db-region",
			"centralus",
			"--ttl-hours",
			"1",
		]),
		topology,
		{ runId: "adt2611050230-0001", now: NOW },
	);
	assert.deepEqual(
		plan.vms.map((vm) => vm.template),
		["large", "small", "gitless", "node", "node", "database-primary", "database-replica"],
	);
	assert.deepEqual(
		plan.vms.map((vm) => vm.region),
		["westus3", "westus3", "westus3", "westus3", "westus3", "eastus2", "centralus"],
	);
	assert.deepEqual(plan.vnetRegions, ["westus3", "eastus2", "centralus"]);
	const database = plan.vms.filter((vm) => vm.kind === "database");
	assert.deepEqual(
		database.map((vm) => [vm.size, vm.dataDisk, vm.encryptionAtHost]),
		[
			["Standard_D2ds_v7", false, true],
			["Standard_D2ds_v7", false, true],
		],
	);
	assert.equal(plan.vms[4].hostIndex, 24);
	assert.equal(plan.expiresAt, "2026-11-05T03:30:00.000Z");
	assert.equal(plan.location, "westus3");
	assert.deepEqual(plan.regions, ["westus3"]);
	const single = buildPlan(options(["--ref", "main", "--nodes", "1"]), topology, {
		runId: "adt2611050230-0002",
		now: NOW,
	});
	assert.deepEqual(
		single.vms.map((vm) => vm.template),
		["large", "database-primary", "database-replica"],
	);
});

test("the control network comes from the environment, with every missing variable reported together", () => {
	const env = {
		ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP: "control-rg",
		ATOMIC_DISTRIBUTED_CONTROL_VNET: "control-vnet",
		ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX: "10.0.1.0/24",
	};
	assert.deepEqual(parseControlEnv(env), {
		resourceGroup: "control-rg",
		vnet: "control-vnet",
		sshSourcePrefix: "10.0.1.0/24",
	});
	assert.throws(
		() => parseControlEnv({}),
		(error) => {
			assert.ok(isDistributedPrerequisiteError(error));
			const missing = Reflect.get(error as object, "fields").missing as { what: string; fix: string }[];
			assert.deepEqual(
				missing.map((item) => item.what),
				[
					"ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP",
					"ATOMIC_DISTRIBUTED_CONTROL_VNET",
					"ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX",
				],
			);
			assert.equal(
				missing[2].fix,
				"export ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX=<the CIDR of the controller's subnet, for example 10.0.1.0/24>",
			);
			return true;
		},
	);
	assert.throws(
		() => parseControlEnv({ ...env, ATOMIC_DISTRIBUTED_CONTROL_VNET: "" }),
		(error) => {
			assert.deepEqual(
				(Reflect.get(error as object, "fields").missing as { what: string }[]).map((item) => item.what),
				["ATOMIC_DISTRIBUTED_CONTROL_VNET"],
			);
			return true;
		},
	);
	for (const bad of ["10.0.1.0", "10.0.1.0/24 ", "control", "10.0.1/24"]) {
		const error = configError(() => parseControlEnv({ ...env, ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX: bad }));
		assert.deepEqual(error.fields, {
			source: "env",
			field: "ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX",
			reason: "invalid-value",
			expected: "an IPv4 CIDR such as 10.0.1.0/24",
			actual: bad,
		});
	}
});
