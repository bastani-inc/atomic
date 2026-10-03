import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { fileExists, readText, sleep } from "../helpers/runtime.js";

const REAL_MANAGED_DBOS_PROCESS_TIMEOUT_MS = 120_000;
type ConsumerResult = Pick<ManagedResult, "metadata"> & { runId: string; completedCalls: number };

// #3072/#3074: both existing production DBOS pools must recover, not newly created pg.Clients.
test(
	"managed DBOS consumers automatically recover their pools and same-ID checkpoints",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		const started = Date.now();
		let stoppedAt: number | undefined;
		try {
			const first = home.client(
				listener.port,
				{ ATOMIC_WORKFLOW_ARTIFACT_DIR: `${home.path}/first-artifacts` },
				"managed-dbos-fault-client.ts",
			);
			const second = home.client(
				listener.port,
				{ ATOMIC_WORKFLOW_ARTIFACT_DIR: `${home.path}/second-artifacts` },
				"managed-dbos-fault-client.ts",
			);
			const a = await first.request<ConsumerResult>("warm");
			const b = await second.request<ConsumerResult>("warm");
			assert.notEqual(a.runId, b.runId);
			assert.deepEqual(a.metadata, b.metadata);
			assert.notEqual(a.metadata.server.port, listener.port);
			// A third process only stops this disposable directory, never provisions or connects.
			const fault = home.client(listener.port);
			await fault.request("stop");
			stoppedAt = Date.now();
			const deadline = Date.now() + 20_000;
			for (;;) {
				const observed = await first.request<Pick<ManagedResult, "metadata">>("metadata");
				if (observed.metadata.server.pid !== a.metadata.server.pid) break;
				assert.ok(Date.now() < deadline, "production health polling did not restart the owned server");
				await sleep(50);
			}
			const [recoveredA, recoveredB] = await Promise.all([
				first.request<ConsumerResult>("resume"),
				second.request<ConsumerResult>("resume"),
			]);
			assert.equal(recoveredA.runId, a.runId);
			assert.equal(recoveredB.runId, b.runId);
			assert.equal(recoveredA.completedCalls, 1);
			assert.equal(recoveredB.completedCalls, 1);
			assert.deepEqual(recoveredA.metadata, recoveredB.metadata, "existing consumers converge on one server");
			assert.equal(recoveredA.metadata.clusterId, a.metadata.clusterId);
			assert.equal(recoveredA.metadata.directoryIdentity, a.metadata.directoryIdentity);
			assert.equal(recoveredA.metadata.server.systemIdentifier, a.metadata.server.systemIdentifier);
			assert.equal(recoveredA.metadata.server.port, a.metadata.server.port);
			assert.notEqual(recoveredA.metadata.server.pid, a.metadata.server.pid);
			assert.deepEqual(await first.request("inspect-peer", b.runId), { persisted: true });
			assert.deepEqual(await second.request("inspect-peer", a.runId), { persisted: true });
		} catch (error) {
			const log = `${home.path}/.atomic/postgres/v18.log`;
			throw new Error(
				`Managed recovery failed after ${Date.now() - started}ms (shutdown acknowledged at ${stoppedAt === undefined ? "never" : `${stoppedAt - started}ms`})\n${(await fileExists(log)) ? await readText(log) : "No PostgreSQL log"}`,
				{ cause: error },
			);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_MANAGED_DBOS_PROCESS_TIMEOUT_MS,
);

test(
	"managed PostgreSQL recovers after SIGTERM with a held lease and missing launch options (#3413)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		try {
			const owner = home.client(listener.port);
			const before = await owner.request<ManagedResult>("ensure");
			const consumers = await owner.request<{ pid: number }[]>("consumers");
			assert.ok(consumers.length > 0);
			const fault = home.client(listener.port);
			await fault.request("smart-stop");
			assert.equal(await fileExists(join(home.path, ".atomic/postgres/v18/postmaster.pid")), false);
			rmSync(join(home.path, ".atomic/postgres/v18/postmaster.opts"));
			const after = await owner.request<ManagedResult>("ensure");
			assert.equal(after.metadata.clusterId, before.metadata.clusterId);
			assert.equal(after.metadata.directoryIdentity, before.metadata.directoryIdentity);
			assert.equal(after.metadata.server.systemIdentifier, before.metadata.server.systemIdentifier);
			assert.notEqual(after.metadata.server.pid, before.metadata.server.pid);
			assert.deepEqual(await owner.request("query", "SELECT 3413::int AS recovered"), [{ recovered: 3413 }]);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_MANAGED_DBOS_PROCESS_TIMEOUT_MS,
);
