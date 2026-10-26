import assert from "node:assert/strict";
import type { ForkOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, test, vi } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import type { WorkflowSerializableObject } from "../../packages/workflows/src/shared/types.js";
import { definitionDigest, loadWorkerDefinition } from "../../packages/workflows/src/workers/definitions.js";
import { LocalWorkerPool } from "../../packages/workflows/src/workers/local-pool.js";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const LOCAL_WORKER_PROCESS_TIMEOUT_MS = 120_000;
const ORDINARY = "ENOENT: no such file or directory, open '/tmp/missing-input.json'";
const RATE_LIMITED = "429 Too Many Requests";

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

interface RootRun {
	readonly result: RunResult;
	readonly snapshot: RunSnapshot | undefined;
	readonly journalStatus: string | undefined;
	/** The child's result as the pool stored it in the journal. */
	readonly storedChild: WorkflowSerializableObject | undefined;
}

/** Runs a root over one pooled child `runs` times on the same journal; each later run resumes the first. */
async function runPooledRoot(
	exportName: "namedChild" | "plainChild",
	message: string,
	runs: number,
	executions: string,
	directory: string,
): Promise<RootRun[]> {
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	const backend = await JournalDurableBackend.open(journal);
	const childPath = fileURLToPath(new URL("../fixtures/pool-named-failure-child.ts", import.meta.url));
	const child = await loadWorkerDefinition({ path: childPath, exportName, digest: await definitionDigest(childPath) });
	const root = workflow({
		name: "pool-child-failure-root",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(child, { inputs: { message, executions } });
			return {};
		},
	});
	const outcomes: RootRun[] = [];
	try {
		for (let attempt = 0; attempt < runs; attempt++) {
			const pool = new LocalWorkerPool(backend, {
				journalPath: path,
				workers: 1,
				definitions: [{ definition: child, path: childPath, exportName }],
			});
			try {
				const store = createStore();
				const result = await run(root, {}, { runId: "pool-root", cwd: directory, store, durableBackend: backend });
				const queue = await openSqlPoolQueue(journal);
				const [work] = await queue.inspect("pool-root");
				outcomes.push({
					storedChild: work === undefined ? undefined : await queue.result("pool-root", work.id),
					result,
					snapshot: store.runs().find((entry) => entry.id === "pool-root"),
					journalStatus: (await journal.getRun("pool-root"))?.status,
				});
			} finally {
				await pool.close();
			}
		}
	} finally {
		await backend.close();
	}
	return outcomes;
}

function executionCount(executions: string): number {
	return readFileSync(executions, "utf8").trim().split("\n").length;
}

test(
	"a pooled child named like a rate limit that fails on an ordinary error fails the root (#4031)",
	async () => {
		const directory = makeTempDirectory("pool-child-failure-");
		try {
			const [outcome] = await runPooledRoot("namedChild", ORDINARY, 1, join(directory, "runs"), directory);
			assert.equal(outcome!.result.status, "failed", JSON.stringify(outcome!.result));
			assert.match(outcome!.result.error ?? "", /child workflow "rate-limit-overloaded-child".*ENOENT/);
			assert.equal(outcome!.snapshot?.failureKind, "unknown");
			assert.notEqual(outcome!.snapshot?.failureDisposition, "active_blocked");
			assert.equal(outcome!.journalStatus, "failed");
		} finally {
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);

test(
	"a pooled child's 429 blocks the root resumably, also when a resumed root replays its stored result (#4031)",
	async () => {
		const directory = makeTempDirectory("pool-child-limited-");
		const executions = join(directory, "runs");
		try {
			const [first, resumed] = await runPooledRoot("plainChild", RATE_LIMITED, 2, executions, directory);
			for (const outcome of [first!, resumed!]) {
				assert.equal(outcome.result.status, "running", JSON.stringify(outcome.result));
				assert.match(outcome.result.error ?? "", /child workflow "plain-child".*429 Too Many Requests/);
				assert.equal(outcome.snapshot?.failureKind, "rate_limit");
				assert.equal(outcome.snapshot?.failureDisposition, "active_blocked");
			}
			// The resumed root classified the child's result stored in the journal; the child did not run again.
			assert.equal(executionCount(executions), 1);
			// That stored result carries the child's own classification across the worker's IPC and the journal.
			assert.deepEqual(resumed!.storedChild?.failure, {
				kind: "rate_limit",
				code: "rate_limited",
				retryable: true,
				resumable: true,
				recoverability: "recoverable",
			});
		} finally {
			removeTempDirectory(directory);
		}
	},
	LOCAL_WORKER_PROCESS_TIMEOUT_MS,
);
