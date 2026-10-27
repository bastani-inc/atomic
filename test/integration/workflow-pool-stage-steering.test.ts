/**
 * Steering stages that run on local workers (#3996).
 *
 * A standalone SDK run with `localWorkers` and a caller `stageControlRegistry` runs a child
 * whose agent stage streams one delta and then holds mid-turn until the test releases it.
 * The registry's pooled handle steers and queues follow-ups like an in-process handle, the
 * graph sees the queue with no chat open, and every message reaches the session once.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@bastani/atomic";
import { beforeAll, test, vi } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { createStore, loadWorkerWorkflow, run, workflow } from "../../packages/workflows/src/index.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { poolSessionStore } from "../../packages/workflows/src/workers/pool-session-store.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Structural: a coordinator process, a worker process, and a real agent stage in it. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
const CONDITION_TIMEOUT_MS = 60_000;

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

type Block = { readonly type: string; readonly text?: string };

function textOf(message: object): string {
	const content = "content" in message ? (message.content as string | readonly Block[] | undefined) : undefined;
	return typeof content === "string"
		? content
		: (content ?? []).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

test.skipIf(process.platform === "win32")(
	"an SDK registry's pooled stage handle steers and queues follow-ups once each, and the queue shows without a watch (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-stage-steering-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const gatePath = join(directory, "release-stage");
		const childPath = fileURLToPath(new URL("../fixtures/pool-live-stage-child.ts", import.meta.url));
		const child = await loadWorkerWorkflow(childPath, "child");
		const store = createStore();
		const registry = createStageControlRegistry();
		try {
			const execution = run(
				workflow({
					name: "pool-stage-steering-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { gatePath } });
						return {};
					},
				}),
				{},
				{
					runId: testRunId("pool-stage-steering"),
					cwd: directory,
					store,
					durableBackend: backend,
					stageControlRegistry: registry,
					localWorkers: { count: 1, definitions: [{ path: childPath, exportName: "child" }] },
				},
			);
			const pooledStage = (): { readonly runId: string; readonly stage: StageSnapshot } | undefined => {
				for (const candidate of store.runs())
					for (const stage of candidate.stages)
						if (stage.name === "agent" && stage.workerExecution !== undefined)
							return { runId: candidate.id, stage };
				return undefined;
			};
			let handle: StageControlHandle | undefined;
			await untilOrRunEnds(
				async () => {
					const target = pooledStage();
					handle = target === undefined ? undefined : registry.get(target.runId, target.stage.id);
					return handle?.placement?.kind === "local-worker";
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(handle?.sendUserMessage !== undefined);
			const target = pooledStage()!;

			// Watch until the stage streams its held turn, as Enter and Ctrl+F in its chat would find it.
			const watched = handle;
			const unsubscribe = watched.subscribe(() => {});
			await untilOrRunEnds(async () => watched.isStreaming, execution, CONDITION_TIMEOUT_MS);
			assert.equal(await handle.sendUserMessage("steer-from-root", { deliverAs: "steer" }), "steer");
			assert.equal(await handle.sendUserMessage("follow-up-from-root", { deliverAs: "followUp" }), "followUp");
			unsubscribe();

			// With no watch open, the graph still learns the queue from the worker's activity.
			await untilOrRunEnds(
				async () => (pooledStage()?.stage.queuedUserMessageCount ?? 0) === 2,
				execution,
				CONDITION_TIMEOUT_MS,
			);

			writeTextSync(gatePath, "");
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome));
			assert.equal(registry.get(target.runId, target.stage.id), undefined, "a finished stage leaves the registry");

			const sessions = await poolSessionStore(backend);
			assert.ok(sessions !== undefined);
			const users = (await SessionManager.open(sessions, target.stage.sessionId!))
				.buildSessionContext()
				.messages.filter((message) => message.role === "user")
				.map(textOf);
			await sessions.close();
			assert.deepEqual(
				users.filter((text) => text.endsWith("-from-root")),
				["steer-from-root", "follow-up-from-root"],
				"each message reached the session exactly once, in order",
			);
		} finally {
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
