import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
	buildPlan,
	CHAOS_PROFILES,
	encryptionAtHostSkip,
	MAX_NODES,
	newRunId,
	PRIVATE_RANGES,
	parseControlEnv,
	parseRunArgs,
	parseTopology,
	RUN_ID_PATTERN,
	readJsonInput,
	remoteRefPatterns,
	replayValues,
	resolveRunOptions,
	SUITES,
	selectRemoteRef,
} from "../distributed/harness/config.mjs";
import {
	DistributedConfigError,
	isDistributedConfigError,
	isDistributedPrerequisiteError,
} from "../distributed/harness/errors.mjs";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

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

test("parses the issue's CLI form verbatim (#4331)", () => {
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

test("rejects unknown flags and missing values before any side effect (#4331)", () => {
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

test("renders one configuration error message as a UX contract (#4331)", () => {
	const error = configError(() => options(["--ref", "main", "--nodes", "0"]));
	assert.equal(
		error.message,
		"Invalid distributed-test configuration: cli --nodes is invalid-value (invalid-config). Set --nodes to an integer from 1 to 80.",
	);
	assert.equal(error.hint, "Set --nodes to an integer from 1 to 80.");
	assert.equal(error.retryable, false);
	assert.equal(error.name, "DistributedConfigError");
});

test("resolves defaults from the topology and keeps values verbatim (#4331)", () => {
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

test("takes replay values unless a flag overrides them (#4331)", () => {
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

test("rejects every invalid option with its field and reason (#4331)", () => {
	const cases: [string[], string, string][] = [
		[[], "--ref", "required"],
		[["--ref", ""], "--ref", "required"],
		[["--ref", "m", "--suite", "nope"], "--suite", "unknown-name"],
		[["--ref", "m", "--suite", "toString"], "--suite", "unknown-name"],
		[["--ref", "m", "--nodes", "-1"], "--nodes", "invalid-value"],
		[["--ref", "m", "--nodes", "1.5"], "--nodes", "invalid-value"],
		[["--ref", "m", "--nodes", "03"], "--nodes", "invalid-value"],
		[["--ref", "m", "--nodes", "81"], "--nodes", "invalid-value"],
		[["--ref", "m", "--nodes", "240"], "--nodes", "invalid-value"],
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

test("lists every suite from the issue and every chaos profile once (#4331)", () => {
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

test("validates the topology file field by field (#4331)", () => {
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

test("names runs with the UTC minute and four hex digits (#4331)", () => {
	assert.equal(newRunId(NOW, 0xbeef), "adt2611050230-beef");
	assert.equal(newRunId(new Date("2031-01-02T03:04:59Z"), 0x1_0001), "adt3101020304-0001");
	assert.match(newRunId(NOW, 15), RUN_ID_PATTERN);
	assert.ok(!RUN_ID_PATTERN.test("adt2611050230-BEEF"));
	assert.ok(!RUN_ID_PATTERN.test("xadt2611050230-beef"));
	assert.ok(!RUN_ID_PATTERN.test("adt2611050230-beef0"));
});

test("plans the default topology: three roles over two regions and a cross-region database (#4331)", () => {
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

test("one or two nodes still give the VM-level profiles a target with a second NIC (#4331)", () => {
	const plan = (nodes: number) =>
		buildPlan(options(["--ref", "main", "--nodes", String(nodes)]), topology, {
			runId: "adt2611050230-0004",
			now: NOW,
		})
			.vms.filter((vm) => vm.kind === "node")
			.map((vm) => [vm.name.slice(-2), vm.roles, vm.secondaryNic]);
	assert.deepEqual(plan(1), [["n1", ["large", "vm-faults"], true]]);
	assert.deepEqual(plan(2), [
		["n1", ["large"], false],
		["n2", ["small-memory", "vm-faults"], true],
	]);
	assert.deepEqual(plan(3), [
		["n1", ["large"], false],
		["n2", ["small-memory"], false],
		["n3", ["git-less", "vm-faults"], true],
	]);
	assert.deepEqual(plan(5).slice(3), [
		["n4", ["standard"], false],
		["n5", ["standard"], false],
	]);
	const databases = buildPlan(options(["--ref", "main", "--nodes", "1"]), topology, {
		runId: "adt2611050230-0004",
		now: NOW,
	}).vms.filter((vm) => vm.kind === "database");
	assert.deepEqual(
		databases.map((vm) => [vm.roles, vm.secondaryNic]),
		[
			[["sqld-primary"], false],
			[["sqld-replica"], false],
		],
	);
	assert.deepEqual(topology.nodes[0].roles, ["large"]);
});

test("a ref resolves only through its exact tag or branch name, never a longer ref ending in it (#4331)", () => {
	const sha = (digit: string) => digit.repeat(40);
	const listing = [
		`${sha("a")}\trefs/heads/release/0.9.71`,
		`${sha("b")}\trefs/tags/0.9.71`,
		`${sha("c")}\trefs/heads/backup/main`,
		`${sha("d")}\trefs/heads/main`,
		`${sha("e")}\trefs/tags/v1`,
		`${sha("f")}\trefs/tags/v1^{}`,
		`${sha("1")}\trefs/heads/same`,
		`${sha("1")}\trefs/tags/same`,
		`${sha("2")}\trefs/heads/both\r`,
		`${sha("3")}\trefs/tags/both`,
		"not-a-sha\trefs/heads/broken",
		`g${sha("5")}\trefs/heads/prefixed`,
		`${sha("6")}g\trefs/heads/suffixed`,
		`${sha("7")}\trefs/heads/spaced name`,
		`${sha("8")} refs/heads/untabbed`,
		`${sha("4")}`,
		"",
	].join("\n");
	assert.deepEqual(remoteRefPatterns("v1"), ["v1", "v1^{}"]);
	assert.deepEqual(selectRemoteRef(listing, "0.9.71"), { sha: sha("b"), refname: "refs/tags/0.9.71" });
	assert.deepEqual(selectRemoteRef(listing, "main"), { sha: sha("d"), refname: "refs/heads/main" });
	assert.deepEqual(selectRemoteRef(listing, "v1"), { sha: sha("f"), refname: "refs/tags/v1" });
	assert.deepEqual(selectRemoteRef(listing, "refs/tags/v1"), { sha: sha("f"), refname: "refs/tags/v1" });
	assert.deepEqual(selectRemoteRef(listing, "refs/heads/release/0.9.71"), {
		sha: sha("a"),
		refname: "refs/heads/release/0.9.71",
	});
	assert.deepEqual(selectRemoteRef(listing, "same"), { sha: sha("1"), refname: "refs/tags/same" });
	assert.deepEqual(selectRemoteRef(listing, "refs/heads/both"), { sha: sha("2"), refname: "refs/heads/both" });
	const ambiguous = configError(() => selectRemoteRef(listing, "both"));
	assert.deepEqual(ambiguous.fields, {
		source: "cli",
		field: "--ref",
		reason: "ambiguous",
		expected: "refs/tags/both or refs/heads/both",
		actual: "both",
	});
	assert.equal(ambiguous.hint, "Set --ref to refs/tags/both or refs/heads/both.");
	for (const ref of [
		"release/0.9.71x",
		"0.9.7",
		"broken",
		"prefixed",
		"suffixed",
		"spaced",
		"untabbed",
		"heads/main",
		"refs/heads/backup",
		"71",
	]) {
		assert.deepEqual(configError(() => selectRemoteRef(listing, ref)).fields, {
			source: "cli",
			field: "--ref",
			reason: "unknown-name",
			expected: "a commit SHA, or a branch or tag pushed to origin",
			actual: ref,
		});
	}
	assert.equal(configError(() => selectRemoteRef("", "main")).fields.reason, "unknown-name");
});

test("plans extra nodes, the local-NVMe variant and a second database region (#4331)", () => {
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

test("the largest topology keeps every private address unique and inside its /24 (#4331)", () => {
	assert.equal(MAX_NODES, 80);
	const plan = buildPlan(options(["--ref", "main", "--nodes", String(MAX_NODES)]), topology, {
		runId: "adt2611050230-0003",
		now: NOW,
	});
	const addresses = new Map<string, number[]>();
	for (const vm of plan.vms) {
		const used = addresses.get(vm.region) ?? [];
		used.push(vm.hostIndex, ...(vm.secondaryNic ? [vm.hostIndex + 100] : []));
		addresses.set(vm.region, used);
	}
	for (const [region, used] of addresses) {
		assert.equal(new Set(used).size, used.length, region);
		assert.ok(
			used.every((index) => index >= 4 && index <= 254),
			region,
		);
	}
	assert.equal(Math.max(...plan.vms.map((vm) => vm.hostIndex)), 20 + MAX_NODES - 1);
});

test("JSON inputs distinguish an unreadable file from malformed JSON and keep the cause (#4331)", () => {
	const missing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
	const unreadable = configError(() =>
		readJsonInput(
			() => {
				throw missing;
			},
			{ source: "cli", field: "--topology", path: "/nope.json", expected: "a readable JSON topology file" },
		),
	);
	assert.deepEqual(unreadable.fields, {
		source: "cli",
		field: "--topology",
		reason: "unreadable",
		expected: "a readable JSON topology file",
		actual: "/nope.json",
	});
	assert.equal(unreadable.cause, missing);
	const malformed = configError(() =>
		readJsonInput(() => "{not json", { source: "replay", field: "--replay", path: "/r.json", expected: "a report" }),
	);
	assert.deepEqual(malformed.fields, {
		source: "replay",
		field: "--replay",
		reason: "invalid-json",
		expected: "a report",
		actual: "/r.json",
	});
	assert.ok(malformed.cause instanceof SyntaxError);
	const reads: string[] = [];
	assert.deepEqual(
		readJsonInput(
			(path) => {
				reads.push(path);
				return '{"a":[1]}';
			},
			{ source: "cli", field: "--reuse", path: "/s.json", expected: "state" },
		),
		{ a: [1] },
	);
	assert.deepEqual(reads, ["/s.json"]);
});

test("a report's replay section becomes flag values, preferring the resolved SHA (#4331)", () => {
	const sha = "0123456789abcdef0123456789abcdef01234567";
	assert.deepEqual(
		replayValues({
			replay: {
				ref: "main",
				sha,
				suite: "smoke",
				nodes: 3,
				regions: ["eastus2", "westus3"],
				chaos: "smoke",
				seed: 1434725318,
				dbStorage: "premium-ssd",
				dbRegion: "westus3",
				prng: "mulberry32/v1",
			},
		}),
		{
			ref: sha,
			suite: "smoke",
			nodes: "3",
			regions: "eastus2,westus3",
			chaos: "smoke",
			seed: "1434725318",
			dbStorage: "premium-ssd",
			dbRegion: "westus3",
		},
	);
	assert.deepEqual(replayValues({ replay: { ref: "main" } }), { ref: "main" });
	assert.deepEqual(replayValues({ replay: {} }), {});
	assert.deepEqual(options([], replayValues({ replay: { ref: "main", nodes: 2, seed: 9 } })).nodes, 2);
	for (const report of [null, "x", {}, { replay: null }, { replay: [] }, { replay: "r" }]) {
		assert.deepEqual(configError(() => replayValues(report)).fields, {
			source: "replay",
			field: "replay",
			reason: "required",
			expected: "the replay section of a report.json written by run.mjs",
			actual: null,
		});
	}
	for (const [key, value] of [
		["nodes", Number.POSITIVE_INFINITY],
		["seed", Number.NaN],
		["suite", true],
		["ref", { branch: "main" }],
		["sha", null],
	] as const) {
		assert.deepEqual(configError(() => replayValues({ replay: { [key]: value } })).fields, {
			source: "replay",
			field: `replay.${key}`,
			reason: "invalid-value",
			expected: "a string or a number",
			actual: JSON.stringify(value),
		});
	}
	for (const regions of ["eastus2", [1], ["a", null]]) {
		assert.deepEqual(configError(() => replayValues({ replay: { regions } })).fields, {
			source: "replay",
			field: "replay.regions",
			reason: "invalid-value",
			expected: "an array of region names",
			actual: JSON.stringify(regions),
		});
	}
});

test("local NVMe falls back only when encryption at host is not registered (#4331)", () => {
	assert.equal(encryptionAtHostSkip("local-nvme", "Registered"), undefined);
	assert.equal(encryptionAtHostSkip("premium-ssd", "NotRegistered"), undefined);
	assert.equal(encryptionAtHostSkip("premium-ssd", undefined), undefined);
	assert.deepEqual(encryptionAtHostSkip("local-nvme", "NotRegistered"), {
		code: "encryption-at-host-unavailable",
		detail: "Microsoft.Compute/EncryptionAtHost is NotRegistered; the Premium SSD variant runs instead",
	});
	assert.deepEqual(encryptionAtHostSkip("local-nvme", null), {
		code: "encryption-at-host-unavailable",
		detail: "Microsoft.Compute/EncryptionAtHost is null; the Premium SSD variant runs instead",
	});
});

test("the control network comes from the environment, with every missing variable reported together (#4331)", () => {
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
			expected: "a private IPv4 CIDR inside 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, such as 10.0.1.0/24",
			actual: bad,
		});
	}
});

test("configuration errors carry the exact expectation and the offending value (#4331)", () => {
	const fields = (action: () => unknown) => configError(action).fields;
	assert.deepEqual(
		fields(() => parseRunArgs(["--ref"])),
		{ source: "cli", field: "--ref", reason: "missing-value", expected: "a value after the flag", actual: null },
	);
	assert.deepEqual(
		fields(() => options([])),
		{
			source: "cli",
			field: "--ref",
			reason: "required",
			expected: "a commit SHA or branch name on origin",
			actual: null,
		},
	);
	assert.deepEqual(
		fields(() => options(["--ref", "m", "--suite", "x"])),
		{
			source: "cli",
			field: "--suite",
			reason: "unknown-name",
			expected: `all or one of ${Object.keys(SUITES).join(", ")}`,
			actual: "x",
		},
	);
	assert.deepEqual(
		fields(() => options(["--ref", "m", "--regions", "a,"])),
		{
			source: "cli",
			field: "--regions",
			reason: "invalid-value",
			expected: "a comma-separated list of Azure region names",
			actual: "a,",
		},
	);
	assert.deepEqual(
		fields(() => options(["--ref", "m", "--chaos", "quake"])),
		{
			source: "cli",
			field: "--chaos",
			reason: "unknown-name",
			expected: `smoke, none, or profiles from ${CHAOS_PROFILES.join(", ")} separated by commas`,
			actual: "quake",
		},
	);
	assert.deepEqual(
		fields(() => options(["--ref", "m", "--seed", "-2"])),
		{
			source: "cli",
			field: "--seed",
			reason: "invalid-value",
			expected: "an integer from 0 to 4294967295",
			actual: "-2",
		},
	);
	assert.deepEqual(
		fields(() => options(["--ref", "m", "--ttl-hours", "0"])),
		{
			source: "cli",
			field: "--ttl-hours",
			reason: "invalid-value",
			expected: "a positive number of hours",
			actual: "0",
		},
	);
	assert.deepEqual(
		fields(() => options(["--ref", "m", "--db-storage", "hdd"])),
		{
			source: "cli",
			field: "--db-storage",
			reason: "invalid-value",
			expected: "premium-ssd or local-nvme",
			actual: "hdd",
		},
	);
	assert.deepEqual(
		fields(() => options(["--ref", "m", "--db-region", ""])),
		{ source: "cli", field: "--db-region", reason: "invalid-value", expected: "an Azure region name", actual: "" },
	);
	for (const valid of ["1.5", "12", "12.25"])
		assert.equal(options(["--ref", "m", "--ttl-hours", valid]).ttlHours, Number(valid));
	for (const invalid of ["1.", "x1", "1x", ".5", "1.5.5"])
		assert.equal(fields(() => options(["--ref", "m", "--ttl-hours", invalid])).actual, invalid);
	assert.deepEqual(SUITES, {
		smoke: "#4331",
		"multi-node-resume": "#4329",
		"cross-host-pools": "#4310",
		"shard-contention": "#4325",
		"idle-density": "#4309/#4326",
		"subscription-flood": "#4311",
		"fork-under-load": "#4321",
		"restore-cold": "#4245",
		"team-ci": "#4320",
		"pool-scale": "#4312",
		compaction: "#4330",
	});
});

test("topology errors carry the exact expectation and the offending value (#4331)", () => {
	const broken = (mutate: (copy: Record<string, any>) => void) => {
		const copy = structuredClone(topologyJson);
		mutate(copy);
		return configError(() => parseTopology(copy)).fields;
	};
	const topology = (field: string, expected: string, actual: unknown, reason = "invalid-value") => ({
		source: "topology",
		field,
		reason,
		expected,
		actual,
	});
	assert.deepEqual(
		broken((c) => (c.image = 3)),
		topology("image", "a non-empty string", "3"),
	);
	assert.deepEqual(
		broken((c) => delete c.image),
		topology("image", "a non-empty string", null, "required"),
	);
	assert.deepEqual(
		broken((c) => (c.database.gatewayPort = 0)),
		topology("database.gatewayPort", "an integer from 1 to 65535", "0"),
	);
	assert.deepEqual(
		broken((c) => delete c.database.gatewayPort),
		topology("database.gatewayPort", "an integer from 1 to 65535", null, "required"),
	);
	assert.deepEqual(
		broken((c) => (c.node = "v1")),
		topology("node", "an object", '"v1"'),
	);
	assert.deepEqual(
		broken((c) => delete c.node),
		topology("node", "an object", null, "required"),
	);
	assert.deepEqual(
		broken((c) => (c.regions = [""])),
		topology("regions", "a non-empty array of non-empty strings", '[""]'),
	);
	assert.deepEqual(
		broken((c) => delete c.regions),
		topology("regions", "a non-empty array of non-empty strings", null, "required"),
	);
	assert.deepEqual(
		broken((c) => (c.nodes[0].secondaryNic = 1)),
		topology("nodes[0].secondaryNic", "a boolean", "1"),
	);
	assert.deepEqual(
		broken((c) => (c.schemaVersion = 2)),
		topology("schemaVersion", "1", "2"),
	);
	assert.deepEqual(
		broken((c) => delete c.schemaVersion),
		topology("schemaVersion", "1", "null"),
	);
	assert.deepEqual(
		broken((c) => (c.database.storage = "tape")),
		topology("database.storage", "premium-ssd or local-nvme", "tape"),
	);
	assert.deepEqual(
		broken((c) => (c.ttlHours = -1)),
		topology("ttlHours", "a positive number of hours", "-1"),
	);
	assert.deepEqual(
		broken((c) => delete c.ttlHours),
		topology("ttlHours", "a positive number of hours", "null", "required"),
	);
	assert.deepEqual(
		broken((c) => (c.nodes = {})),
		topology("nodes", "a non-empty array of node templates", "{}"),
	);
	assert.deepEqual(
		broken((c) => delete c.nodes),
		topology("nodes", "a non-empty array of node templates", "null", "required"),
	);
	assert.deepEqual(
		broken((c) => (c.nodes = [7])),
		topology("nodes[0]", "an object", "7"),
	);
	assert.deepEqual(configError(() => parseTopology(null)).fields, topology("(root)", "a JSON object", "null"));
	const noNic = structuredClone(topologyJson);
	delete noNic.nodes[2].secondaryNic;
	assert.equal(parseTopology(noNic).nodes[2].secondaryNic, false);
});

test("the controller subnet must be a private IPv4 CIDR, never an Internet source (#4331)", () => {
	const env = {
		ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP: "control-rg",
		ATOMIC_DISTRIBUTED_CONTROL_VNET: "control-vnet",
	};
	assert.deepEqual(PRIVATE_RANGES, ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);
	for (const valid of [
		"10.0.123.0/24",
		"10.0.0.0/8",
		"172.16.5.0/24",
		"172.31.255.0/24",
		"192.168.1.0/24",
		"192.168.0.0/16",
	])
		assert.equal(parseControlEnv({ ...env, ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX: valid }).sshSourcePrefix, valid);
	for (const invalid of [
		"x10.0.1.0/24",
		"10.0.1.0/24x",
		"10.0.1.1234/24",
		"999.1.1.1/40",
		"10.0.1.0",
		"0.0.0.0/0",
		"8.8.8.0/24",
		"11.0.0.0/8",
		"10.0.0.0/7",
		"172.15.0.0/16",
		"172.32.0.0/16",
		"172.16.0.0/11",
		"192.169.0.0/16",
		"192.168.1.0/8",
	]) {
		assert.equal(
			configError(() => parseControlEnv({ ...env, ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX: invalid })).fields.actual,
			invalid,
		);
	}
	assert.throws(
		() => parseControlEnv({}),
		(error) => {
			assert.deepEqual(Reflect.get(error as object, "fields").missing, [
				{
					what: "ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP",
					why: "test VNets are peered to the controller's VNet and accept SSH only from its subnet",
					fix: "export ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP=<the resource group of the controller's VNet, for example control-rg>",
				},
				{
					what: "ATOMIC_DISTRIBUTED_CONTROL_VNET",
					why: "test VNets are peered to the controller's VNet and accept SSH only from its subnet",
					fix: "export ATOMIC_DISTRIBUTED_CONTROL_VNET=<the name of the controller's VNet, for example control-vnet>",
				},
				{
					what: "ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX",
					why: "test VNets are peered to the controller's VNet and accept SSH only from its subnet",
					fix: "export ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX=<the CIDR of the controller's subnet, for example 10.0.1.0/24>",
				},
			]);
			return true;
		},
	);
});

test("every nested topology field is reported by its full path (#4331)", () => {
	const fieldOf = (mutate: (copy: Record<string, any>) => void) => {
		const copy = structuredClone(topologyJson);
		mutate(copy);
		return configError(() => parseTopology(copy)).fields.field;
	};
	assert.equal(
		fieldOf((c) => delete c.database),
		"database",
	);
	assert.equal(
		fieldOf((c) => (c.node = null)),
		"node",
	);
	assert.equal(
		fieldOf((c) => delete c.adminUser),
		"adminUser",
	);
	assert.equal(
		fieldOf((c) => delete c.database.storage),
		"database.storage",
	);
	assert.equal(
		fieldOf((c) => delete c.database.version),
		"database.version",
	);
	assert.equal(
		fieldOf((c) => delete c.database.image),
		"database.image",
	);
	assert.equal(
		fieldOf((c) => delete c.database.primary.region),
		"database.primary.region",
	);
	assert.equal(
		fieldOf((c) => delete c.database.primary.size),
		"database.primary.size",
	);
	assert.equal(
		fieldOf((c) => delete c.database.replica.region),
		"database.replica.region",
	);
	assert.equal(
		fieldOf((c) => delete c.database.replica.size),
		"database.replica.size",
	);
	assert.equal(
		fieldOf((c) => delete c.database.replica),
		"database.replica",
	);
	assert.equal(
		fieldOf((c) => delete c.database.localNvmeSize),
		"database.localNvmeSize",
	);
	assert.equal(
		fieldOf((c) => delete c.extraNode.size),
		"extraNode.size",
	);
	assert.equal(
		fieldOf((c) => (c.ttlHours = "6")),
		"ttlHours",
	);
	assert.equal(
		fieldOf((c) => (c.database.gatewayPort = "8443")),
		"database.gatewayPort",
	);
});

test("multi-node resume requires three nodes and accepts SSH from one private host (#4329)", () => {
	for (const n of ["1", "2"]) {
		const error = configError(() => options(["--ref", "m", "--suite", "multi-node-resume", "--nodes", n]));
		assert.equal(error.fields.field, "--nodes");
		assert.equal(error.fields.expected, "at least 3: the multi-node-resume suite needs three nodes, one without git");
	}
	assert.equal(options(["--ref", "m", "--suite", "multi-node-resume", "--nodes", "3"]).nodes, 3);
	const control = parseControlEnv({
		ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP: "control",
		ATOMIC_DISTRIBUTED_CONTROL_VNET: "vnet",
		ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX: "10.0.1.4/32",
	});
	assert.equal(control.sshSourcePrefix, "10.0.1.4/32");
});
