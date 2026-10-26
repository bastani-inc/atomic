/**
 * Live view of stages that run on local workers (#3996).
 *
 * A real one-worker pool runs a child whose agent stage streams one delta and then holds
 * mid-turn until the test releases it.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@bastani/atomic";
import { beforeAll, test, vi } from "vitest";
import { TestSqliteDatabase } from "../../packages/coding-agent/test/helpers/sqlite.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import type {
	PooledStageWatch,
	PooledStageWatchMessage,
	SeqEvent,
} from "../../packages/workflows/src/workers/stage-watch-types.js";
import { LIVE_STAGE_FIRST_DELTA, LIVE_STAGE_SECOND_DELTA } from "../fixtures/pool-live-stage-child.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process, a worker process, and a real agent stage in it. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
const CONDITION_TIMEOUT_MS = 60_000;

// Keep the real coordinator, fork and IPC, but run the shipped worker rather than
// cold-transpiling its entire source graph through jiti.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { fileURLToPath } = await import("node:url");
	const sourceEntry = fileURLToPath(
		new URL("../../packages/workflows/src/workers/local-worker-entry.mjs", import.meta.url),
	);
	const packagedEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	return {
		...actual,
		fork: (modulePath: string | URL, args: readonly string[], options: ForkOptions) =>
			actual.fork(modulePath === sourceEntry ? packagedEntry : modulePath, args, options),
	};
});

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

async function until(condition: () => boolean): Promise<void> {
	const timedOut = AbortSignal.timeout(CONDITION_TIMEOUT_MS);
	while (!condition()) {
		timedOut.throwIfAborted();
		await sleep(25);
	}
}

type Block = { readonly type: string; readonly text?: string };

function textOf(message: object): string {
	const content = "content" in message ? (message.content as string | readonly Block[] | undefined) : undefined;
	return typeof content === "string"
		? content
		: (content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

test.skipIf(process.platform === "win32")(
	"a running pooled stage opens as a live watch whose stream continues right after its snapshot (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-live-stage-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const gate = new TestSqliteDatabase(path);
		gate.run("CREATE TABLE test_live_stage_gate(released INTEGER); INSERT INTO test_live_stage_gate VALUES (0)");
		gate.close();
		const childPath = fileURLToPath(new URL("../fixtures/pool-live-stage-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "child",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 1,
			definitions: [{ definition: child, path: childPath, exportName: "child" }],
		});
		const store = createStore();
		const root = testRunId("pool-live-stage");
		try {
			const execution = run(
				workflow({
					name: "pool-live-stage-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { journalPath: path } });
						return {};
					},
				}),
				{},
				{ runId: root, cwd: directory, store, durableBackend: backend },
			);
			const pooledStage = (): { readonly runId: string; readonly stage: StageSnapshot } | undefined => {
				for (const candidate of store.runs())
					for (const stage of candidate.stages)
						if (stage.name === "agent" && stage.workerExecution !== undefined)
							return { runId: candidate.id, stage };
				return undefined;
			};

			// Watch once the stage is held mid-turn with its first delta streamed.
			const received: PooledStageWatchMessage[] = [];
			let watch: PooledStageWatch | undefined;
			await untilOrRunEnds(
				async () => {
					const target = pooledStage();
					if (target === undefined) return false;
					const result = await pool.watchPooledStage(
						{ runId: target.runId, stageId: target.stage.id },
						(message) => received.push(message),
					);
					if (!result.ok) return false;
					if (textOf(result.watch.snapshot.streamingMessage ?? {}) === LIVE_STAGE_FIRST_DELTA) {
						watch = result.watch;
						return true;
					}
					await pool.unwatchPooledStage(result.watch.id);
					received.length = 0;
					return false;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(watch !== undefined);
			const target = pooledStage()!;

			// The snapshot's settled messages are the session's: the prompt, and nothing of the turn in flight.
			assert.equal(watch.snapshot.sessionId, target.stage.sessionId);
			const sessions = await poolSessionStore(backend);
			assert.ok(sessions !== undefined);
			const persisted = (await SessionManager.open(sessions, target.stage.sessionId!)).buildSessionContext()
				.messages;
			assert.deepEqual(
				watch.snapshot.messages.map((message) => [message.role, textOf(message)]),
				persisted.map((message) => [message.role, textOf(message)]),
			);
			assert.equal(watch.snapshot.messages.at(-1)?.role, "user");
			await sessions.close();
			assert.equal(watch.snapshot.isStreaming, true);
			assert.equal(watch.attempt.generation, target.stage.workerExecution!.generation);

			const release = new TestSqliteDatabase(path);
			release.run("UPDATE test_live_stage_gate SET released = 1");
			release.close();
			const events = (): readonly SeqEvent[] =>
				received.flatMap((message) => (message.kind === "events" ? message.events : []));
			const outcome = await execution;
			assert.equal(outcome.status, "completed");
			await until(() => received.some((message) => message.kind === "ended"));
			assert.deepEqual(received.at(-1), { kind: "ended", reason: "stage_finished" });
			const stream = events();
			assert.ok(stream.some(({ event }) => event.type === "message_end" && event.message.role === "assistant"));
			assert.equal(stream[0]!.seq, watch.snapshot.seq + 1, "the stream starts right after the snapshot");
			assert.ok(stream.every(({ seq }, index) => index === 0 || seq > stream[index - 1]!.seq));
			const deltas = stream.flatMap(({ event }) =>
				event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
					? [event.assistantMessageEvent.delta]
					: [],
			);
			assert.equal(LIVE_STAGE_FIRST_DELTA + deltas.join(""), LIVE_STAGE_FIRST_DELTA + LIVE_STAGE_SECOND_DELTA);
		} finally {
			await pool.close();
			await backend.close();
			await sleep(0);
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
