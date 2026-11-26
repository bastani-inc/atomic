// @ts-check
/**
 * The command line of test/distributed/run.mjs, its suites and faults, and the plan a set of options makes. Pure: no
 * Docker, no files, so the unit tests (test/unit/distributed-options.test.ts) cover it whole.
 */

/**
 * @typedef {object} Suite
 * @property {string} name
 * @property {string} file the scenario file, relative to the repository root
 * @property {string} summary what it checks, for --help and the report
 * @property {number} [minNodes] the fewest nodes it needs
 * @property {boolean} [needsReplica] whether it needs the streaming replica
 */

/** @type {readonly Suite[]} */
export const SUITES = [
	{
		name: "security",
		file: "test/distributed/scenarios/security.test.ts",
		summary: "TLS and SCRAM everywhere, no superuser or plaintext over the network, no DDL for the runtime role",
	},
	{
		name: "intercom-routing",
		file: "test/distributed/scenarios/intercom-routing.test.ts",
		summary: "messages between brokers on different nodes arrive once and in order, woken by LISTEN/NOTIFY",
		minNodes: 3,
	},
	{
		name: "broker-failover",
		file: "test/distributed/scenarios/broker-failover.test.ts",
		summary: "a killed, frozen or cut-off broker loses no message, and other nodes keep routing meanwhile",
		minNodes: 3,
	},
	{
		name: "session-handoff",
		file: "test/distributed/scenarios/session-handoff.test.ts",
		summary: "an Intercom session that moves to another node keeps its id and gets every message once",
		minNodes: 3,
	},
	{
		name: "resume",
		file: "test/distributed/scenarios/resume.test.ts",
		summary: "a session killed on one node resumes on another in a byte-identical tree, also on a node without Git",
		minNodes: 3,
	},
	{
		name: "fork",
		file: "test/distributed/scenarios/fork.test.ts",
		summary:
			"a session recorded on one node is forked and continued on another, and the original continues on a third",
		minNodes: 3,
	},
	{
		name: "wake-ups",
		file: "test/distributed/scenarios/wake-ups.test.ts",
		summary: "a released subagent wakes on another node; a partition during the wake fails typed and a retry works",
		minNodes: 2,
	},
	{
		name: "replica",
		file: "test/distributed/scenarios/replica.test.ts",
		summary: "the streaming replica serves sessions the nodes wrote, and refuses writes",
		needsReplica: true,
	},
	{
		name: "database-faults",
		file: "test/distributed/scenarios/database-faults.test.ts",
		summary: "sessions and Intercom keep every acknowledged write and deliver once, through each fault in turn",
		minNodes: 3,
	},
];

/** The faults `database-faults` injects, one at a time, in the order the seed picks. */
export const FAULTS = [
	"pgbouncer-restart",
	"primary-restart",
	"primary-pause",
	"node-partition",
	"link-latency",
	"broker-sigkill",
	"broker-sigstop",
	"clock-skew",
	"disk-throttle",
	"disk-full",
];

/** The security suite runs first and alone; a failure stops the run before any other suite. */
export const GATE = "security";

/**
 * @typedef {object} Options
 * @property {readonly string[]} suites
 * @property {readonly string[]} faults
 * @property {number} nodes
 * @property {boolean} replica
 * @property {number} seed
 * @property {boolean} keep
 * @property {string | undefined} reuse
 * @property {string | undefined} out
 * @property {string | undefined} replay
 * @property {boolean} planOnly
 * @property {boolean} help
 * @property {number} diskMb
 */

export const USAGE = `Usage: node test/distributed/run.mjs [options]

Starts PostgreSQL, PgBouncer and a streaming replica with Docker Compose, runs the distributed suites against them
with Atomic nodes as separate processes, writes report.md and report.json, and removes everything it started.

Options:
  --suite <names>      Comma-separated suites, or "all" (default). The security suite always runs first.
  --faults <names>     Faults for database-faults: comma-separated, "all" (default) or "none".
  --nodes <n>          Atomic nodes per multi-node suite (default 3, at least 3).
  --no-replica         Do not start the streaming replica; skips the replica suite.
  --seed <n>           Seed for the order of the faults and the nodes they hit (default: random).
  --disk-mb <n>        Size of each PostgreSQL data disk in MB (default 2048).
  --keep               Leave the database running after the run, for --reuse.
  --reuse <run-id>     Run against the database a --keep run left running.
  --replay <file>      Repeat the suites, faults, nodes and seed recorded in a report.json.
  --out <dir>          Where the run's directory goes (default $XDG_STATE_HOME/atomic-distributed-test/runs).
  --plan-only          Print what would run and exit.
  --help               Show this help.

Suites:
${SUITES.map((suite) => `  ${suite.name.padEnd(18)} ${suite.summary}`).join("\n")}

Faults: ${FAULTS.join(", ")}
`;

/**
 * @param {string} value
 * @param {readonly string[]} known
 * @param {string} what
 */
