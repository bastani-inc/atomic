import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import type { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	binding,
	COORDINATOR_TEST_TIMEOUT_MS,
	childPath,
	fanOut,
	fixture,
	satellite,
} from "../helpers/workflow-shared-pool-coordinator.js";

vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => async () => {},
}));

useTemporaryAgentDir();

/** Long enough for a worker the host started for a waiting child to report its start. */
const WAITING_WORKER_WINDOW_MS = 2_000;

test(
	"a worker host never starts more workers than it was given while its child waits released (#4374)",
	async () => {
		const f = await fixture("shared-coordinator-waiting", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const release = join(f.directory, "release");
		vi.stubEnv("SHARED_POOL_STUB_RELEASE", release);
		vi.stubEnv("SHARED_POOL_STUB_WAITS", "1");
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		let host: PoolCoordinator | undefined;
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const hostStarts = () =>
			f.starts().filter((start) => (start.shared as { host?: string } | undefined)?.host === "host-b");
		try {
			const root = await f.root();
			host = await satellite(f, root, { prefer: async () => warm }, [], "host-b", 1);
			while (f.placesReleased().length === 0) await sleep(25);
			await sleep(WAITING_WORKER_WINDOW_MS);
			const startedWhileWaiting = hostStarts().length;
			writeFileSync(release, "");
			const result = await execution;

			assert.equal(startedWhileWaiting, 1, "the host's one worker, and no other for the waiting child");
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.deepEqual(outcomes, ["completed"]);
			assert.deepEqual(
				f.placesReleased().map(([placed, , reply]) => [placed, reply]),
				[["host-b", "released"]],
			);
		} finally {
			await host?.stopSatellite();
			await host?.shutdown();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
