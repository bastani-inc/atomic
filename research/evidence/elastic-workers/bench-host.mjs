// A worker host of the elastic-workers benchmark (#4768): what `atomic worker start --db <url> --token-file <f>` would
// run. Joins the shared journal, serves every shared root on it, and drains on SIGTERM.
//   ELASTIC_DB_URL, [ELASTIC_TOKEN_FILE], ELASTIC_PREFIX, ELASTIC_HOST_ID, ELASTIC_AGENT_DIR, ELASTIC_SLOTS
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startWorkflowWorkerHost } from "@bastani/atomic/workflows";

const adapter = process.env.ELASTIC_ADAPTER ?? fileURLToPath(new URL("../../../packages/storage-libsql/libsql.js", import.meta.url));
const agentDir = process.env.ELASTIC_AGENT_DIR;
mkdirSync(agentDir, { recursive: true });
const started = performance.now();
const host = await startWorkflowWorkerHost({
	journal: {
		adapter,
		options: { url: process.env.ELASTIC_DB_URL },
		prefix: process.env.ELASTIC_PREFIX ?? "",
		...(process.env.ELASTIC_TOKEN_FILE ? { secrets: { authToken: { file: process.env.ELASTIC_TOKEN_FILE } } } : {}),
	},
	agentDir,
	maxWorkers: Number(process.env.ELASTIC_SLOTS ?? "4"),
	hostId: process.env.ELASTIC_HOST_ID,
	labels: { bench: "elastic-4768" },
	restore: false,
});
const readyMs = Math.round(performance.now() - started);
if (process.env.ELASTIC_READY_FILE) writeFileSync(process.env.ELASTIC_READY_FILE, JSON.stringify({ readyMs }));
process.stderr.write(`host ${host.hostId} ready in ${readyMs} ms\n`);
const statsFile = process.env.ELASTIC_STATS_FILE;
const stats = statsFile
	? setInterval(() => {
			host
				.stats()
				.then((value) => writeFileSync(statsFile, JSON.stringify({ at: Date.now(), ...value })))
				.catch(() => {});
		}, 2_000)
	: undefined;
let stopping = false;
const stop = (how) => () => {
	if (stopping) return;
	stopping = true;
	clearInterval(stats);
	const began = performance.now();
	void host[how]()
		.then(() => {
			process.stderr.write(`host ${host.hostId} ${how} in ${Math.round(performance.now() - began)} ms\n`);
			process.exit(0);
		})
		.catch((error) => {
			process.stderr.write(`${error?.stack ?? error}\n`);
			process.exit(1);
		});
};
process.once("SIGTERM", stop("drain"));
process.once("SIGINT", stop("stop"));