function list(value, known, what) {
	if (value === "all") return [...known];
	if (value === "none") return [];
	const names = value
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	const unknown = names.filter((name) => !known.includes(name));
	if (unknown.length > 0) throw new Error(`unknown ${what}: ${unknown.join(", ")} (known: ${known.join(", ")})`);
	return [...new Set(names)];
}

/** @param {string} flag @param {string | undefined} value */
function integer(flag, value) {
	const parsed = Number(value);
	if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 0)
		throw new Error(`${flag} needs a non-negative integer`);
	return parsed;
}

/**
 * Parses the command line. `random` picks the seed when none is given.
 * @param {readonly string[]} argv
 * @param {() => number} [random]
 * @returns {Options}
 */
export function parseOptions(argv, random = Math.random) {
	/** @type {Options} */
	const options = {
		suites: SUITES.map((suite) => suite.name),
		faults: [...FAULTS],
		nodes: 3,
		replica: true,
		seed: Math.floor(random() * 2 ** 31),
		keep: false,
		reuse: undefined,
		out: undefined,
		replay: undefined,
		planOnly: false,
		help: false,
		diskMb: 2048,
	};
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = () => {
			const next = argv[++index];
			if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
			return next;
		};
		switch (flag) {
			case "--suite":
				options.suites = list(
					value(),
					SUITES.map((suite) => suite.name),
					"suite",
				);
				break;
			case "--faults":
				options.faults = list(value(), FAULTS, "fault");
				break;
			case "--nodes":
				options.nodes = integer(flag, value());
				break;
			case "--no-replica":
				options.replica = false;
				break;
			case "--seed":
				options.seed = integer(flag, value());
				break;
			case "--disk-mb":
				options.diskMb = integer(flag, value());
				break;
			case "--keep":
				options.keep = true;
				break;
			case "--reuse":
				options.reuse = value();
				break;
			case "--replay":
				options.replay = value();
				break;
			case "--out":
				options.out = value();
				break;
			case "--plan-only":
				options.planOnly = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`unknown option ${flag}; see --help`);
		}
	}
	if (options.nodes < 3) throw new Error("--nodes must be at least 3: resume needs a recording node and two others");
	if (options.diskMb < 256) throw new Error("--disk-mb must be at least 256");
	if (options.reuse !== undefined && !/^[a-z0-9-]+$/.test(options.reuse))
		throw new Error("--reuse needs a run id such as 20261126-101500-ab12");
	return options;
}

/**
 * Takes the options a report.json recorded, keeping only what this run's command line chose about where the run goes.
 * @param {Options} options
 * @param {{ options?: Partial<Options> }} report
 * @returns {Options}
 */
export function replayOptions(options, report) {
	const recorded = report.options;
	if (recorded === undefined) throw new Error("the report records no options to replay");
	return {
		...options,
		suites: list(
			(recorded.suites ?? []).join(","),
			SUITES.map((suite) => suite.name),
			"suite",
		),
		faults: list((recorded.faults ?? []).join(",") || "none", FAULTS, "fault"),
		nodes: recorded.nodes ?? options.nodes,
		replica: recorded.replica ?? options.replica,
		seed: recorded.seed ?? options.seed,
		diskMb: recorded.diskMb ?? options.diskMb,
		replay: undefined,
	};
}

/**
 * A deterministic generator of numbers in [0, 1) from a seed (mulberry32), for the harness's own choices.
 * @param {number} seed
 */
export function seededRandom(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * `items` in the order the seed picks.
 * @template T
 * @param {readonly T[]} items
 * @param {number} seed
 * @returns {T[]}
 */
export function shuffled(items, seed) {
	const random = seededRandom(seed);
	const result = [...items];
	for (let index = result.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[result[index], result[other]] = [result[other], result[index]];
	}
	return result;
}

/**
 * @typedef {object} PlannedSuite
 * @property {string} name
 * @property {string} file
 * @property {"run" | "skip"} action
 * @property {string} [reason] why a suite is skipped
 */

/**
 * What a run with `options` does: the gate first, then the chosen suites in the order SUITES lists them, each run or
 * skipped with the reason; and the faults in the seed's order.
 * @param {Options} options
 * @returns {{ suites: PlannedSuite[], faults: string[], services: string[] }}
 */
export function plan(options) {
	const chosen = new Set([GATE, ...options.suites]);
	/** @type {PlannedSuite[]} */
	const suites = [];
	for (const suite of SUITES) {
		if (!chosen.has(suite.name)) continue;
		if (suite.needsReplica === true && !options.replica)
			suites.push({
				name: suite.name,
				file: suite.file,
				action: "skip",
				reason: "the run has no replica (--no-replica)",
			});
		else if (suite.name === "database-faults" && options.faults.length === 0)
			suites.push({
				name: suite.name,
				file: suite.file,
				action: "skip",
				reason: "no faults chosen (--faults none)",
			});
		else suites.push({ name: suite.name, file: suite.file, action: "run" });
	}
	return {
		suites,
		faults: shuffled(options.faults, options.seed),
		services: ["primary", "pgbouncer", ...(options.replica ? ["replica"] : [])],
	};
}
