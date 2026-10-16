import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { JournalDurableBackend } = await jiti.import(
	resolve("packages/workflows/src/durable/journal/journal-backend.ts"),
);
const { SqliteRunJournal } = await jiti.import(resolve("packages/workflows/src/durable/journal/sqlite-run-journal.ts"));
const [, , path, length] = process.argv;
assert.ok(path);
const backend = await JournalDurableBackend.open(new SqliteRunJournal(path));
try {
	await backend.deleteWorkflow("run");
	backend.registerWorkflow({
		workflowId: "run",
		name: "replacement",
		inputs: { identity: "replacement" },
		createdAt: 5,
		updatedAt: 5,
		status: "running",
	});
	if (length === "longer") {
		backend.recordCheckpoint({
			kind: "tool",
			workflowId: "run",
			checkpointId: "new",
			argsHash: "new",
			name: "new",
			output: 1,
			completedAt: 6,
		});
	}
	console.log(JSON.stringify({ handle: backend.getWorkflow("run"), entries: backend.journal.readEntries("run") }));
} finally {
	await backend.close();
}
