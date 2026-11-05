// @ts-check
import { DistributedConfigError, DistributedPrerequisiteError } from "./errors.mjs";
import { cidrWithin } from "./network.mjs";

/** Suites a run can select, each with the issue whose feature it exercises. */
export const SUITES = Object.freeze({
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

/** Chaos profiles, in the order the smoke suite exercises them. */
export const CHAOS_PROFILES = Object.freeze([
	"partition",
	"sigkill",
	"latency",
	"jitter",
	"loss",
	"bandwidth",
	"reset",
	"asymmetric-partition",
	"sigstop",
	"clock-skew",
	"disk-full",
	"slow-disk",
	"io-error",
	"oom",
	"vm-restart",
	"vm-deallocate",
	"nic-detach",
]);

export const DB_STORAGE = Object.freeze(["premium-ssd", "local-nvme"]);
export const RUN_ID_PATTERN = /^adt\d{10}-[0-9a-f]{4}$/;
/** Nodes take host addresses from .20 and secondary NICs from .120 of a /24, so more than 80 would collide. */
export const MAX_NODES = 80;

/**
 * @typedef {{ ref?: string, suite?: string, nodes?: string, regions?: string, chaos?: string, keep: boolean,
 *   seed?: string, ttlHours?: string, topology?: string, dbStorage?: string, dbRegion?: string, out?: string,
 *   builder?: string, artifact?: string, replay?: string, reuse?: string, planOnly: boolean, help: boolean }} RunArgs
 */

/** @type {Readonly<Record<string, keyof RunArgs>>} */
const VALUE_FLAGS = {
	"--ref": "ref",
	"--suite": "suite",
	"--nodes": "nodes",
	"--regions": "regions",
	"--chaos": "chaos",
	"--seed": "seed",
	"--ttl-hours": "ttlHours",
	"--topology": "topology",
	"--db-storage": "dbStorage",
	"--db-region": "dbRegion",
	"--out": "out",
	"--builder": "builder",
	"--artifact": "artifact",
	"--replay": "replay",
	"--reuse": "reuse",
};
/** @type {Readonly<Record<string, "keep" | "planOnly" | "help">>} */
const BOOLEAN_FLAGS = { "--keep": "keep", "--plan-only": "planOnly", "--help": "help" };

/**
 * Parses `run.mjs` flags without touching the filesystem or Azure. Values are kept verbatim.
 * @param {readonly string[]} argv
 * @returns {RunArgs}
 */
export function parseRunArgs(argv) {
	/** @type {RunArgs} */
	const args = { keep: false, planOnly: false, help: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const booleanKey = Object.hasOwn(BOOLEAN_FLAGS, flag) ? BOOLEAN_FLAGS[flag] : undefined;
		if (booleanKey !== undefined) {
			args[booleanKey] = true;
			continue;
		}
		const key = Object.hasOwn(VALUE_FLAGS, flag) ? VALUE_FLAGS[flag] : undefined;
		if (key === undefined) {
			throw new DistributedConfigError({
				source: "cli",
				field: flag,
				reason: "unknown-flag",
				expected: "a documented flag (see --help)",
				actual: flag,
			});
		}
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new DistributedConfigError({
				source: "cli",
				field: flag,
				reason: "missing-value",
				expected: "a value after the flag",
			});
		}
		Object.assign(args, { [key]: value });
		index++;
	}
	return args;
}

/**
 * @typedef {{ name: string, roles: string[], size: string, secondaryNic: boolean }} NodeTemplate
 * @typedef {{ region: string, size: string }} DatabaseHost
 * @typedef {{
 *   schemaVersion: 1, repository: string, regions: string[], ttlHours: number, image: string, adminUser: string,
 *   addressPool: { firstSecondOctet: number, lastSecondOctet: number },
 *   node: { version: string },
 *   database: { version: string, image: string, namespaces: string[], gatewayPort: number, replicationPort: number,
 *     storage: string, dataDiskGb: number, primary: DatabaseHost, replica: DatabaseHost, localNvmeSize: string },
 *   nodes: NodeTemplate[], extraNode: NodeTemplate }} Topology
 */

/** Environment variables naming the control network the controller reaches the run's private VMs from. */
export const CONTROL_ENV = Object.freeze({
	resourceGroup: "ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP",
	vnet: "ATOMIC_DISTRIBUTED_CONTROL_VNET",
	sshSourcePrefix: "ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX",
});

/**
 * @typedef {{ resourceGroup: string, vnet: string, sshSourcePrefix: string }} ControlNetwork
 */

/** The RFC 1918 ranges; the controller's subnet must lie inside one, because no Internet source may reach a run. */
export const PRIVATE_RANGES = Object.freeze(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]);

