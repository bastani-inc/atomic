#!/usr/bin/env bun
/**
 * Concurrent writer for the resume-list benchmark: another process appends to its own sessions.
 */

import { openNodeSqliteDatabase } from "../../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { createSessionCwdMatcher } from "../../../packages/coding-agent/src/utils/canonical-path.js";

import { messageEntry, sessionFixture, words } from "./fixtures.js";

const [path, root, intervalArg] = process.argv.slice(2);
if (path === undefined || root === undefined) throw new Error("usage: writer.ts <database> <root> [intervalMs]");
const intervalMs = Number(intervalArg ?? "25");

const database = await openNodeSqliteDatabase(path);
const sessions = await SqlSessionStore.open(database, { cwdMatcher: createSessionCwdMatcher });

const owned: { id: string; seq: number }[] = [];
for (let index = 0; index < 4; index++) {
	const { header, entries } = sessionFixture(root, 900_000 + index, {
		projects: 20,
		messages: 2,
		wordsPerMessage: 20,
	});
	owned.push({ id: header.id, seq: (await sessions.create(header, entries)).lastSeq });
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

	await Bun.sleep(intervalMs);
}
await sessions.close();
await database.close();
process.stdout.write(`wrote ${tick}\n`);
