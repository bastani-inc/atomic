#!/usr/bin/env node
// @ts-check
/**
 * Runs the distributed suites (docs/distributed-tests.md): starts PostgreSQL, PgBouncer and a streaming replica with
 * Docker Compose, checks the security gate, runs the chosen suites with Atomic nodes as separate processes, writes
 * report.md and report.json to the run's directory, and removes what it started. See --help.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GATE, parseOptions, plan, replayOptions, USAGE } from "./harness/options.mjs";
import { buildReport, redact, renderMarkdown, suiteResult } from "./harness/report.mjs";
import {
	COMPOSE_FILE,
	down,
	freePorts,
	projectName,
	publishedPort,
	up,
	writeCertificates,
	writeSecrets,
} from "./harness/stack.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");

/** @param {string} message */
function say(message) {
	process.stdout.write(`[distributed] ${message}\n`);
}

/** @param {string} tool @param {string[]} args */
function requireTool(tool, args) {
	const result = spawnSync(tool, args, { stdio: "ignore" });
	if (result.error !== undefined || result.status !== 0)
		throw new Error(`${tool} is required: install it and put it on PATH`);
}

function commit() {
	try {
		const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim() !== "";
		return dirty ? `${sha} (with uncommitted changes)` : sha;
	} catch {
		return "unknown";
	}
}

function runsDirectory(/** @type {string | undefined} */ out) {
	if (out !== undefined) return resolve(out);
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "atomic-distributed-test", "runs");
}

function newRunId() {
	const now = new Date();
	const pad = (/** @type {number} */ value) => String(value).padStart(2, "0");
	const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
	const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
	return `${date}-${time}-${randomBytes(2).toString("hex")}`;
}

/**
 * Runs vitest on `files` with the distributed config, writing its JSON report to `output`.
 * @param {string[]} files
 * @param {string} output
 * @param {string} topologyFile
 */
function vitest(files, output, topologyFile) {
	spawnSync(
		process.execPath,
		[
			join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
			"run",
			"--config",
			"test/distributed/vitest.config.ts",
			"--reporter=default",
			"--reporter=json",
			`--outputFile.json=${output}`,
			...files,
		],
		{ cwd: repoRoot, stdio: "inherit", env: { ...process.env, ATOMIC_DISTRIBUTED_TOPOLOGY: topologyFile } },
	);
	return existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : undefined;
}

