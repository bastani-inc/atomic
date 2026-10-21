#!/usr/bin/env bun
/**
 * Concurrent writer for the resume-list benchmark: another process appending to its own sessions and
 * committing checkpoints for its own running workflows, the way live Atomic sessions and workflow stages do.
 */
import { randomUUID } from "node:crypto";
import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createSessionCwdMatcher } from "../../../packages/coding-agent/src/utils/canonical-path.ts";
import { JournalDurableBackend } from "../../../packages/workflows/src/durable/journal/journal-backend.js";
import { openSqlRunJournal } from "../../../packages/workflows/src/durable/journal/sqlite-run-journal.js";
import { messageEntry, sessionFixture, toolCheckpoint, words } from "./fixtures.ts";

const [path, root, intervalArg] = process.argv.slice(2);
if (path === undefined || root === undefined) throw new Error("usage: writer.ts <database> <root> [intervalMs]");
const intervalMs = Number(intervalArg ?? "25");

const database = await openNodeSqliteDatabase(path);
const sessions = await SqlSessionStore.open(database, { cwdMatcher: createSessionCwdMatcher });
const backend = await JournalDurableBackend.open(await openSqlRunJournal(path));

const owned: { id: string; seq: number }[] = [];
for (let index = 0; index < 4; index++) {
	const { header, entries } = sessionFixture(root, 900_000 + index, {
		projects: 20,
		messages: 2,
		wordsPerMessage: 20,
	});
	owned.push({ id: header.id, seq: (await sessions.create(header, entries)).lastSeq });
}
const runs: string[] = [];
for (let index = 0; index < 2; index++) {
	const workflowId = randomUUID();
	await backend.commitWorkflowRegistration({
		workflowId,
		name: `writer-${index}`,
		inputs: {},
		createdAt: Date.now(),
		status: "running",
	});
	runs.push(workflowId);
}

let stopped = false;
let tick = 0;
process.on("SIGTERM", () => {
	stopped = true;
});
process.stdout.write("ready\n");
while (!stopped) {
	tick++;
	const session = owned[tick % owned.length]!;
	const entry = messageEntry(`w-${tick}`, null, Date.now(), tick % 2 === 0 ? "user" : "assistant", words(tick, 30));
	session.seq = (await sessions.append(session.id, [entry], { expectSeq: session.seq })).lastSeq;
	await backend.commitCheckpoint(toolCheckpoint(runs[tick % runs.length]!, tick, 30));
	await Bun.sleep(intervalMs);
}
await backend.close();
await sessions.close();
await database.close();
process.stdout.write(`wrote ${tick}\n`);
