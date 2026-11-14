import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { StorageTransientError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { SqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { isWorkspaceRestoreUnavailableError } from "../../packages/workflows/src/workers/placement-errors.js";
import type { WorkflowWorkerHostEvent } from "../../packages/workflows/src/workers/worker-host.js";
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

afterEach(() => {
	vi.restoreAllMocks();
});

test(
	"a child the root fails while the journal drops the answer still reaches the root failed, on a later pass (#4768)",
	async () => {
		// No host can run the bound child, so the root fails it once the claim window passes. The journal applies that
		// write but the answer is lost, as when the connection drops after the server committed it.
		const f = await fixture("shared-coordinator-outage", { workspace: binding, claimWindowMs: 1_000 });
		const failUnclaimed = SqlPoolQueue.prototype.failUnclaimed;
		let dropped = 0;
		vi.spyOn(SqlPoolQueue.prototype, "failUnclaimed").mockImplementation(async function (
			this: SqlPoolQueue,
			...args: Parameters<SqlPoolQueue["failUnclaimed"]>
		) {
			const applied = await failUnclaimed.apply(this, args);
			if (dropped++ > 0) return applied;
			throw new StorageTransientError(
				{ adapter: "libsql", location: "http://db" },
				{ code: "connection-lost", outcome: "unknown", attempts: 1 },
				new Error("fetch failed"),
			);
		});
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		try {
			const result = await run(
				parent,
				{},
				{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.ok(isWorkspaceRestoreUnavailableError(outcomes[0]), String(outcomes[0]));
			assert.equal(dropped, 1, "the failure was written once, and reported from the next pass's read");
		} finally {
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a worker host reports a child it claimed and released between two ticks, and counts it as activity (#4768)",
	async () => {
		const f = await fixture("shared-coordinator-short-child", { workspace: binding });
		const warm = join(f.directory, "warm");
		mkdirSync(warm);
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "boundChild",
			digest: await definitionDigest(childPath),
		});
		const { parent, outcomes } = await fanOut(1)(child as never);
		const execution = run(
			parent,
			{},
			{ runId: "root", cwd: f.directory, store: createStore(), durableBackend: f.backend },
		);
		const { startWorkflowWorkerHost } = await import("../../packages/workflows/src/workers/worker-host.js");
		const events: WorkflowWorkerHostEvent[] = [];
		let host: Awaited<ReturnType<typeof startWorkflowWorkerHost>> | undefined;
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
				restore: false,
				hostId: "host-b",
				workerEntry: stubWorker,
				placement: { prefer: async () => warm },
				onEvent: (event) => events.push(event),
			});
			assert.equal((await execution).status, "completed");
			assert.deepEqual(outcomes, ["completed"]);
			while (!events.some((event) => event.kind === "released")) await new Promise((r) => setTimeout(r, 25));
			const held = events.filter((event) => event.kind === "claimed" || event.kind === "released");
			assert.deepEqual(
				held.map((event) => event.kind),
				["claimed", "released"],
				JSON.stringify(events),
			);
			const [claimed, released] = held;
			assert.ok(claimed?.kind === "claimed" && released?.kind === "released");
			assert.equal(claimed.root, "root");
			assert.equal(claimed.childRunId, released.childRunId);
			assert.equal(claimed.work, released.work);
			assert.equal(claimed.generation, 1);
		} finally {
			await host?.stop();
			await execution.catch(() => {});
			await f.close();
		}
	},
	COORDINATOR_TEST_TIMEOUT_MS,
);
