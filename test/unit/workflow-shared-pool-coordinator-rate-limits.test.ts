import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { sleep } from "../helpers/runtime.js";
import {
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	PREFIX,
	satellite,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

/** Fleet-wide model rate limits on a shared pool (#4768): the root publishes them, and every host's workers meter by them. */

const rateLimits = { fake: { requestsPerMinute: 60, burst: 3, prefetch: 1 } };

function rateLines(log: string): string[][] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("rate "))
		.map((line) => line.split(" ").slice(1));
}

test.skipIf(process.platform === "win32")(
	"the root publishes its rate limits, and the workers of the root and of another host take tokens from the journal's bucket (#4768)",
	async () => {
		const f = await fixture("shared-coordinator-rate-limits", { rateLimits });
		vi.stubEnv("SHARED_POOL_STUB_RATE", "fake/m");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", join(f.directory, "never"));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		try {
			const root = await f.root();
			assert.deepEqual(root.config.rateLimits, rateLimits);
			host = await satellite(f, root, {}, [], "host-b", 1);
			while (rateLines(f.log).length < 2) await sleep(25);
			assert.deepEqual(rateLines(f.log).sort(), [
				["host-b", "0"],
				["root-host", "0"],
			]);
			for (const start of f.starts()) assert.deepEqual(start.rateScopes, ["fake"]);
			assert.equal(host.rateLimitMode, "store");
			// The hosts' tokens came from the journal's bucket: its arrival time moved past now, a second per token.
			const bucket = await sqlPoolStorage(f.hostJournal)!.read((executor) =>
				executor.get<{ tat: number; burst: number }>(
					`SELECT tat, burst FROM ${PREFIX}wf_runs_rate_buckets WHERE scope = 'fake'`,
				),
			);
			assert.equal(Number(bucket?.burst), 3);
			assert.ok(Number(bucket?.tat) > Date.now(), `${Number(bucket?.tat) - Date.now()}`);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await f.pool.close().catch(() => {});
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a root without rate limits starts its workers without a gate, and they are never refused a token (#4768)",
	async () => {
		const f = await fixture("shared-coordinator-no-rate-limits", {});
		vi.stubEnv("SHARED_POOL_STUB_RATE", "fake/m");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", join(f.directory, "never"));
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
		try {
			const root = await f.root();
			assert.equal(root.config.rateLimits, undefined);
			while (rateLines(f.log).length < 1) await sleep(25);
			assert.deepEqual(rateLines(f.log), [["root-host", "0"]]);
			for (const start of f.starts()) assert.equal(start.rateScopes, undefined);
		} finally {
			await f.pool.close().catch(() => {});
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
