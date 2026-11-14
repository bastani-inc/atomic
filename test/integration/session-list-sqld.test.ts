import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openLibsqlDatabase } from "../../packages/storage-libsql/libsql.js";

/**
 * Session listings on a real libSQL server (sqld) over HTTP, where each request runs on a new stream (#4805). Runs only
 * when a server is named with `ATOMIC_TEST_LIBSQL_URL` (and `ATOMIC_TEST_LIBSQL_TOKEN_FILE` when it checks tokens), as
 * in `session-blob-sqld.test.ts`. Each test works under a table prefix of its own, so the server may be shared.
 */
const serverUrl = process.env.ATOMIC_TEST_LIBSQL_URL;
const tokenFile = process.env.ATOMIC_TEST_LIBSQL_TOKEN_FILE;

const rename = (id: string, name: string): SessionEntry => ({
	type: "session_info",
	id,
	parentId: null,
	timestamp: new Date().toISOString(),
	name,
});

async function names(store: SqlSessionStore): Promise<(string | undefined)[]> {
	const listed: (string | undefined)[] = [];
	for await (const summary of store.list({})) listed.push(summary.name);
	return listed;
}

describe.skipIf(serverUrl === undefined)("session listings on a libSQL server (#4805)", () => {
	test.each(["the listing store", "another client"] as const)(
		"a rename written through %s is listed by a store that listed before it",
		async (writer) => {
			const authToken = tokenFile === undefined ? undefined : readFileSync(tokenFile, "utf8").trim();
			const open = () => openLibsqlDatabase({ url: serverUrl!, ...(authToken === undefined ? {} : { authToken }) });
			const prefix = `list_${randomUUID().replaceAll("-", "_").slice(0, 12)}_`;
			const databases: SqliteDatabase[] = [await open()];
			const store = await SqlSessionStore.open(databases[0]!, { prefix });
			const stores = [store];
			try {
				const id = randomUUID();
				await store.create({ id, version: 4, createdAt: new Date(0).toISOString(), cwd: "/project" }, []);
				assert.deepEqual(await names(store), [undefined]);
				let renaming = store;
				if (writer === "another client") {
					databases.push(await open());
					renaming = await SqlSessionStore.open(databases[1]!, { prefix });
					stores.push(renaming);
				}
				// Only the session's row changes: no session is added or removed.
				await renaming.append(id, [rename("named", "Named")], { expectSeq: 0 });
				assert.deepEqual(await names(store), ["Named"]);
				await renaming.append(id, [rename("cleared", "")], { expectSeq: 1 });
				assert.deepEqual(await names(store), [""]);
				await store.delete(id);
			} finally {
				for (const opened of stores) await opened.close();
				for (const database of databases) await database.close();
			}
		},
	);
});
