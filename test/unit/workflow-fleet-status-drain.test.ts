import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import type { SharedPoolHost } from "../../packages/workflows/src/durable/journal/shared-pool-types.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { workspaceAffinityKey } from "../../packages/workflows/src/workers/workspace-binding.js";
import { sleep } from "../helpers/runtime.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	libsql,
	PREFIX,
	stubWorker,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/** How often a worker host reports itself while nothing about it changes. */
const HOST_REPORT_MS = 5_000;

test.skipIf(process.platform === "win32")(
	"a draining worker host reports itself draining while its child runs, then leaves the registry for good (#4768)",
	async () => {
		const f = await fixture("fleet-status-drain", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
		const registered = async (): Promise<SharedPoolHost | undefined> =>
			(await f.shared.registeredHosts()).find((entry) => entry.host === "host-b");
		const until = async (what: string, check: (entry: SharedPoolHost | undefined) => boolean) => {
			const deadline = Date.now() + 4 * HOST_REPORT_MS;
			for (;;) {
				const entry = await registered();
				if (check(entry)) return entry;
				if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(entry)}`);
				await sleep(25);
			}
		};
		try {
			await f.root();
			host = await startWorkflowWorkerHost({
				journal: {
					adapter: libsql,
					options: { url: pathToFileURL(join(f.directory, "shared.db")).href },
					prefix: PREFIX,
				},
				agentDir: join(f.directory, "host", "agent"),
				maxWorkers: 1,
				hostId: "host-b",
				workerEntry: stubWorker,
				placement: { prefer: async () => warm },
				restore: async () => warm,
			});
			while (f.claims().length === 0) await sleep(25);
			await until("the host to report its child", (entry) => entry?.state === "busy");
			assert.equal(await f.shared.capableHostLive("root", 60_000, workspaceAffinityKey(binding)), true);

			let drained = false;
			const draining = host.drain().then(() => {
				drained = true;
			});
			const reported = await until("the host to report its drain", (entry) => entry?.state === "draining");
			assert.deepEqual([reported?.busy, reported?.draining, reported?.workers], [1, true, 1]);
			assert.equal(
				await f.shared.capableHostLive("root", 60_000, workspaceAffinityKey(binding)),
				false,
				"a draining host takes no more work",
			);
			await sleep(HOST_REPORT_MS + 1_000);
			const later = await registered();
			assert.equal(drained, false, "the drain waits for the child");
			assert.equal(later?.state, "draining");
			assert.ok(
				(later?.heartbeatAgoMs ?? Number.POSITIVE_INFINITY) < HOST_REPORT_MS,
				`a draining host goes on reporting itself: ${later?.heartbeatAgoMs} ms`,
			);

			writeFileSync(release, "");
			await draining;
			assert.equal(await registered(), undefined, "a drained host leaves the registry");
			await sleep(2_000);
			assert.equal(await registered(), undefined, "and no report registers it again");
		} finally {
			writeFileSync(release, "");
			await host?.stop();
			await f.pool.close();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
