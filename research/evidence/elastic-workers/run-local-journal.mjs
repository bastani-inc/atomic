#!/usr/bin/env node
// Per-host ceiling (#4768): the same fan-out on one machine's own default journal store (no shared database), with
// W local workers. This is what a host checkpointing locally can sustain before shipping enters the picture.
//   node research/evidence/elastic-workers/run-local-journal.mjs --workers 4,8 --children 64 --steps 20 --out <file>
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./stats.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
	process.argv.slice(2).reduce((pairs, value, index, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs), []),
);
const trials = [];
for (const workers of (args.workers ?? "4").split(",").map(Number)) {
	const work = mkdtempSync(join(tmpdir(), "elastic-local-"));
	const resultFile = join(work, "result.json");
	const child = spawn(process.execPath, [join(here, "bench-root.mjs")], {
		env: {
			...process.env,
			ELASTIC_LOCAL: "1",
			ATOMIC_CODING_AGENT_DIR: join(work, "agent"),
			ELASTIC_CHILDREN: args.children ?? "64",
			ELASTIC_STEPS: args.steps ?? "20",
			ELASTIC_ROOT_WORKERS: String(workers),
			ELASTIC_RESULT_FILE: resultFile,
		},
		stdio: ["ignore", "ignore", "inherit"],
		detached: true,
	});
	const timer = setTimeout(() => process.kill(-child.pid, "SIGKILL"), Number(args["run-timeout-ms"] ?? 600_000));
	const code = await new Promise((resolve) => child.on("exit", resolve));
	clearTimeout(timer);
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {}
	const trial = code === 0 ? { workers, ...summarize(JSON.parse(readFileSync(resultFile, "utf8"))) } : { workers, status: "error", code };
	process.stderr.write(`${JSON.stringify({ ...trial, perHost: undefined })}\n`);
	trials.push(trial);
	rmSync(work, { recursive: true, force: true });
}
const out = args.out ?? join(here, "results", "local-journal.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ trials }, null, 2));
