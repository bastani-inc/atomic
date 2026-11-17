import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlSharedPool } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import { definitionDigest } from "../../packages/workflows/src/workers/definitions.js";
import { makeLibsqlDirectory, removeLibsqlDirectory } from "../helpers/libsql-cleanup.js";
import { sleep } from "../helpers/runtime.js";
import {
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	libsql,
	PREFIX,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";

const SHIPPING = { intervalMs: 2_000, maxBatch: 64, maxLagMs: 30_000 } as const;

/** How long a host takes at most to let go of a root once the root's run ended. */
const LET_GO_MS = 20_000;

/** The root's local checkpoint journals under a host's pool state directory. */
function localJournals(ship: string): string[] {
	if (!existsSync(ship)) return [];
	return readdirSync(ship, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".sqlite"));
}

/** Which file `path` is: a file removed and made again is another one. */
function fileIdentity(path: string): string {
	const stats = statSync(path, { bigint: true });
	return `${stats.ino}:${stats.birthtimeNs}`;
}

test.skipIf(process.platform === "win32")(
	"a worker host keeps a root's local checkpoint journal while the root runs on elsewhere, and removes it once the root's run ended (#4768)",
	async () => {
		const directory = makeLibsqlDirectory();
		const log = join(directory, "stub.log");
		writeFileSync(log, "");
		vi.stubEnv("SHARED_POOL_STUB_LOG", log);
		const selection = {
			adapter: libsql,
			options: { url: pathToFileURL(join(directory, "shared.db")).href },
			prefix: PREFIX,
		};
		const journal = await resolveRunJournal({ agentDir: join(directory, "root", "agent"), journal: selection });
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		try {
			const queue = await openSqlPoolQueue(journal);
			const shared = await SqlSharedPool.open(journal, queue);
			const definition = { path: childPath, exportName: "boundChild", digest: await definitionDigest(childPath) };
			const publish = (lease: Lease) =>
				shared.publishConfig(lease, {
					definitions: [definition],
					leaseMs: 30_000,
					heartbeatMs: 7_500,
					startupTimeoutMs: 30_000,
					claimWindowMs: 60_000,
					checkpointShipping: SHIPPING,
				});
			await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
			const acquired = await journal.acquire("root", "root-holder");
			if (acquired.status !== "acquired") assert.fail("no lease for the root");
			await queue.initialize(acquired.lease, 60_000);
			await publish(acquired.lease);
			host = await startWorkflowWorkerHost({
				journal: selection,
				agentDir: join(directory, "host", "agent"),
				maxWorkers: 1,
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
			});
			const ship = join(directory, "host", "agent", "workflows", "pool", "ship");
			const serves = async () => (await host!.stats()).roots.length > 0;
			while (!(await serves()) || localJournals(ship).length === 0) await sleep(25);
			const [local] = localJournals(ship);
			const first = fileIdentity(join(ship, local!));

			// Another incarnation takes the root over: the run goes on, so the host lets go of it and keeps its journal,
			// which it opens again once it serves the resumed root.
			const state = (await journal.leaseState("root"))!;
			const resumed = await journal.takeover("root", "next-incarnation", state.holderId);
			if (resumed.status !== "acquired") assert.fail("no takeover");
			while (await serves()) await sleep(25);
			await publish(resumed.lease);
			while (!(await serves())) await sleep(25);
			assert.deepEqual(localJournals(ship), [local], "a root that runs on keeps its local journal on the host");
			assert.equal(fileIdentity(join(ship, local!)), first, "the host kept the journal it had, not a new one");

			// The resumed root's run ends: the host lets go of it and removes its journal.
			const storage = sqlPoolStorage(journal)!;
			await storage.transaction((tx) =>
				tx.run(`UPDATE ${PREFIX}wf_runs SET status = 'completed' WHERE run_id = 'root'`),
			);
			const deadline = performance.now() + LET_GO_MS;
			while (localJournals(ship).length > 0 && performance.now() < deadline) await sleep(25);
			assert.deepEqual(localJournals(ship), [], "a root whose run ended leaves no local journal on the host");
			await host.stop();
			host = undefined;
		} finally {
			await host?.stop();
			await journal.close();
			vi.unstubAllEnvs();
			await removeLibsqlDirectory(directory);
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
