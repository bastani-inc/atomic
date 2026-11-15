import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { DurableWorkflowStatus, ResumableWorkflowEntry } from "../../packages/workflows/src/durable/types.js";
import { dropLibsqlScope } from "../helpers/storage-backends.js";

/**
 * The `/workflow resume` catalog on a real libSQL server (sqld) over HTTP, where each request runs on a new stream
 * (#4814). Runs only when a server is named with `ATOMIC_TEST_LIBSQL_URL` (and `ATOMIC_TEST_LIBSQL_TOKEN_FILE` when it
 * checks tokens), as in `session-list-sqld.test.ts`. Each test works under a table prefix of its own, so the server
 * may be shared.
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const tokenFile = process.env.ATOMIC_TEST_LIBSQL_TOKEN_FILE;

async function register(backend: JournalDurableBackend, workflowId: string, status: DurableWorkflowStatus) {
	await backend.commitWorkflowRegistration({
		workflowId,
		name: "sqld-catalog",
		inputs: {},
		createdAt: 1,
		status: "running",
	});
	// The catalog lists a run once it has done some work.
	await backend.commitCheckpoint({
		kind: "tool",
		workflowId,
		checkpointId: "tool",
		name: "tool",
		argsHash: "tool",
		output: "done",
		completedAt: 2,
	});
	await backend.commitWorkflowStatus(workflowId, status);
	await backend.releaseWorkflow(workflowId);
}

function statuses(entries: readonly ResumableWorkflowEntry[]): Record<string, string> {
	return Object.fromEntries(entries.map((entry) => [entry.workflowId, entry.status]));
}

describe.skipIf(serverUrl === undefined)("the workflow resume catalog on a libSQL server (#4814)", () => {
	test.each(["the listing journal", "another client"] as const)(
		"changes written through %s are listed by a backend that listed before them",
		async (writer) => {
			const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
			const open = () => openLibsqlDatabase({ url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) });
			const prefix = `wfc_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
			const databases: SqliteDatabase[] = [await open()];
			const journal = await SqlRunJournal.open(databases[0]!, { prefix });
			const reader = await JournalDurableBackend.open(journal);
			const backends: JournalDurableBackend[] = [reader];
			const [paused, completed, replacing] = [randomUUID(), randomUUID(), randomUUID()];
			try {
				let writing = await JournalDurableBackend.open(journal, { ownsJournal: false });
				if (writer === "another client") {
					databases.push(await open());
					writing = await JournalDurableBackend.open(await SqlRunJournal.open(databases[1]!, { prefix }));
				}
				backends.unshift(writing);
				await register(writing, paused, "paused");
				await register(writing, completed, "completed");
				assert.deepEqual(statuses((await reader.prepareWorkflowCatalog()).completed), { [completed]: "completed" });
				// The run that wrote last is replaced by one with as many events: the run count and the last event's
				// rowid are as they were.
				await writing.deleteWorkflow(completed);
				await register(writing, replacing, "completed");
				assert.deepEqual(statuses((await reader.prepareWorkflowCatalog()).completed), { [replacing]: "completed" });
				await writing.commitWorkflowStatus(paused, "failed");
				assert.equal(statuses((await reader.prepareWorkflowCatalog()).resumable)[paused], "failed");
				for (const id of [paused, replacing]) await writing.deleteWorkflow(id);
			} finally {
				for (const backend of backends) await backend.close();
				// Tables left on the server slow every later request to it: sqld loads the whole schema for each (#4768).
				await dropLibsqlScope(databases[0]!, prefix);
				for (const database of databases) await database.close();
			}
		},
	);
});
