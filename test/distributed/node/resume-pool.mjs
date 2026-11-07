#!/usr/bin/env node
// @ts-check
/**
 * Node-side driver of the pooled-campaign scenario of the `multi-node-resume` suite (#4329, scenario 3). It runs
 * against the deployed ref, loading the ref's TypeScript sources through the ref's own jiti, and every child it runs is
 * the ref's `test/fixtures/multinode-pool-child.ts`, at the same path on every node. The reduced CI test drives the same
 * child with `test/fixtures/multinode-pool-root.mjs` and `test/fixtures/shared-pool-host.mjs`; this driver adds what a
 * real database needs, a namespace and a token file, which those fixtures do not take. Credentials are read from files
 * and never printed.
 *
 *   host --ref-dir D --dir W --name H --agent-dir A --workers N [--setup-log L] <journal>
 *       Starts a worker host (`startWorkflowWorkerHost`) with its own agent directory A and host id H. With
 *       --setup-log, A's global settings set `resume.setupCommand` to append each worktree it sets up to L. Writes
 *       `W/host-ready-H` once it serves, and its stats to `W/host-stats-H.json` every second, with `maxBusy`, the most
 *       workers it ever ran a child on. Stops on SIGTERM.
 *   root --ref-dir D --dir W --root R --worktree P --agent-dir A --children N --workers K --lease-ms L
 *        --claim-window-ms C <journal>
 *       Runs root R with `workers: { placement: "shared" }`, bound to the worktree P, with N children. Writes
 *       `W/outcome-start.json` when the root ends.
 *   work --ref-dir D --root R <journal>
 *       Prints the root's work rows and the number of checkpoint keys its runs recorded more than once.
 *
 * <journal> is `--url U --prefix P [--namespace N --token-file F]`, opened through the ref's libSQL adapter.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [command, ...rest] = process.argv.slice(2);
/** @type {Record<string, string>} */
const flags = {};
for (let index = 0; index < rest.length; index += 2) flags[rest[index].replace(/^--/, "")] = rest[index + 1];

/** @param {string} name */
function flag(name) {
	const value = flags[name];
	if (value === undefined) throw new TypeError(`resume-pool ${command} needs --${name}`);
	return value;
}

/** @param {string} name */
function count(name) {
	const value = Number(flag(name));
	if (!Number.isInteger(value) || value < 0)
		throw new RangeError(`resume-pool ${command} --${name} must be an integer`);
	return value;
}

/** @param {unknown} value */
function print(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * A credential-free description of a thrown value: its name, code and first message line, and the same for its cause.
 * @param {unknown} error
 * @param {number} [depth]
 * @returns {{ name: string, code: string | null, message: string, cause?: ReturnType<typeof describe> }}
 */
function describe(error, depth = 0) {
	if (typeof error !== "object" || error === null) return { name: "NonError", code: null, message: String(error) };
	const code = Reflect.get(error, "code");
	const cause = Reflect.get(error, "cause");
	return {
		name: String(Reflect.get(error, "name") ?? "Error"),
		code: typeof code === "string" ? code : null,
		message: (String(Reflect.get(error, "message") ?? "").split("\n")[0] ?? "")
			.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]")
			.slice(0, 300),
		...(depth < 4 && typeof cause === "object" && cause !== null ? { cause: describe(cause, depth + 1) } : {}),
	};
}

/** Writes `content` to `path` whole, so a reader never sees it half written. @param {string} path @param {string} content */
function replaceFile(path, content) {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, content);
	renameSync(temporary, path);
}

const refDir = flag("ref-dir");
const refRequire = createRequire(join(refDir, "package.json"));
const { createJiti } = await import(
	pathToFileURL(join(dirname(refRequire.resolve("jiti/package.json")), "lib", "jiti.mjs")).href
);
const jiti = createJiti(join(refDir, "package.json"), { fsCache: true });
/** @param {string} path a file of the deployed ref, relative to its root */
const source = (path) => jiti.import(join(refDir, path));
const adapter = join(refDir, "packages", "storage-libsql", "libsql.js");

/** The shared journal, as every process of the campaign selects it. */
function journal() {
	const namespace = flags.namespace;
	const tokenFile = flags["token-file"];
	return {
		adapter,
		options: { url: flag("url"), ...(namespace === undefined ? {} : { namespace }) },
		prefix: flag("prefix"),
		...(tokenFile === undefined ? {} : { secrets: { authToken: { file: tokenFile } } }),
	};
}