/**
 * The control network from the environment: the resource group and name of the VNet the controller runs in, and the
 * CIDR of the controller's subnet, which alone may reach the run's VMs over SSH. Every missing variable is reported
 * together, before any side effect.
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {ControlNetwork}
 */
export function parseControlEnv(env) {
	const fixes = {
		resourceGroup: "the resource group of the controller's VNet, for example control-rg",
		vnet: "the name of the controller's VNet, for example control-vnet",
		sshSourcePrefix: "the CIDR of the controller's subnet, for example 10.0.1.0/24",
	};
	const missing = /** @type {(keyof typeof CONTROL_ENV)[]} */ (Object.keys(CONTROL_ENV)).filter(
		(key) => (env[CONTROL_ENV[key]] ?? "") === "",
	);
	if (missing.length > 0) {
		throw new DistributedPrerequisiteError({
			missing: missing.map((key) => ({
				what: CONTROL_ENV[key],
				why: "test VNets are peered to the controller's VNet and accept SSH only from its subnet",
				fix: `export ${CONTROL_ENV[key]}=<${fixes[key]}>`,
			})),
		});
	}
	const sshSourcePrefix = /** @type {string} */ (env[CONTROL_ENV.sshSourcePrefix]);
	if (!sshSourcePrefix.includes("/") || !PRIVATE_RANGES.some((range) => cidrWithin(sshSourcePrefix, range))) {
		throw new DistributedConfigError({
			source: "env",
			field: CONTROL_ENV.sshSourcePrefix,
			reason: "invalid-value",
			expected: `a private IPv4 CIDR inside ${PRIVATE_RANGES.join(", ")}, such as 10.0.1.0/24`,
			actual: sshSourcePrefix,
		});
	}
	return {
		resourceGroup: /** @type {string} */ (env[CONTROL_ENV.resourceGroup]),
		vnet: /** @type {string} */ (env[CONTROL_ENV.vnet]),
		sshSourcePrefix,
	};
}

/**
 * @param {string} field
 * @param {string} expected
 * @param {import("./errors.mjs").FieldValue} actual
 * @param {"required" | "invalid-value"} [reason]
 */
