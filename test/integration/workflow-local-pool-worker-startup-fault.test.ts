import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { isRetryableWorkflowError, WorkflowInfrastructureError } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

/** Pool faults during worker startup reach the children that wait on them (#3887). */

const WORKER_FAILURE_ROOT_TIMEOUT_MS = 150_000;
const CONDITION_TIMEOUT_MS = 90_000;

test.skipIf(process.platform === "win32")(
	"a pool fault it cannot absorb reaches every waiting ctx.workflow as a typed retryable error (#3889)",
	async () => {
		const directory = makeTempDirectory("pool-typed-fault-");
		const path = join(directory, "journal.sqlite");
		const backend = await JournalDurableBackend.open(await resolveRunJournal({ journal: { path } }));
		const childPath = fileURLToPath(new URL("../fixtures/pool-crashing-child.ts", import.meta.url));
		const child = await loadWorkerDefinition({
			path: childPath,
			exportName: "crashingChild",
			digest: await definitionDigest(childPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [{ definition: child, path: childPath, exportName: "crashingChild" }],
		});
		const caught: unknown[] = [];
		const parent = workflow({
			name: "pool-typed-fault-root",
			description: "",
			inputs: {},
			outputs: {},
			async run(ctx) {
				const settled = await Promise.allSettled([ctx.workflow(child), ctx.workflow(child)]);
				for (const outcome of settled) if (outcome.status === "rejected") caught.push(outcome.reason);
				return {};
			},
		});
		try {
			await run(
				parent,
				{},
				{ runId: "pool-typed-fault-root", cwd: directory, store: createStore(), durableBackend: backend },
			);
			assert.equal(caught.length, 2, "both concurrent children fail");
			for (const error of caught) {
				assert.ok(isRetryableWorkflowError(error), String(error));
				assert.ok(error instanceof WorkflowInfrastructureError);
				assert.equal(error.code, "worker_retry_limit");
				assert.match(error.message, /Local worker retry limit/);
			}
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a child that exhausts its own attempt limit fails alone, by name, while a sibling waiting on a prompt completes (#3996)",
	async () => {
		const directory = makeTempDirectory("pool-child-retry-limit-");
		const path = join(directory, "journal.sqlite");
		const journal = await resolveRunJournal({ journal: { path } });
		const backend = await JournalDurableBackend.open(journal);
		const crashingPath = fileURLToPath(new URL("../fixtures/pool-crashing-child.ts", import.meta.url));
		const promptPath = fileURLToPath(new URL("../fixtures/pool-prompt-child.ts", import.meta.url));
		const crashing = await loadWorkerDefinition({
			path: crashingPath,
			exportName: "crashingChild",
			digest: await definitionDigest(crashingPath),
		});
		const asking = await loadWorkerDefinition({
			path: promptPath,
			exportName: "child",
			digest: await definitionDigest(promptPath),
		});
		const pool = new LocalWorkerPool(backend, {
			journalPath: path,
			workers: 2,
			definitions: [
				{ definition: crashing, path: crashingPath, exportName: "crashingChild" },
				{ definition: asking, path: promptPath, exportName: "child" },
			],
		});
		const root = "pool-child-retry-limit-root";
		let crashFailure: unknown;
		const parent = workflow({
			name: root,
			description: "",
			inputs: {},
			outputs: { branch: Type.String() },
			async run(ctx) {
				// Every attempt of the crashing child kills its worker; the asking child's worker is never touched.
				const crashed = ctx.workflow(crashing).then(
					() => {},
					(error: unknown) => {
						crashFailure = error;
					},
				);
				const asked = ctx.workflow(asking, {});
				await crashed;
				return { branch: String((await asked).outputs.branch) };
			},
		});
		const store = createStore();
		try {
			const execution = run(
				parent,
				{},
				{ runId: root, cwd: directory, store, durableBackend: backend, usePromptNodesForUi: true },
			);
			await untilOrRunEnds(async () => crashFailure !== undefined, execution, CONDITION_TIMEOUT_MS);
			let prompt: { runId: string; stageId: string; promptId: string } | undefined;
			await untilOrRunEnds(
				async () => {
					for (const candidate of store.runs())
						for (const stage of candidate.stages)
							if (stage.pendingPrompt !== undefined && stage.workerExecution !== undefined)
								prompt = { runId: candidate.id, stageId: stage.id, promptId: stage.pendingPrompt.id };
					return prompt !== undefined;
				},
				execution,
				CONDITION_TIMEOUT_MS,
			);
			assert.ok(prompt !== undefined);
			assert.equal(store.resolveStagePendingPrompt(prompt.runId, prompt.stageId, prompt.promptId, "main"), true);
			const outcome = await execution;
			assert.equal(outcome.status, "completed", JSON.stringify(outcome.error));
			assert.deepEqual(outcome.result, { branch: "main" });

			assert.ok(crashFailure instanceof WorkflowInfrastructureError, String(crashFailure));
			assert.ok(isRetryableWorkflowError(crashFailure));
			assert.equal(crashFailure.code, "worker_retry_limit");
			assert.match(crashFailure.message, /Local worker retry limit/);
			await pool.close();
			const work = await (await openSqlPoolQueue(journal)).inspect(root);
			const failed = work.find((item) => item.definition.endsWith("#crashingChild"));
			assert.ok(failed, JSON.stringify(work));
			assert.ok(crashFailure.message.includes(failed.childRunId), crashFailure.message);
			assert.deepEqual(
				Object.fromEntries(work.map((item) => [item.definition.split("#")[1], item.state])),
				{ crashingChild: "failed", child: "completed" },
				"every work row of the finished root is terminal",
			);
		} finally {
			await pool.close().catch(() => {});
			await backend.close();
			removeTempDirectory(directory);
		}
	},
	WORKER_FAILURE_ROOT_TIMEOUT_MS,
);
