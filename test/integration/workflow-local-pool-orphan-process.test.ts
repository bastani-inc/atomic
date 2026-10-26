import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExistsSync, makeTempDirectory, readJson, readTextSync, removeTempDirectory } from "../helpers/runtime.js";

const ORPHAN_PROCESS_TEST_TIMEOUT_MS = 120_000;

function groupAlive(group: number): boolean {
	try {
		process.kill(-group, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

test.skipIf(process.platform === "win32")(
	"a worker that dies while its tool process group runs replays only its child once that group is reaped (#3986)",
	async () => {
		const directory = makeTempDirectory("pool-orphan-process-");
		const path = join(directory, "journal.sqlite");
		const orphanMarker = join(directory, "orphan-group");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const childPath = fileURLToPath(new URL("../fixtures/pool-load-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			admission: {},
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
			workerEntry: fileURLToPath(new URL("../fixtures/pool-orphan-process-stub-worker.mjs", import.meta.url)),
		});
		try {
			const result = await run(
				workflow({
					name: "pool-orphan-process-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { index: 0 } });
						return {};
					},
				}),
				{},
				{
					runId: testRunId("pool-orphan-process-root"),
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
				},
			);
			assert.equal(result.status, "completed", result.error);
			const replay = await readJson<{ group: number; orphanAliveAtReplay: boolean }>(join(directory, "replay.json"));
			assert.equal(replay.orphanAliveAtReplay, false, "the replay never overlaps the dead attempt's process group");
			assert.equal(groupAlive(replay.group), false);
			const journal = new DatabaseSync(path, { readOnly: true });
			try {
				const permits = journal.prepare("SELECT kind, state, reason FROM wf_runs_resource_permits").all();
				assert.deepEqual(
					permits.map((permit) => ({ ...permit })),
					[{ kind: "process", state: "released", reason: "process group cleanup confirmed" }],
				);
			} finally {
				journal.close();
			}
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			if (fileExistsSync(orphanMarker)) {
				const group = Number(readTextSync(orphanMarker, "utf8"));
				if (groupAlive(group)) process.kill(-group, "SIGKILL");
			}
			removeTempDirectory(directory);
		}
	},
	ORPHAN_PROCESS_TEST_TIMEOUT_MS,
);
