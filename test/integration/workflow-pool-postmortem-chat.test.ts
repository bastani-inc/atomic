/**
 * Post-mortem chat of a stage that ran on a local worker (#3996).
 *
 * Workers commit stage sessions into the journal's pool session tables, not the host's
 * session store. A finished pooled stage must still reopen for post-mortem chat in the
 * same process, and after a restart rebuilds it from the journal.
 */
import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSessionStore } from "@bastani/atomic";
import { beforeAll, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import {
	completedWorkflowRunSnapshots,
	listOpenableCompletedWorkflows,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createPostMortemHandleResolver } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { AgentSessionAdapter } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { testRunId } from "../helpers/run-id.js";
import { fileExists, makeTempDirectory, removeTempDirectory, writeTextSync } from "../helpers/runtime.js";

/** Structural: a coordinator process, a worker process, and a real agent stage in it. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;

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

/** The resolver only checks that the session reopens; it opens the session on first use. */
const unopenedAdapter: AgentSessionAdapter = {
	async create() {
		throw new Error("the post-mortem session is not opened in this test");
	},
};

function pooledAgentStage(store: Store): { readonly runId: string; readonly stage: StageSnapshot } | undefined {
	for (const candidate of store.runs())
		for (const stage of candidate.stages) if (stage.name === "agent") return { runId: candidate.id, stage };
	return undefined;
}

test.skipIf(process.platform === "win32")(
	"a finished pooled stage reopens for post-mortem chat in the same process and after a restart (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-postmortem-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		// Released from the start: this suite only needs the stage to finish.
		const gatePath = join(directory, "release-stage");
		writeTextSync(gatePath, "");
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
		bindStoreDurableBackend(store, backend);
		// The host's own session store, which never holds a pooled stage's session.
		const hostSessions = await JsonlSessionStore.open(join(directory, "host-sessions"), { exactDirectory: true });
		const root = testRunId("pool-postmortem");
		const resolverFor = (owner: Store) =>
			createPostMortemHandleResolver({
				adapters: { agentSession: unopenedAdapter, sessionStore: hostSessions },
				resolveDefaultStageSessionDir: () => undefined,
				store: owner,
				stageControlRegistry: createStageControlRegistry(),
			});
		try {
			const outcome = await run(
				workflow({
					name: "pool-postmortem-root",
					description: "",
					inputs: {},
					outputs: {},
					async run(ctx) {
						await ctx.workflow(child, { inputs: { gatePath } });
						return {};
					},
				}),
				{},
				{ runId: root, cwd: directory, store, durableBackend: backend },
			);
			assert.equal(outcome.status, "completed");
			const finished = pooledAgentStage(store);
			assert.equal(finished?.stage.status, "completed");
			assert.ok(finished.stage.sessionId !== undefined);

			const sameProcess = await resolverFor(store)(finished.runId, finished.stage.id);
			assert.deepEqual(
				sameProcess === undefined
					? undefined
					: { ok: sameProcess.ok, reason: sameProcess.ok ? undefined : sameProcess.reason },
				{ ok: true, reason: undefined },
				"same-process post-mortem chat of a finished pooled stage",
			);

			await pool.close();
			const reopened = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
			try {
				const [entry] = (await listOpenableCompletedWorkflows(reopened, hostSessions)).filter(
					(candidate) => candidate.workflowId === root,
				);
				assert.ok(entry !== undefined);
				const restored = createStore();
				bindStoreDurableBackend(restored, reopened);
				for (const snapshot of await completedWorkflowRunSnapshots(reopened, entry, hostSessions))
					restored.recordRunStart(snapshot);
				const rebuilt = pooledAgentStage(restored);
				assert.equal(
					rebuilt?.stage.sessionId,
					finished.stage.sessionId,
					"the rebuilt pooled stage keeps its session",
				);
				const afterRestart = await resolverFor(restored)(rebuilt.runId, rebuilt.stage.id);
				assert.equal(afterRestart?.ok, true, `post-mortem after restart: ${JSON.stringify(afterRestart)}`);
			} finally {
				await reopened.close();
			}
		} finally {
			await pool.close();
			await hostSessions.close();
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