function topologyError(field, expected, actual, reason = "invalid-value") {
	return new DistributedConfigError({ source: "topology", field, reason, expected, actual });
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {string} path
 */
function stringAt(object, key, path) {
	const value = object[key];
	if (typeof value !== "string" || value === "") {
		throw topologyError(
			`${path}${key}`,
			"a non-empty string",
			JSON.stringify(value),
			value === undefined ? "required" : "invalid-value",
		);
	}
	return value;
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {string} path
 * @param {number} min
 * @param {number} max
 */
function integerAt(object, key, path, min, max) {
	const value = object[key];
	if (!Number.isInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) {
		throw topologyError(
			`${path}${key}`,
			`an integer from ${min} to ${max}`,
			JSON.stringify(value),
			value === undefined ? "required" : "invalid-value",
		);
	}
	return /** @type {number} */ (value);
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {string} path
 */
function objectAt(object, key, path) {
	const value = object[key];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw topologyError(
			`${path}${key}`,
			"an object",
			JSON.stringify(value),
			value === undefined ? "required" : "invalid-value",
		);
	}
	return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {Record<string, unknown>} object
 * @param {string} key
 * @param {string} path
 */
function stringsAt(object, key, path) {
	const value = object[key];
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item === "")) {
		throw topologyError(
			`${path}${key}`,
			"a non-empty array of non-empty strings",
			JSON.stringify(value),
			value === undefined ? "required" : "invalid-value",
		);
	}
	return /** @type {string[]} */ ([...value]);
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} path
 * @returns {NodeTemplate}
 */
function nodeTemplate(raw, path) {
	const secondaryNic = raw.secondaryNic ?? false;
	if (typeof secondaryNic !== "boolean")
		throw topologyError(`${path}secondaryNic`, "a boolean", JSON.stringify(secondaryNic));
	return {
		name: stringAt(raw, "name", path),
		roles: stringsAt(raw, "roles", path),
		size: stringAt(raw, "size", path),
		secondaryNic,
	};
}

/**
 * Validates the declarative topology. Throws a `DistributedConfigError` naming the first invalid field.
 * @param {unknown} json
 * @returns {Topology}
 */
export function parseTopology(json) {
	if (typeof json !== "object" || json === null || Array.isArray(json))
		throw topologyError("(root)", "a JSON object", JSON.stringify(json));
	const root = /** @type {Record<string, unknown>} */ (json);
	if (root.schemaVersion !== 1) throw topologyError("schemaVersion", "1", JSON.stringify(root.schemaVersion ?? null));
	const pool = objectAt(root, "addressPool", "");
	const node = objectAt(root, "node", "");
	const database = objectAt(root, "database", "");
	const primary = objectAt(database, "primary", "database.");
	const replica = objectAt(database, "replica", "database.");
	const firstSecondOctet = integerAt(pool, "firstSecondOctet", "addressPool.", 60, 255);
	const lastSecondOctet = integerAt(pool, "lastSecondOctet", "addressPool.", firstSecondOctet, 255);
	const storage = stringAt(database, "storage", "database.");
	if (!DB_STORAGE.includes(storage)) throw topologyError("database.storage", DB_STORAGE.join(" or "), storage);
	const ttlHours = root.ttlHours;
	if (typeof ttlHours !== "number" || !(ttlHours > 0))
		throw topologyError(
			"ttlHours",
			"a positive number of hours",
			JSON.stringify(ttlHours ?? null),
			ttlHours === undefined ? "required" : "invalid-value",
		);
	const nodes = root.nodes;
	if (!Array.isArray(nodes) || nodes.length === 0)
		throw topologyError(
			"nodes",
			"a non-empty array of node templates",
			JSON.stringify(nodes ?? null),
			nodes === undefined ? "required" : "invalid-value",
		);
	return {
		schemaVersion: 1,
		repository: stringAt(root, "repository", ""),
		regions: stringsAt(root, "regions", ""),
		ttlHours,
		image: stringAt(root, "image", ""),
		adminUser: stringAt(root, "adminUser", ""),
		addressPool: { firstSecondOctet, lastSecondOctet },
		node: { version: stringAt(node, "version", "node.") },
		database: {
			version: stringAt(database, "version", "database."),
			image: stringAt(database, "image", "database."),
			namespaces: stringsAt(database, "namespaces", "database."),
			gatewayPort: integerAt(database, "gatewayPort", "database.", 1, 65535),
			replicationPort: integerAt(database, "replicationPort", "database.", 1, 65535),
			storage,
			dataDiskGb: integerAt(database, "dataDiskGb", "database.", 4, 32767),
			primary: {
				region: stringAt(primary, "region", "database.primary."),
				size: stringAt(primary, "size", "database.primary."),
			},
			replica: {
				region: stringAt(replica, "region", "database.replica."),
				size: stringAt(replica, "size", "database.replica."),
			},
			localNvmeSize: stringAt(database, "localNvmeSize", "database."),
		},
		nodes: nodes.map((item, index) => {
			if (typeof item !== "object" || item === null || Array.isArray(item))
				throw topologyError(`nodes[${index}]`, "an object", JSON.stringify(item));
			return nodeTemplate(/** @type {Record<string, unknown>} */ (item), `nodes[${index}].`);
		}),
		extraNode: nodeTemplate(objectAt(root, "extraNode", ""), "extraNode."),
	};
}

/**
 * @typedef {{ ref: string, suite: string, nodes: number, regions: string[], chaos: string[], chaosSelection: string,
 *   keep: boolean, seed: number, ttlHours: number, dbStorage: string, dbRegion: string }} RunOptions
 */

/**
 * @param {string} field
 * @param {string} expected
 * @param {string} actual
 */
function cliError(field, expected, actual) {
	return new DistributedConfigError({ source: "cli", field, reason: "invalid-value", expected, actual });
}

/**
 * Resolves run options from flags, an optional replay record and the topology. Every check happens before any I/O.
 * @param {RunArgs} args
 * @param {Topology} topology
 * @param {{ randomSeed: number, replay?: Partial<Record<"ref" | "suite" | "nodes" | "regions" | "chaos" | "seed" | "dbStorage" | "dbRegion", string>> }} context
 * @returns {RunOptions}
 */
export function resolveRunOptions(args, topology, { randomSeed, replay = {} }) {
	const ref = args.ref ?? replay.ref;
	if (ref === undefined || ref === "") {
		throw new DistributedConfigError({
			source: "cli",
			field: "--ref",
			reason: "required",
			expected: "a commit SHA or branch name on origin",
		});
	}
	const suite = args.suite ?? replay.suite ?? "smoke";
	if (suite !== "all" && !Object.hasOwn(SUITES, suite)) {
		throw new DistributedConfigError({
			source: "cli",
			field: "--suite",
			reason: "unknown-name",
			expected: `all or one of ${Object.keys(SUITES).join(", ")}`,
			actual: suite,
		});
	}
	const nodesText = args.nodes ?? replay.nodes ?? "3";
	if (!/^[1-9]\d*$/.test(nodesText) || Number(nodesText) > MAX_NODES)
		throw cliError("--nodes", `an integer from 1 to ${MAX_NODES}`, nodesText);
	const regionsText = args.regions ?? replay.regions;
	const regions = regionsText === undefined ? [...topology.regions] : regionsText.split(",");
	if (regionsText !== undefined && regions.some((region) => region === ""))
		throw cliError("--regions", "a comma-separated list of Azure region names", regionsText);
	const chaosSelection = args.chaos ?? replay.chaos ?? "smoke";
	/** @type {string[]} */
	let chaos;
	if (chaosSelection === "smoke") chaos = [...CHAOS_PROFILES];
	else if (chaosSelection === "none") chaos = [];
	else {
		chaos = chaosSelection.split(",");
		const unknown = chaos.find((profile) => !CHAOS_PROFILES.includes(profile));
		if (unknown !== undefined) {
			throw new DistributedConfigError({
				source: "cli",
				field: "--chaos",
				reason: "unknown-name",
				expected: `smoke, none, or profiles from ${CHAOS_PROFILES.join(", ")} separated by commas`,
				actual: unknown,
			});
		}
	}
	const seedText = args.seed ?? replay.seed;
	if (seedText !== undefined && (!/^\d+$/.test(seedText) || Number(seedText) > 0xffffffff)) {
		throw cliError("--seed", "an integer from 0 to 4294967295", seedText);
	}
	const ttlText = args.ttlHours;
	if (ttlText !== undefined && !(/^\d+(\.\d+)?$/.test(ttlText) && Number(ttlText) > 0))
		throw cliError("--ttl-hours", "a positive number of hours", ttlText);
	const dbStorage = args.dbStorage ?? replay.dbStorage ?? topology.database.storage;
	if (!DB_STORAGE.includes(dbStorage)) throw cliError("--db-storage", DB_STORAGE.join(" or "), dbStorage);
	const dbRegion = args.dbRegion ?? replay.dbRegion ?? topology.database.replica.region;
	if (dbRegion === "") throw cliError("--db-region", "an Azure region name", dbRegion);
	return {
		ref,
		suite,
		nodes: Number(nodesText),
		regions,
		chaos,
		chaosSelection,
		keep: args.keep,
		seed: seedText === undefined ? randomSeed : Number(seedText),
		ttlHours: ttlText === undefined ? topology.ttlHours : Number(ttlText),
		dbStorage,
		dbRegion,
	};
}

/**
 * Reads and parses a JSON file named by a flag. An unreadable file and malformed JSON are distinct configuration
 * errors, each carrying the underlying failure as its cause.
 * @param {(path: string) => string} read
 * @param {{ source: "cli" | "replay", field: string, path: string, expected: string }} input
 * @returns {unknown}
 */
export function readJsonInput(read, { source, field, path, expected }) {
	let text;
	try {
		text = read(path);
	} catch (cause) {
		throw new DistributedConfigError({ source, field, reason: "unreadable", expected, actual: path, cause });
	}
	try {
		return JSON.parse(text);
	} catch (cause) {
		throw new DistributedConfigError({ source, field, reason: "invalid-json", expected, actual: path, cause });
	}
}

/**
 * The run options an earlier report recorded, as flag values for `resolveRunOptions`. The resolved SHA is preferred
 * over the ref it came from, so a replay deploys the same commit.
 * @param {unknown} report
 * @returns {Partial<Record<"ref" | "suite" | "nodes" | "regions" | "chaos" | "seed" | "dbStorage" | "dbRegion", string>>}
 */
export function replayValues(report) {
	const replay = typeof report === "object" && report !== null ? Reflect.get(report, "replay") : undefined;
	if (typeof replay !== "object" || replay === null || Array.isArray(replay)) {
		throw new DistributedConfigError({
			source: "replay",
			field: "replay",
			reason: "required",
			expected: "the replay section of a report.json written by run.mjs",
		});
	}
	/** @param {string} key */
	const text = (key) => {
		const value = Reflect.get(replay, key);
		if (value === undefined || typeof value === "string") return value;
		if (Number.isFinite(value)) return String(value);
		throw new DistributedConfigError({
			source: "replay",
			field: `replay.${key}`,
			reason: "invalid-value",
			expected: "a string or a number",
			actual: JSON.stringify(value),
		});
	};
	const regions = Reflect.get(replay, "regions");
	if (regions !== undefined && !(Array.isArray(regions) && regions.every((region) => typeof region === "string"))) {
		throw new DistributedConfigError({
			source: "replay",
			field: "replay.regions",
			reason: "invalid-value",
			expected: "an array of region names",
			actual: JSON.stringify(regions),
		});
	}
	/** @type {Partial<Record<"ref" | "suite" | "nodes" | "regions" | "chaos" | "seed" | "dbStorage" | "dbRegion", string>>} */
	const values = {};
	const entries = /** @type {const} */ ([
		["ref", text("sha") ?? text("ref")],
		["suite", text("suite")],
		["nodes", text("nodes")],
		["regions", regions?.join(",")],
		["chaos", text("chaos")],
		["seed", text("seed")],
		["dbStorage", text("dbStorage")],
		["dbRegion", text("dbRegion")],
	]);
	for (const [key, value] of entries) if (value !== undefined) values[key] = value;
	return values;
}

/**
 * Why the local-NVMe variant cannot run, when it cannot: it needs encryption at host, which the subscription must
 * have registered. Undefined when the run can use the storage it asked for.
 * @param {string} storage
 * @param {unknown} featureState the `properties.state` of `Microsoft.Compute/EncryptionAtHost`
 * @returns {{ code: "encryption-at-host-unavailable", detail: string } | undefined}
 */
export function encryptionAtHostSkip(storage, featureState) {
	if (storage !== "local-nvme" || featureState === "Registered") return undefined;
	return {
		code: "encryption-at-host-unavailable",
		detail: `Microsoft.Compute/EncryptionAtHost is ${String(featureState)}; the Premium SSD variant runs instead`,
	};
}

/**
 * The `git ls-remote` patterns that list `ref` and, for an annotated tag, the commit it points at. git matches each
 * pattern against the tail of every refname, so the listing also holds longer refs such as `refs/heads/release/<ref>`.
 * @param {string} ref
 */
export function remoteRefPatterns(ref) {
	return [ref, `${ref}^{}`];
}

/**
 * The commit `ref` names in a `git ls-remote` listing, and the full refname it was resolved through. Only exact names
 * count: a full refname (`refs/...`) as given, otherwise `refs/tags/<ref>` or `refs/heads/<ref>`. An annotated tag
 * resolves to the commit it points at. A short name that is a tag and a branch at different commits is ambiguous.
 * @param {string} listing
 * @param {string} ref
 * @returns {{ sha: string, refname: string }}
 */
export function selectRemoteRef(listing, ref) {
	/** @type {Map<string, string>} */
	const shas = new Map();
	for (const line of listing.split("\n")) {
		const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim());
		if (match !== null) shas.set(match[2], match[1]);
	}
	const names = ref.startsWith("refs/") ? [ref] : [`refs/tags/${ref}`, `refs/heads/${ref}`];
	const found = names.flatMap((refname) => {
		const sha = shas.get(`${refname}^{}`) ?? shas.get(refname);
		return sha === undefined ? [] : [{ sha, refname }];
	});
	if (found.length === 0) {
		throw new DistributedConfigError({
			source: "cli",
			field: "--ref",
			reason: "unknown-name",
			expected: "a commit SHA, or a branch or tag pushed to origin",
			actual: ref,
		});
	}
	if (found.some((candidate) => candidate.sha !== found[0].sha)) {
		throw new DistributedConfigError({
			source: "cli",
			field: "--ref",
			reason: "ambiguous",
			expected: found.map((candidate) => candidate.refname).join(" or "),
			actual: ref,
		});
	}
	return found[0];
}

