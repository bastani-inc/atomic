/**
 * A fork of a paused run whose child stage stopped mid-conversation on a local worker resumes that conversation on a
 * worker of the fork (#4321).
 *
 * Workers read stage sessions only from the journal's pool tables. The fork copies the child stage's session there
 * under a new id, and queuing the fork's child claims the copy, so the fork's worker reopens it and continues it. The
 * second case keeps the journal in another database, so the pool's tables live in the machine's coordination database.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { toolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import { forkRun } from "../../packages/workflows/src/runs/foreground/sdk-fork.js";
import { poolJournalOf } from "../../packages/workflows/src/workers/pool-journal.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import { LIVE_STAGE_SECOND_DELTA } from "../fixtures/pool-live-stage-child.js";
import { poolTestBudgetMs } from "../helpers/pool-budget.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: the source and the fork each cold-start a pool coordinator and a worker. */
const TWO_POOLS = poolTestBudgetMs(2);
const childPath = fileURLToPath(new URL("../fixtures/pool-live-stage-child.ts", import.meta.url));
const delegatingAdapter = fileURLToPath(new URL("../fixtures/delegating-run-journal-adapter.mjs", import.meta.url));

useTemporaryAgentDir();

for (const journalKind of ["shared", "coordination"] as const) {
	test.skipIf(process.platform === "win32")(
		`a fork resumes a child stage paused mid-conversation on a local worker, with the copied history, on a ${journalKind} pool database (#4321)`,
		async () => {
			const budget = AbortSignal.timeout(TWO_POOLS.waitMs);
			const directory = makeTempDirectory("fork-pooled-stage-");
			const path = join(directory, "journal.sqlite");
			const journal = await resolveRunJournal(
				journalKind === "shared"
					? { journal: { path } }
					: {
							agentDir: join(directory, "home", "agent"),
							journal: { adapter: delegatingAdapter, options: { path } },
						},
			);
			const backend = await JournalDurableBackend.open(journal);
			const gatePath = join(directory, "release-stage");
			const child = await loadWorkerWorkflow(childPath, "child");
			const parent = workflow({
				name: "fork-pooled-stage-root",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.workflow(child, { inputs: { gatePath } });
					return {};
				},
			});
			const root = testRunId(`fork-pooled-stage-${journalKind}`);
			const store = createStore();
			const pool = async <T>(
				read: (sessions: NonNullable<Awaited<ReturnType<typeof poolSessionStore>>>) => Promise<T>,
			) => {
				// One SQL pool database holds the sessions of the source root and of its fork.
				const sessions = await poolSessionStore(backend, root);
				assert.ok(sessions !== undefined, "the pool keeps its sessions in the journal's pool tables");
				try {
					return await read(sessions);
				} finally {
					await sessions.close();
				}
			};
			try {
				const running = run(
					parent,
					{},
					{
						runId: root,
						cwd: directory,
						store,
						durableBackend: backend,
						localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
						signal: budget,
					},
				);
				let sourceSession: string | undefined;
				await untilOrRunEnds(
					async () => {
						const stage = store
							.runs()
							.flatMap((snapshot) => snapshot.stages)
							.find((candidate) => candidate.name === "agent" && candidate.sessionId !== undefined);
						if (stage?.sessionId === undefined) return false;
						sourceSession = stage.sessionId;
						return (await pool((sessions) => sessions.readHeader(stage.sessionId!))) !== undefined;
					},
					running,
					TWO_POOLS.waitMs,
				);
				assert.ok(sourceSession !== undefined);
				await toolControlRegistry.runControl(root)!.quit();
				assert.equal((await running).status, "paused");
				const sourceEntries = await pool(async (sessions) => (await sessions.load(sourceSession!)).entries);

				await writeFileEnsuringDir(gatePath, "released");
				const forked = await forkRun(root, {
					durableBackend: backend,
					cwd: directory,
					definition: parent,
					signal: budget,
				});
				const result = await forked.result;
				assert.equal(result.status, "completed", JSON.stringify(result));

				const resumed = (await backend.readCheckpoints(forked.runId)).flatMap((checkpoint) =>
					checkpoint.kind === "stage" && checkpoint.name === "agent" && checkpoint.sessionId !== undefined
						? [checkpoint.sessionId]
						: [],
				);
				const [copy, ...others] = new Set(resumed);
				assert.ok(copy !== undefined && copy !== sourceSession, "the fork's stage has its own session");
				assert.deepEqual(others, [], "the fork's worker continued the copied session, not a new one");
				const poolJournal = await poolJournalOf(backend.journal);
				const tables = sqlPoolStorage(poolJournal)!;
				const work = await tables.read((tx) =>
					tx.get(
						`SELECT id, json_extract(descriptor, '$.childRunId') AS child FROM ${tables.tables.runs}_work WHERE root = ?`,
						forked.runId,
					),
				);
				const owner = await tables.read((tx) =>
					tx.get(`SELECT work FROM ${tables.tables.runs}_pool_session_owners WHERE session = ?`, copy),
				);
				assert.ok(work !== undefined);
				assert.equal(owner?.work, work.id, "the fork's child work owns the copy");
				const continued = await pool((sessions) => sessions.load(copy));
				assert.equal(continued.header.parentSessionId, sourceSession);
				assert.equal(continued.header.workflow?.runId, work.child, "the copy names the fork's child run");
				assert.deepEqual(
					continued.entries.slice(0, sourceEntries.length),
					sourceEntries,
					"the resumed conversation starts with the source's history",
				);
				assert.ok(continued.entries.length > sourceEntries.length, "and continues it");
				assert.match(
					JSON.stringify(continued.entries.slice(sourceEntries.length)),
					new RegExp(LIVE_STAGE_SECOND_DELTA),
				);
				assert.deepEqual(
					await pool(async (sessions) => (await sessions.load(sourceSession!)).entries),
					sourceEntries,
					"the source's session is unchanged",
				);
			} finally {
				await writeFileEnsuringDir(gatePath, "released");
				await backend.close();
				removeTempDirectory(directory);
			}
		},
		TWO_POOLS.timeoutMs,
	);
}
