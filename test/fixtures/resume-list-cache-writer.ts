/**
 * Another Atomic process writing the shared store: `bun resume-list-cache-writer.ts <database> <command> ...`.
 * Session commands: `create <id> <cwd> <text>`, `rename <id> <name>`, `delete <id>`.
 * Run commands: `run-create <id> <status>`, `run-status <id> <status>`, `run-delete <id>`.
 */
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import type { DurableWorkflowStatus } from "../../packages/workflows/src/durable/types.js";

const [path, command, id, first, second] = process.argv.slice(2);
if (path === undefined || command === undefined || id === undefined) throw new Error("missing arguments");

if (command.startsWith("run-")) {
	const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));
	try {
		if (command === "run-create") {
			await backend.commitWorkflowRegistration({ workflowId: id, name: "process", inputs: {}, createdAt: 1, status: "running" });
			await backend.commitCheckpoint({ kind: "tool", workflowId: id, checkpointId: "tool", name: "tool", argsHash: "tool", output: "done", completedAt: 2 });
			await backend.commitWorkflowStatus(id, first as DurableWorkflowStatus);
		} else if (command === "run-status") await backend.commitWorkflowStatus(id, first as DurableWorkflowStatus);
		else if (command === "run-delete") await backend.deleteWorkflow(id);
		else throw new Error(`unknown command ${command}`);
	} finally {
		await backend.close();
	}
} else {
	const database = await openNodeSqliteDatabase(path);
	const store = await SqlSessionStore.open(database);
	try {
		if (command === "create") {
			const timestamp = new Date(Date.UTC(2026, 0, 2)).toISOString();
			await store.create({ id, version: 4, createdAt: timestamp, cwd: first! }, [
				{ type: "message", id: `${id}-message`, parentId: null, timestamp, message: { role: "user", content: second!, timestamp: Date.UTC(2026, 0, 2) } },
			]);
		} else if (command === "rename") {
			const { lastSeq } = await store.load(id);
			await store.append(id, [{ type: "session_info", id: `${id}-name-${lastSeq}`, parentId: null, timestamp: new Date().toISOString(), name: first! }], { expectSeq: lastSeq });
		} else if (command === "delete") await store.delete(id);
		else throw new Error(`unknown command ${command}`);
	} finally {
		await store.close();
		await database.close();
	}
}