/**
 * A run id: `adt`, the UTC minute as YYMMDDHHmm, and four hex digits.
 * @param {Date} now
 * @param {number} entropy
 */
export function newRunId(now, entropy) {
	const pad = (/** @type {number} */ value) => String(value).padStart(2, "0");
	const stamp = `${pad(now.getUTCFullYear() % 100)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
	return `adt${stamp}-${(entropy & 0xffff).toString(16).padStart(4, "0")}`;
}

/**
 * @typedef {{ name: string, kind: "node" | "database", template: string, roles: string[], region: string, size: string,
 *   hostIndex: number, secondaryNic: boolean, dataDisk: boolean, encryptionAtHost: boolean, dbRole?: "primary" | "replica" }} VmPlan
 * @typedef {{ runId: string, resourceGroup: string, location: string, expiresAt: string, regions: string[],
 *   vnetRegions: string[], vms: VmPlan[], options: RunOptions }} RunPlan
 */

/**
 * The VMs and regions a run creates. Nodes take the topology's templates in order and are spread over `regions`
 * round-robin; nodes beyond the templates use `extraNode`. When no template in use carries the `vm-faults` role, the
 * last node takes it and a second NIC, so the VM-level profiles always have a target. The database primary is in its
 * topology region and the replica in `dbRegion`.
 * @param {RunOptions} options
 * @param {Topology} topology
 * @param {{ runId: string, now: Date }} context
 * @returns {RunPlan}
 */
export function buildPlan(options, topology, { runId, now }) {
	/** @type {VmPlan[]} */
	const vms = [];
	for (let index = 0; index < options.nodes; index++) {
		const template = topology.nodes[index] ?? topology.extraNode;
		vms.push({
			name: `${runId}-n${index + 1}`,
			kind: "node",
			template: template.name,
			roles: [...template.roles],
			region: options.regions[index % options.regions.length],
			size: template.size,
			hostIndex: 20 + index,
			secondaryNic: template.secondaryNic,
			dataDisk: false,
			encryptionAtHost: false,
		});
	}
	const nvme = options.dbStorage === "local-nvme";
	for (const [dbRole, host, region, hostIndex] of /** @type {const} */ ([
		["primary", topology.database.primary, topology.database.primary.region, 10],
		["replica", topology.database.replica, options.dbRegion, 11],
	])) {
		vms.push({
			name: `${runId}-db-${dbRole}`,
			kind: "database",
			template: `database-${dbRole}`,
			roles: [`sqld-${dbRole}`],
			region,
			size: nvme ? topology.database.localNvmeSize : host.size,
			hostIndex,
			secondaryNic: false,
			dataDisk: !nvme,
			encryptionAtHost: nvme,
			dbRole,
		});
	}
	const nodes = vms.filter((vm) => vm.kind === "node");
	if (!nodes.some((vm) => vm.roles.includes("vm-faults"))) {
		const target = /** @type {VmPlan} */ (nodes.at(-1));
		target.roles.push("vm-faults");
		target.secondaryNic = true;
	}
	/** @type {string[]} */
	const vnetRegions = [];
	for (const region of [...options.regions, ...vms.map((vm) => vm.region)]) {
		if (!vnetRegions.includes(region)) vnetRegions.push(region);
	}
	return {
		runId,
		resourceGroup: `${runId}-rg`,
		location: options.regions[0],
		expiresAt: new Date(now.getTime() + options.ttlHours * 3_600_000).toISOString(),
		regions: [...options.regions],
		vnetRegions,
		vms,
		options,
	};
}
