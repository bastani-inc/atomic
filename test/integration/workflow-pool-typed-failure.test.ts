import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitUnavailableError } from "@bastani/atomic";
import { beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { findStageWaitError, StageRehydrationError } from "../../packages/workflows/src/shared/stage-wait-errors.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import {
	isWorkflowGitRequiredError,
	WorkflowGitRequiredError,
} from "../../packages/workflows/src/shared/workflow-git-required-error.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { GIT_REQUIRED_FIELDS, REHYDRATION_FIELDS } from "../fixtures/pool-typed-failure-child.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** Starts a pool coordinator and a worker process, which load the packaged workflows runtime. */
const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;

beforeAll(async () => {
	const workerEntry = fileURLToPath(
		new URL("../../packages/coding-agent/dist/builtin/workflows/src/local-worker-entry.mjs", import.meta.url),
	);
	assert.ok(await fileExists(workerEntry), "packaged worker missing; run npm run build first");
});

/**
 * Runs a root whose one child, the fixture's `exportName`, runs on a local worker and fails. Returns the error the
 * root's `ctx.workflow(child)` rejected with, the root's result, and the child's result as the pool's journal stored it.
 */
async function runPooledChild(exportName: string, runId: string) {
	const directory = makeTempDirectory("pool-typed-failure-");
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const childPath = fileURLToPath(new URL("../fixtures/pool-typed-failure-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	const caught: unknown[] = [];
	const root = workflow({
		name: "pool-typed-failure-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			try {
				await ctx.workflow(child);
			} catch (error) {
				caught.push(error);
				throw error;
			}
			return {};
		},
	});
	const pool = new LocalWorkerPool(backend, {
		journalPath: path,
		workers: 1,
		definitions: [{ definition: child, path: childPath, exportName }],
	});
	try {
		const result = await run(root, {}, { runId, cwd: directory, store: createStore(), durableBackend: backend });
		assert.equal(caught.length, 1, JSON.stringify(result));
		// The child ran on a worker: its result, with the detail, reached the root through the pool's journal.
		const queue = await openSqlPoolQueue(journal);
		const [work] = await queue.inspect(runId);
		assert.ok(work, "the child was not dispatched to the pool");
		const stored = (await queue.result(runId, work.id)) as RunResult | undefined;
		return { error: caught[0], result, stored };
	} finally {
		await pool.close();
		await backend.close();
		removeTempDirectory(directory);
	}
}

test(
	"a pooled child failing with StageRehydrationError puts it in the root's error chain (#4309)",
	async () => {
		const { error, result, stored } = await runPooledChild("child", "pool-typed-root");

		const found = findStageWaitError(error);
		assert.ok(found instanceof StageRehydrationError, `no StageRehydrationError in ${String(error)}`);
		assert.equal(found.code, "session-unavailable");
		assert.deepEqual(found.fields, REHYDRATION_FIELDS);
		assert.equal((found.cause as Error | undefined)?.message, "session store unreachable");
		assert.equal(result.failureDetail?.name, "StageRehydrationError", JSON.stringify(result));
		assert.equal(stored?.failureDetail?.family, "stage-wait", JSON.stringify(stored));
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test(
	"a pooled child failing with WorkflowGitRequiredError puts it, with its GitUnavailableError, in the root's error chain (#4378)",
	async () => {
		const { error, stored } = await runPooledChild("gitRequiredChild", "pool-git-required-root");

		let found: unknown = error;
		for (let depth = 0; depth < 8 && !isWorkflowGitRequiredError(found); depth++)
			found = (found as { readonly cause?: unknown } | undefined)?.cause;
		assert.ok(found instanceof WorkflowGitRequiredError, `no WorkflowGitRequiredError in ${String(error)}`);
		assert.equal(found.code, "git-required");
		assert.deepEqual(found.fields, GIT_REQUIRED_FIELDS);
		assert.equal(found.retryable, false);
		assert.ok(found.cause instanceof GitUnavailableError, String(found.cause));
		assert.equal(found.cause.code, "offline");
		assert.equal(found.hint, found.cause.hint);
		assert.deepEqual(
			[stored?.failureDetail?.family, stored?.failureDetail?.cause?.family],
			["git-required", "git-provision"],
		);
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
