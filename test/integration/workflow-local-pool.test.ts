import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
const STALLED_WORKER_RECOVERY_TIMEOUT_MS = 30_000;

test.each([
	{ crash: false, during: false },
	{ crash: true, during: false },
	{ crash: true, during: true },
])(
	"child fan-out recovers checkpoints with worker death=$crash during-stage=$during (#3869)",
	async ({ crash, during }) => {
		const directory = makeTempDirectory("local-pool-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		try {
			const parent = workflow({
				name: "pool-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const results = await Promise.all(
						[crash, false].map((crash) => ctx.workflow(child, { inputs: { crash, during, journalPath: path } })),
					);
					assert.ok(results.every((result) => result.status === "completed"));
					assert.ok(results.every((result) => result.outputs.firstPid !== process.pid));
					assert.equal(new Set(results.map((result) => result.outputs.firstPid)).size, 2);
					assert.ok(
						results.every(
							(result, index) =>
								Number(result.outputs.stagePid) ===
								(during && index === 0 ? result.outputs.finalPid : result.outputs.firstPid),
						),
					);
					assert.ok(results.every((result) => result.outputs.leafPid === Number(result.outputs.stagePid)));
					if (crash) assert.notEqual(results[0]!.outputs.firstPid, results[0]!.outputs.finalPid);
					if (crash && !during)
						for (let index = 0; index < 3; index++) {
							const recovered = await ctx.workflow(child, {
								inputs: { crash: true, during: false, journalPath: path },
							});
							assert.notEqual(recovered.outputs.firstPid, recovered.outputs.finalPid);
							assert.equal(Number(recovered.outputs.stagePid), recovered.outputs.firstPid);
						}
					return {};
				},
			});
			const result = await run(
				parent,
				{},
				{ runId: "pool-root", cwd: directory, store: createStore(), durableBackend: backend },
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			assert.equal(pool.workerPids.length, 2);
			assert.equal(new Set(pool.workerPids).size, 2);
			await backend.hydrateWorkflow("pool-root");
			assert.equal((await journal.listRuns()).length, 1);
			const checkpoints = backend.listCheckpoints("pool-root");
			const starts = checkpoints.filter(
				(entry) =>
					entry.kind === "stage" &&
					entry.topology?.boundary?.event === "start" &&
					entry.topology.run?.runId === "pool-root",
			);
			assert.equal(starts.length, crash && !during ? 5 : 2);
			assert.deepEqual(
				starts.map((entry) => (entry.kind === "stage" ? entry.topology?.sourceOrder : -1)).sort(),
				crash && !during ? [0, 1, 2, 3, 4] : [0, 1],
			);
			for (const start of starts) {
				assert.equal(start.kind, "stage");
				if (start.kind !== "stage") continue;
				const owner = start.topology!.boundary!;
				const tools = checkpoints.filter(
					(entry) => entry.kind === "tool" && entry.topology?.run?.runId === owner.child.runId,
				);
				assert.equal(tools.length, 2);
				const sessionIds = new Set(
					checkpoints.flatMap((entry) =>
						entry.kind === "stage" && entry.topology?.run?.runId === owner.child.runId && entry.sessionId
							? [entry.sessionId]
							: [],
					),
				);
				assert.equal(sessionIds.size, 1);
				assert.ok(tools.every((entry) => entry.checkpointId.startsWith(`${owner.replayScope}:`)));
				assert.ok(
					tools.every(
						(entry) => entry.kind === "tool" && entry.topology?.run?.parentStageId === start.topology!.stageId,
					),
				);
				const stage = checkpoints.find(
					(entry) =>
						entry.kind === "stage" &&
						entry.name === "agent" &&
						entry.topology?.run?.runId === owner.child.runId &&
						"output" in entry,
				);
				assert.ok(stage?.kind === "stage");
				assert.equal(stage.topology?.sourceOrder, 0);
				assert.equal(stage.topology?.run?.parentStageId, start.topology!.stageId);
				assert.ok(stage.sessionId);
				assert.equal(stage.sessionFile, undefined);
				assert.deepEqual(
					stage.topology?.parentIds,
					tools
						.filter((entry) => entry.kind === "tool" && entry.name === "checkpoint")
						.map((entry) => (entry.kind === "tool" ? entry.topology?.nodeId : "")),
				);
				const nested = checkpoints.find(
					(entry) =>
						entry.kind === "stage" &&
						entry.topology?.boundary?.event === "start" &&
						entry.topology.run?.runId === owner.child.runId,
				);
				assert.ok(nested?.kind === "stage");
				assert.equal(nested.topology?.sourceOrder, 1);
				assert.deepEqual(nested.topology?.parentIds, [stage.topology!.stageId]);
				const leaf = checkpoints.find(
					(entry) =>
						entry.kind === "tool" &&
						entry.name === "leaf" &&
						entry.topology?.run?.runId === nested.topology!.boundary!.child.runId,
				);
				assert.ok(leaf?.kind === "tool");
				assert.ok(leaf.checkpointId.startsWith(`${nested.topology!.boundary!.replayScope}:`));
				assert.equal(leaf.topology?.run?.parentStageId, nested.topology!.stageId);
			}
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a stalled sole worker is replaced and replays its committed checkpoint (#3869)",
	async () => {
		const directory = makeTempDirectory("stalled-local-pool-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const childPath = fileURLToPath(new URL("../fixtures/pool-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "stalledChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "stalledChild" }],
		});
		try {
			const parent = workflow({
				name: "stalled-pool-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					const result = await ctx.workflow(child);
					assert.equal(result.status, "completed");
					assert.notEqual(result.outputs.firstPid, result.outputs.finalPid);
					assert.deepEqual(pool.workerPids, [result.outputs.finalPid]);
					return {};
				},
			});
			const result = await run(
				parent,
				{},
				{
					runId: "stalled-pool-root",
					cwd: directory,
					store: createStore(),
					durableBackend: backend,
					signal: AbortSignal.timeout(STALLED_WORKER_RECOVERY_TIMEOUT_MS),
				},
			);
			assert.equal(result.status, "completed", JSON.stringify(result));
			await backend.hydrateWorkflow("stalled-pool-root");
			const toolNames = backend
				.listCheckpoints("stalled-pool-root")
				.flatMap((entry) =>
					entry.kind === "tool" && (entry.name === "checkpoint" || entry.name === "finish") ? [entry.name] : [],
				);
			assert.deepEqual(toolNames, ["checkpoint", "finish"]);
			assert.equal((await journal.listRuns()).length, 1);
		} finally {
			await pool.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
