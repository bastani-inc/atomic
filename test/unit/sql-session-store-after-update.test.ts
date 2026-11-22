/**
 * A process of 0.10.3 that an in-place update caught keeps the storage modules it loaded, whose copies lack the helpers
 * that batch a store's setup and writes, and can load the session store from the update
 * (`test/unit/in-place-update-releases.test.ts` holds the build's imports to those copies). These tests run the store
 * against such copies: each module as this build has it, without the names 0.10.3's copy lacks.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { ConnectionRequest } from "../../packages/coding-agent/src/core/storage/node-sqlite-thread.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { interceptConnectionRequests } from "../helpers/sqlite-connection-requests.js";

vi.mock("../../packages/coding-agent/src/core/storage/migrations.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/coding-agent/src/core/storage/migrations.js")>()),
	applyStorageMigrationsTogether: undefined,
}));
vi.mock("../../packages/coding-agent/src/core/storage/statement-sequence.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/coding-agent/src/core/storage/statement-sequence.js")>()),
	statementBatch: undefined,
}));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function message(id: string, text: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-22T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

test("a session store loaded against 0.10.3's storage modules sets up a new SQLite file and keeps what it writes", async () => {
	const directory = makeTempDirectory("atomic-store-after-update-");
	const sent: ConnectionRequest[] = [];
	const interception = interceptConnectionRequests((request, send) => {
		sent.push(request);
		return send(request);
	});
	cleanups.push(() => removeTempDirectory(directory));
	cleanups.push(() => interception.restore());
	const database = await openNodeSqliteDatabase(join(directory, "store.sqlite"));
	cleanups.push(() => database.close());

	const store = await SqlSessionStore.open(database);
	const first = message("m1", "first", null);
	const created = await store.create({ id: "s1", version: 4, cwd: "/work", createdAt: "2026-11-22T00:00:00.000Z" }, [
		first,
	]);
	await store.append("s1", [message("m2", "second", first.id)], { expectSeq: created.lastSeq, epoch: created.epoch });
	await store.close();
	const reopened = await SqlSessionStore.open(database);
	cleanups.push(() => reopened.close());
	const loaded = await reopened.load("s1");
	assert.deepEqual(
		loaded.entries.map((entry) =>
			entry.type === "message" && "content" in entry.message ? entry.message.content : "",
		),
		["first", "second"],
	);
	// 0.10.3's connection thread runs each statement of a sequence request as one prepared statement.
	const scripts = sent.flatMap((request) =>
		request.kind === "sequence"
			? request.statements.filter((statement) => statement.script === true).map(({ sql }) => sql)
			: [],
	);
	assert.deepEqual(scripts, []);
});