async function main() {
	let options = parseOptions(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (options.replay !== undefined) options = replayOptions(options, JSON.parse(readFileSync(options.replay, "utf8")));
	const planned = plan(options);
	const runId = options.reuse ?? newRunId();
	const runDir = join(runsDirectory(options.out), runId);
	say(`run ${runId} in ${runDir}`);
	say(
		`services: ${planned.services.join(", ")}; ${options.nodes} Atomic nodes per multi-node suite; seed ${options.seed}`,
	);
	for (const suite of planned.suites)
		say(
			`  ${suite.action === "run" ? "run " : "skip"} ${suite.name}${suite.reason === undefined ? "" : ` (${suite.reason})`}`,
		);
	if (planned.faults.length > 0) say(`faults, in order: ${planned.faults.join(", ")}`);
	if (options.planOnly) return 0;

	requireTool("docker", ["compose", "version"]);
	requireTool("openssl", ["version"]);
	requireTool("bun", ["--version"]);
	requireTool("git", ["--version"]);
	if (!existsSync(join(repoRoot, "packages", "coding-agent", "dist", "cli.js")))
		throw new Error("this checkout is not built: run npm run build first");

	const startedAt = new Date().toISOString();
	/** @type {{ project: string, envFile: string, profiles: string[] }} */
	let stack;
	/** @type {{ owner: { user: string, passwordFile: string }, runtime: { user: string, passwordFile: string }, superuser: { user: string, passwordFile: string }, pgbouncerAuth: { user: string, passwordFile: string } }} */
	let roles;
	/** @type {{ ca: string, decoyCa: string }} */
	let tls;
	const profiles = options.replica ? ["replica"] : [];
	if (options.reuse !== undefined) {
		const previous = JSON.parse(readFileSync(join(runDir, "topology.json"), "utf8"));
		stack = {
			project: previous.compose.project,
			envFile: previous.compose.envFile,
			profiles: previous.compose.profiles,
		};
		if (options.replica !== stack.profiles.includes("replica"))
			throw new Error(
				`run ${runId} was started ${stack.profiles.includes("replica") ? "with" : "without"} the replica; pass the same --no-replica choice`,
			);
		roles = previous.roles;
		tls = previous.tls;
		say(`reusing ${stack.project}`);
		up(stack);
	} else {
		mkdirSync(runDir, { recursive: true });
		const [primary, pgbouncer, replica] = await freePorts(3);
		const written = writeSecrets(runDir, { diskMb: options.diskMb, ports: { primary, pgbouncer, replica } });
		say("generating TLS certificates");
		tls = writeCertificates(written.tlsDir);
		stack = { project: projectName(runId), envFile: written.envFile, profiles };
		roles = written.roles;
		writeFileSync(
			join(runDir, "state.json"),
			`${JSON.stringify({ runId, project: stack.project, createdAt: startedAt }, null, "\t")}\n`,
		);
		say(`starting ${stack.project}`);
		up(stack);
	}

	const secrets = Object.values(roles).map((role) => readFileSync(role.passwordFile, "utf8").trim());
	let interrupted = false;
	process.on("SIGINT", () => {
		interrupted = true;
	});
	/** @type {import("./harness/report.mjs").SuiteResult[]} */
	let suites = [];
	/** @type {string | undefined} */
	let error;
	let gatePassed = false;
	try {
		const topology = {
			schemaVersion: 1,
			runId,
			runDir,
			compose: { project: stack.project, file: COMPOSE_FILE, envFile: stack.envFile, profiles: stack.profiles },
			database: "atomic",
			primary: publishedPort(stack, "primary", 5432),
			pgbouncer: publishedPort(stack, "pgbouncer", 6432),
			...(options.replica ? { replica: publishedPort(stack, "replica", 5432) } : {}),
			tls,
			roles: {
				owner: roles.owner,
				runtime: roles.runtime,
				superuser: roles.superuser,
				pgbouncerAuth: roles.pgbouncerAuth,
			},
			nodes: options.nodes,
			seed: options.seed,
			faults: planned.faults,
		};
		const topologyFile = join(runDir, "topology.json");
		writeFileSync(topologyFile, `${JSON.stringify(topology, null, "\t")}\n`, { mode: 0o600 });

		const gate = planned.suites.find((suite) => suite.name === GATE);
		const rest = planned.suites.filter((suite) => suite.name !== GATE);
		say("security gate");
		const gateReport =
			gate === undefined ? undefined : vitest([gate.file], join(runDir, "vitest-gate.json"), topologyFile);
		const gateResult = gate === undefined ? undefined : suiteResult(gate, gateReport, secrets);
		gatePassed = gateResult?.status === "passed";
		/** @type {any} */
		let suitesReport;
		if (!gatePassed) error = "the security gate failed, so no other suite ran";
		else if (interrupted) error = "interrupted";
		else {
			const files = rest.filter((suite) => suite.action === "run").map((suite) => suite.file);
			if (files.length > 0) suitesReport = vitest(files, join(runDir, "vitest-suites.json"), topologyFile);
			if (interrupted) error = "interrupted";
		}
		suites = planned.suites.map((suite) =>
			suiteResult(suite, suite.name === GATE ? gateReport : suitesReport, secrets),
		);
	} catch (thrown) {
		error = redact(thrown instanceof Error ? thrown.message : String(thrown), secrets);
	}

	/** @type {{ status: "removed" | "kept" | "failed", detail?: string }} */
	let teardown;
	if (options.keep && gatePassed) {
		teardown = { status: "kept", detail: `reuse it with --reuse ${runId}` };
	} else {
		say(`removing ${stack.project}`);
		try {
			const left = down(stack);
			teardown =
				left.length === 0
					? { status: "removed" }
					: {
							status: "failed",
							detail: `still there: ${left.join(", ")}. Run node test/distributed/sweep.mjs --run-id ${runId} --force`,
						};
		} catch (thrown) {
			teardown = { status: "failed", detail: thrown instanceof Error ? thrown.message : String(thrown) };
		}
	}

	const eventsFile = join(runDir, "events.jsonl");
	const events = existsSync(eventsFile)
		? readFileSync(eventsFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	const report = buildReport({
		runId,
		commit: commit(),
		startedAt,
		finishedAt: new Date().toISOString(),
		options: {
			suites: options.suites,
			faults: options.faults,
			nodes: options.nodes,
			replica: options.replica,
			seed: options.seed,
			diskMb: options.diskMb,
		},
		faultOrder: planned.faults,
		suites,
		events,
		teardown,
		...(error === undefined ? {} : { error }),
	});
	writeFileSync(join(runDir, "report.json"), `${JSON.stringify(report, null, "\t")}\n`);
	writeFileSync(join(runDir, "report.md"), renderMarkdown(report));
	say(`${report.status}: ${join(runDir, "report.md")}`);
	return report.status === "passed" ? 0 : 1;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(`[distributed] ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	},
);
