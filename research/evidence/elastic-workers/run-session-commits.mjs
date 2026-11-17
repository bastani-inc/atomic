#!/usr/bin/env node
// Shared-writer commits per child step for agent-stage children (#4768): one root with shared placement and its own
// workers runs children of session-commits-child.mjs on a libSQL file (or the server at --url), once per mode, with
// every process opening the journal through counting-adapter.mjs, which logs each write commit it makes. A child step
// is one `ctx.tool` call or one agent stage's turn. Runs two workloads per mode, `--stages` and twice that, and reports
// the marginal commits per step between them, which leaves out what a run costs whatever its children do (the
// schema, the root's own writes, claims and completions).
//   node research/evidence/elastic-workers/run-session-commits.mjs --tree <checkout> --modes sync,ship \
//     [--children 8] [--stages 2] [--workers 4] [--url http://127.0.0.1:8080] [--out results/x.json]
// `--tree` is the checkout whose build runs (`npm ci --ignore-scripts && npm run build` there first); the scripts are
// copied into it, so a checkout from before they existed measures the same way.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const tree = resolve(args.tree ?? join(here, "../../.."));
const modes = (args.modes ?? "sync,ship").split(",");
const children = Number(args.children ?? 8);
const stages = Number(args.stages ?? 2);
const workers = Number(args.workers ?? 4);
const shipping = JSON.stringify({ intervalMs: 2000, maxBatch: 64, maxLagMs: 30000 });
const scripts = join(tree, "research/evidence/elastic-workers");
mkdirSync(scripts, { recursive: true });
for (const file of ["counting-adapter.mjs", "session-commits-child.mjs", "session-commits-root.mjs"])
	if (resolve(scripts) !== resolve(here)) copyFileSync(join(here, file), join(scripts, file));
const commit = spawnSync("git", ["-C", tree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

function trial(mode, stageCount) {
	const scratch = mkdtempSync(join(tmpdir(), "session-commits-"));
	try {
		const counting = join(scratch, "commits");
		const resultFile = join(scratch, "result.json");
		const prefix = args.url === undefined ? "" : `sc${Date.now().toString(36)}_`;
		const run = spawnSync(process.execPath, [join(scripts, "session-commits-root.mjs")], {
			cwd: scratch,
			encoding: "utf8",
			timeout: 900_000,
			env: {
				...process.env,
				ATOMIC_CODING_AGENT_DIR: join(scratch, "agent"),
				COUNTING_DIR: counting,
				COUNTING_INNER_ADAPTER: pathToFileURL(join(tree, "packages/storage-libsql/libsql.js")).href,
				SC_ADAPTER: join(scripts, "counting-adapter.mjs"),
				SC_DB_URL: args.url ?? pathToFileURL(join(scratch, "shared.db")).href,
				SC_PREFIX: prefix,
				SC_CHILDREN: String(children),
				SC_STAGES: String(stageCount),
				SC_WORKERS: String(workers),
				SC_SHIPPING: mode === "sync" ? "sync" : shipping,
				SC_RESULT_FILE: resultFile,
			},
		});
		let result;
		try {
			result = JSON.parse(readFileSync(resultFile, "utf8"));
		} catch {
			throw new Error(`the ${mode} run wrote no result (exit ${run.status}):\n${run.stdout.slice(-2000)}\n${run.stderr.slice(-6000)}`);
		}
		if (result.status !== "completed" || result.outcomes.some((outcome) => outcome.status !== "completed"))
			throw new Error(`the ${mode} run did not complete: ${JSON.stringify(result).slice(0, 2000)}\n${run.stderr.slice(-4000)}`);
		const byTable = {};
		let commits = 0;
		for (const file of readdirSync(counting))
			for (const line of readFileSync(join(counting, file), "utf8").split("\n").filter(Boolean)) {
				commits++;
				const [kind, table] = line.split(" ");
				const key = `${kind} ${table.replace(/^.*?(wf_|snapshot_)/, "$1")}`;
				byTable[key] = (byTable[key] ?? 0) + 1;
			}
		const steps = children * stageCount * 2;
		return { mode, stages: stageCount, children, steps, commits, commitsPerStep: commits / steps, wallMs: result.wallMs, byTable };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const trials = [];
for (const mode of modes)
	for (const stageCount of [stages, stages * 2]) {
		const measured = trial(mode, stageCount);
		trials.push(measured);
		process.stderr.write(`${mode} stages=${stageCount}: ${measured.commits} commits for ${measured.steps} steps (${measured.commitsPerStep.toFixed(2)} per step)\n`);
	}
const marginal = Object.fromEntries(
	modes.map((mode) => {
		const [small, large] = trials.filter((trial) => trial.mode === mode);
		return [mode, (large.commits - small.commits) / (large.steps - small.steps)];
	}),
);
const output = { commit, store: args.url === undefined ? "libsql-file" : "sqld", children, workers, trials, marginalCommitsPerStep: marginal };
if (args.out !== undefined) writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ commit, marginalCommitsPerStep: marginal, totals: trials.map(({ mode, stages: s, commits, steps }) => ({ mode, stages: s, commits, steps })) }));
