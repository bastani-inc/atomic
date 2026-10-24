import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { externalRunRouteOwner } from "../../packages/workflows/src/shared/external-run-routes.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { SqlResourceAdmission } from "../../packages/workflows/src/workers/resource-admission.js";
import { makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

const releaseRoutes = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../packages/workflows/src/runs/foreground/sdk-intercom.js", () => ({
	acquireStandaloneIntercom: async () => releaseRoutes,
}));

afterEach(() => {
	vi.restoreAllMocks();
	releaseRoutes.mockClear();
});

test("a failed worker cleanup still releases the root's Intercom routes and reports the cleanup error (#3869)", async () => {
	const directory = makeTempDirectory("pool-dispose-routes-");
	const path = join(directory, "journal.sqlite");
	const releasePath = join(directory, "release");
	writeTextSync(releasePath, "");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const childPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
		admission: { limits: { session: 1 } },
		// The worker cleanup this test fails runs in the coordinator; keep it in this process to intercept it.
		coordinator: "in-process",
	});
	try {
		const result = await run(
			workflow({
				name: "dispose-routes-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.workflow(child, { inputs: { releasePath, tools: 1 } });
					return {};
				},
			}),
			{},
			{ runId: "root", cwd: directory, store: createStore(), durableBackend: backend },
		);
		assert.equal(result.status, "completed", JSON.stringify(result));
		assert.equal(releaseRoutes.mock.calls.length, 0, "routes stay registered while the pool is open");
		vi.spyOn(SqlResourceAdmission.prototype, "releaseStoppedSessions").mockResolvedValue(1);
		await assert.rejects(pool.close(), /cleanup unconfirmed/);
		assert.equal(releaseRoutes.mock.calls.length, 1);
	} finally {
		vi.restoreAllMocks();
		await pool.close().catch(() => {});
		await backend.close();
		removeTempDirectory(directory);
	}
});

test("closing a pool releases its pooled runs' route claims on the root's store (#3903)", async () => {
	const directory = makeTempDirectory("pool-dispose-claims-");
	const path = join(directory, "journal.sqlite");
	const releasePath = join(directory, "release");
	writeTextSync(releasePath, "");
	const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
	const childPath = fileURLToPath(new URL("../fixtures/pool-heartbeat-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({
		path: childPath,
		exportName: "child",
		digest: await definitionDigest(childPath),
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName: "child" }],
		admission: { limits: { session: 1 } },
		coordinator: "in-process",
	});
	const store = createStore();
	try {
		const result = await run(
			workflow({
				name: "dispose-claims-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.workflow(child, { inputs: { releasePath, tools: 1 } });
					return {};
				},
			}),
			{},
			{ runId: "root", cwd: directory, store, durableBackend: backend },
		);
		assert.equal(result.status, "completed", JSON.stringify(result));
		const pooledRuns = store.runs().flatMap((entry) => (entry.parentRunId === "root" ? [entry.id] : []));
		assert.equal(pooledRuns.length, 1);
		assert.ok(
			pooledRuns.every((runId) => externalRunRouteOwner(store, runId) !== undefined),
			"an open pool owns its pooled runs' routes",
		);
		await pool.close();
		assert.deepEqual(
			pooledRuns.filter((runId) => externalRunRouteOwner(store, runId) !== undefined),
			[],
			"a closed pool still owns routes on the root's store, which keeps the pool reachable",
		);
	} finally {
		await pool.close().catch(() => {});
		await backend.close();
		removeTempDirectory(directory);
	}
});
