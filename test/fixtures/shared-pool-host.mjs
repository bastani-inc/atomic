import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// A worker host of a shared pool (#4310), standing in for another machine: SHARED_POOL_HOST names it, and it has its
// own agent directory. SHARED_POOL_RESTORE makes it restore any binding to that directory, SHARED_POOL_WARM makes it hold
// every binding's tree warm there, and SHARED_POOL_GIT_MISSING leaves it without git. It writes its stats to
// host-stats-<host>.json, replacing it whole so a test never reads it half written (#4511), and stops on SIGTERM.
const [directory, maxWorkers] = process.argv.slice(2);
const host = process.env.SHARED_POOL_HOST;
const jiti = createJiti(import.meta.url, { fsCache: true });
const { startWorkflowWorkerHost } = await jiti.import(
	fileURLToPath(new URL("../../packages/workflows/src/workers/worker-host.ts", import.meta.url)),
);
const { writeFileAtomically } = await jiti.import(
	fileURLToPath(new URL("../helpers/atomic-file-write.ts", import.meta.url)),
);
const restored = process.env.SHARED_POOL_RESTORE;
const workerHost = await startWorkflowWorkerHost({
	journal: {
		adapter: process.env.SHARED_POOL_ADAPTER,
		options: { url: process.env.SHARED_POOL_URL },
		prefix: process.env.SHARED_POOL_PREFIX,
		...(process.env.SHARED_POOL_TOKEN_FILE === undefined
			? {}
			: { secrets: { authToken: { file: process.env.SHARED_POOL_TOKEN_FILE } } }),
	},
	agentDir: process.env.SHARED_POOL_AGENT_DIR,
	maxWorkers: Number(maxWorkers),
	hostId: host,
	labels: { stand_in: host },
	...(restored === undefined
		? {}
		: {
				restore: async (binding) => {
					writeFileSync(join(directory, `restored-${host}-${binding.tree}`), "");
					return restored;
				},
			}),
	...(process.env.SHARED_POOL_GIT_MISSING === "1" ? { git: { path: join(directory, "no-such-git"), env: {} } } : {}),
	// A host with a binding's tree warm at SHARED_POOL_WARM takes bound work there first, without restoring it.
	...(process.env.SHARED_POOL_WARM === undefined
		? {}
		: { placement: { prefer: async () => process.env.SHARED_POOL_WARM } }),
});
const report = async () => {
	await writeFileAtomically(join(directory, `host-stats-${host}.json`), JSON.stringify(await workerHost.stats()));
};
await report();
writeFileSync(join(directory, `host-ready-${host}`), "");
// One report at a time: over a slow link a report can take longer than the interval, and overlapping ones would queue
// behind each other on the host's journal connection without end.
let reporting;
let reportFailed = false;
const reporter = setInterval(() => {
	reporting ??= report()
		.catch((error) => {
			if (reportFailed) return;
			reportFailed = true;
			process.stderr.write(`host ${host} failed a stats report; later reports retry: ${error?.stack ?? error}\n`);
		})
		.finally(() => {
			reporting = undefined;
		});
}, 250);
process.once("SIGTERM", () => {
	clearInterval(reporter);
	void workerHost
		.stop()
		.then(() => process.exit(0))
		.catch((error) => {
			process.stderr.write(`${error?.stack ?? error}\n`);
			process.exit(1);
		});
});