async function host() {
	const dir = flag("dir");
	const name = flag("name");
	const agentDir = flag("agent-dir");
	// Every worker this host starts inherits these; the child reports SHARED_POOL_HOST as the host that ran it.
	process.env.SHARED_POOL_HOST = name;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	const setupLog = flags["setup-log"];
	if (setupLog !== undefined)
		writeFileSync(
			join(agentDir, "settings.json"),
			`${JSON.stringify({ resume: { setupCommand: `printf '%s\\n' "$ATOMIC_RESUME_WORKTREE" >> '${setupLog}'` } })}\n`,
		);
	const { startWorkflowWorkerHost } = await source("packages/workflows/src/workers/worker-host.ts");
	const workerHost = await startWorkflowWorkerHost({
		journal: journal(),
		agentDir,
		maxWorkers: count("workers"),
		hostId: name,
		labels: { stand_in: name },
	});
	let maxBusy = 0;
	const report = async () => {
		const stats = await workerHost.stats();
		maxBusy = Math.max(maxBusy, stats.busy);
		replaceFile(join(dir, `host-stats-${name}.json`), JSON.stringify({ ...stats, maxBusy }));
	};
	await report();
	writeFileSync(join(dir, `host-ready-${name}`), "");
	// One report at a time: over a slow link a report can outlast the interval.
	let reporting = false;
	const reporter = setInterval(() => {
		if (reporting) return;
		reporting = true;
		void report()
			.catch((error) => process.stderr.write(`${JSON.stringify({ statsFailed: describe(error) })}\n`))
			.finally(() => {
				reporting = false;
			});
	}, 1_000);
	process.once("SIGTERM", () => {
		clearInterval(reporter);
		void workerHost
			.stop()
			.then(() => process.exit(0))
			.catch((/** @type {unknown} */ error) => {
				print({ error: describe(error) });
				process.exit(1);
			});
	});
}

async function root() {
	const dir = flag("dir");
	const agentDir = flag("agent-dir");
	process.env.SHARED_POOL_HOST = "R";
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	const { workflow } = await source("packages/workflows/src/authoring/workflow.ts");
	const { JournalDurableBackend } = await source("packages/workflows/src/durable/journal/journal-backend.ts");
	const { resolveRunJournal } = await source("packages/workflows/src/durable/journal/resolution.ts");
	const { run } = await source("packages/workflows/src/engine/run.ts");
	const { createStore } = await source("packages/workflows/src/shared/store.ts");
	const { loadWorkerWorkflow } = await source("packages/workflows/src/workers/definitions.ts");
	const { workspace } = await jiti.import("@bastani/atomic");
	const childPath = join(refDir, "test", "fixtures", "multinode-pool-child.ts");
	const exportName = "campaignChild";
	const worktree = flag("worktree");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ agentDir, journal: journal() }));
	try {
		const child = await loadWorkerWorkflow(childPath, exportName);
		/** @type {object[]} */
		const outcomes = [];
		const parent = workflow({
			name: "multinode-pool-root",
			description: "A root whose children run on the worker hosts of other nodes",
			inputs: {},
			outputs: {},
			/** @param {{ workflow: (definition: object, options: object) => Promise<{ status: string, error?: string, outputs?: object }> }} ctx */
			async run(ctx) {
				const results = await Promise.allSettled(
					Array.from({ length: count("children") }, (_, index) =>
						ctx.workflow(child, { inputs: { directory: dir, index } }),
					),
				);
				for (const result of results)
					outcomes.push(
						result.status === "fulfilled"
							? { status: result.value.status, error: result.value.error ?? null, ...result.value.outputs }
							: { status: "rejected", error: describe(result.reason) },
					);
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{
				runId: flag("root"),
				cwd: dir,
				store: createStore(),
				durableBackend: backend,
				localWorkers: {
					count: count("workers"),
					definitions: [{ path: childPath, exportName }],
					leaseMs: count("lease-ms"),
				},
				workers: {
					placement: "shared",
					workspace: workspace({ repo: worktree, branch: "main", base: "main", worktree }),
					claimWindowMs: count("claim-window-ms"),
				},
				admission: { limits: { session: 8 } },
			},
		);
		replaceFile(
			join(dir, "outcome-start.json"),
			JSON.stringify({
				status: result.status,
				error: result.error === undefined ? null : describe(result.error),
				children: outcomes,
			}),
		);
	} finally {
		await backend.close();
	}
}

async function work() {
	const { openLibsqlDatabase } = await import(pathToFileURL(adapter).href);
	const tokenFile = flags["token-file"];
	const database = await openLibsqlDatabase({
		url: flag("url"),
		...(flags.namespace === undefined ? {} : { namespace: flags.namespace }),
		...(tokenFile === undefined ? {} : { authToken: readFileSync(tokenFile, "utf8").trim() }),
	});
	const prefix = flag("prefix");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new TypeError("resume-pool work needs an identifier prefix");
	try {
		const rows = await database.all(
			`SELECT state, generation, worker FROM ${prefix}wf_runs_work WHERE root = ? ORDER BY generation`,
			flag("root"),
		);
		const repeated = await database.all(
			`SELECT key, COUNT(*) AS n FROM ${prefix}wf_events WHERE key IS NOT NULL GROUP BY run_id, key HAVING COUNT(*) > 1`,
		);
		print({
			work: rows.map((/** @type {Record<string, unknown>} */ row) => ({
				state: String(row.state),
				generation: Number(row.generation),
				worker: String(row.worker),
			})),
			repeatedCheckpoints: repeated.length,
		});
	} finally {
		await database.close();
	}
}

try {
	if (command === "host") await host();
	else if (command === "root") {
		await root();
		process.exit(0);
	} else if (command === "work") {
		await work();
		process.exit(0);
	} else throw new TypeError(`unknown resume-pool command ${command}`);
} catch (error) {
	print({ error: describe(error) });
	process.exit(1);
}
