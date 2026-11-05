import assert from "node:assert/strict";
import { join } from "node:path";
import {
	findJournalStoreError,
	isJournalCatalogError,
	SHARED_STORAGE_JOIN_HINT,
	WorkflowRunNotFoundError,
} from "@bastani/atomic";
import { afterEach, beforeEach, test } from "vitest";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { ShardedRunJournal } from "../../packages/workflows/src/durable/journal/sharded-run-journal.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { PiEventContext } from "../../packages/workflows/src/extension/public-types.js";
import type { ExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createSessionRunControl } from "../../packages/workflows/src/extension/workflow-session-run-control.js";
import { workflowResumeAction } from "../../packages/workflows/src/extension/workflow-tool-control.js";
import { store } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { configureCurrentTestStoreBackend as setDurableBackend } from "../helpers/store-backend.js";

const MISSING_RUN = "0f1e2d3c-4b5a-4968-8776-655443322110";
const OPERATIONS_BOUND = 3;

let directory: string;
beforeEach(() => {
	store.clear();
	directory = makeTempDirectory("workflow-tool-resume-not-found-");
});
afterEach(() => {
	setDurableBackend(undefined);
	store.clear();
	removeTempDirectory(directory);
});

test("the workflow tool's resume of a run the journal store does not hold fails fast, typed, with the join command (#4325)", async () => {
	const journal = await ShardedRunJournal.open({
		directory: join(directory, "journal"),
		openShard: (path) => openSqlRunJournal(path),
	});
	const backend = await JournalDurableBackend.open(journal);
	setDurableBackend(backend);
	try {
		await backend.commitWorkflowRegistration({
			workflowId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
			name: "present",
			inputs: {},
			createdAt: 1,
			status: "paused",
		});
		const operations: string[] = [];
		for (const method of [
			"getRun",
			"listRuns",
			"read",
			"snapshotTail",
			"runVersions",
			"changeToken",
			"createRun",
			"acquire",
			"append",
		] as const) {
			const original = (journal[method] as (...args: never[]) => unknown).bind(journal);
			Reflect.set(journal, method, (...args: never[]) => {
				operations.push(method);
				return original(...args);
			});
		}
		const runtime = {
			durableBackend: () => backend,
			prepareDurableResumableForIds: async (ids: readonly string[]) => {
				for (const id of ids) await backend.hydrateWorkflow(id);
				return [];
			},
			resumeDurableWorkflow: async () => assert.fail("a missing run must not dispatch"),
		} as unknown as ExtensionRuntime;
		const deps = { getRuntime: () => runtime, policy: {} as never, ensureWorkflowResourcesLoaded: () => undefined };

		const result = await workflowResumeAction({ action: "resume", runId: MISSING_RUN }, deps);
		assert.equal(result.action, "resume");
		if (result.action !== "resume") return;
		assert.deepEqual([result.status, result.code, result.runId], ["noop", "run_not_found", MISSING_RUN]);
		assert.ok(operations.length <= OPERATIONS_BOUND, `failed after ${operations.length}: ${operations.join(", ")}`);
		assert.deepEqual(
			operations.filter((method) => ["createRun", "acquire", "append"].includes(method)),
			[],
			"nothing was written",
		);

		const control = createSessionRunControl({
			execute: (args) => workflowResumeAction(args, deps),
			context: (): PiEventContext => ({
				sessionManager: { getSessionId: () => "resume-session" },
				cwd: directory,
				ui: { notify: () => undefined },
				hasUI: false,
			}),
			store,
		});
		const rejected = await control.resume(MISSING_RUN).catch((error: Error) => error);
		assert.ok(rejected instanceof WorkflowRunNotFoundError);
		const typed = findJournalStoreError(rejected);
		assert.ok(isJournalCatalogError(typed));
		assert.deepEqual([typed.code, typed.runId, typed.fields.localOnly], ["run-not-found", MISSING_RUN, true]);
		assert.ok(typed.hint.includes(SHARED_STORAGE_JOIN_HINT));
	} finally {
		await backend.close();
	}
});
