/**
 * The PostgreSQL search index's pending list: new search text waits there until it is merged into the index. A write
 * of search text holds the session's lock, so it must never merge the list itself; a background merge outside any
 * session's lock, or autovacuum, does.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import {
	SEARCH_PENDING_LIST_LIMIT_KB,
	SEARCH_PENDING_MERGE_CHARS,
} from "../../packages/coding-agent/src/core/storage/session/session-search-index.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { openPostgresAdmin, postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

const PREFIX = "pend_";
const FORMAT = 1;
const ENTRY_CHARS = 4_000;
/** The server's default `gin_pending_list_limit`, which made the write that crossed it merge the whole list. */
const SERVER_DEFAULT_LIMIT_BYTES = 4 * 1024 * 1024;
const TEST_TIMEOUT_MS = 120_000;

function message(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-26T00:00:00.000Z",
		message: { role: "user", content: id, timestamp: 0 },
	};
}

/** Text with many distinct trigrams, as hexadecimal identifiers in tool output have: it fills the pending list fast. */
function noisyText(): string {
	return Array.from({ length: ENTRY_CHARS / 10 }, () => randomBytes(4).toString("hex"))
		.join(" ")
		.padEnd(ENTRY_CHARS);
}

async function createSession(store: SqlSessionStore, id: string, entries: number): Promise<void> {
	await store.create(
		{ id, version: SESSION_FORMAT_VERSION, createdAt: "2026-11-26T00:00:00.000Z", cwd: "/p" },
		Array.from({ length: entries }, (_, index) => message(`${id}-e${index + 1}`)),
	);
}

/** Indexes entries 1 to `texts.length` of `id`, 8 at a time, as history searches do. */
async function indexSession(store: SqlSessionStore, id: string, texts: readonly string[]): Promise<void> {
	const index = store.searchIndex;
	assert.ok(index, "the store keeps a search index");
	for (let after = 0; after < texts.length; after += 8) {
		const through = Math.min(texts.length, after + 8);
		const batch = texts.slice(after, through).map((text, offset) => ({ seq: after + offset + 1, text }));
		assert.equal(await index.extend(id, FORMAT, after, through, batch), true, `index write through ${through}`);
	}
}

async function pendingList(database: SqliteDatabase): Promise<{ pages: number; tuples: number }> {
	const row = await database.get<{ pending_pages: number | bigint; pending_tuples: number | bigint }>(
		`SELECT pending_pages, pending_tuples FROM pgstatginindex('${PREFIX}session_search_trgm'::regclass)`,
	);
	return { pages: Number(row?.pending_pages), tuples: Number(row?.pending_tuples) };
}

describe.skipIf(postgresSkipReason !== undefined)("PostgreSQL search index pending list", () => {
	it(
		"writes of search text leave the pending list to a background merge, and searches find the text before and after it",
		async () => {
			const runtime = `atomic_pending_${randomBytes(4).toString("hex")}`;
			const password = `pw-${randomBytes(8).toString("hex")}`;
			try {
				await withPostgresDatabase(async (scope) => {
					// The administrator owns the tables, as `atomic storage migrate` run as the owner leaves them.
					const owner = await scope.open();
					const ownerStore = await SqlSessionStore.open(owner, { prefix: PREFIX });
					const settings = await owner.get<{ index: string; table: string }>(
						`SELECT array_to_string(i.reloptions, ',') AS index, array_to_string(t.reloptions, ',') AS table
						FROM pg_class i, pg_class t WHERE i.oid = '${PREFIX}session_search_trgm'::regclass AND t.oid = '${PREFIX}session_search_entries'::regclass`,
					);
					assert.match(
						String(settings?.index),
						new RegExp(`gin_pending_list_limit=${SEARCH_PENDING_LIST_LIMIT_KB}`),
					);
					assert.match(String(settings?.table), /autovacuum_vacuum_insert_threshold=1000/);
					assert.match(String(settings?.table), /autovacuum_vacuum_insert_scale_factor=0/);
					await owner.exec("CREATE EXTENSION IF NOT EXISTS pgstattuple");
					// Autovacuum also merges the list; kept out here so only Atomic's writes act on it.
					await owner.exec(`ALTER TABLE ${PREFIX}session_search_entries SET (autovacuum_enabled = false)`);

					// A role that does not own the index may not merge its list, so nothing merges it while that role
					// writes more text than the server's default limit lets the list hold.
					const schema = String(
						(await owner.get<{ schema: string }>("SELECT current_schema() AS schema"))?.schema,
					);
					for (const statement of [
						`CREATE ROLE ${runtime} LOGIN PASSWORD '${password}'`,
						`GRANT CONNECT ON DATABASE ${scope.name} TO ${runtime}`,
						`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`,
						`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtime}`,
						`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtime}`,
						`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${runtime}`,
					])
						await owner.exec(statement);
					const url = new URL(scope.url);
					url.username = runtime;
					const runtimeStore = await SqlSessionStore.open(await scope.open({ url: url.href, password }), {
						prefix: PREFIX,
					});
					const texts = Array.from({ length: 200 }, noisyText);
					await createSession(runtimeStore, "runtime", texts.length);
					await indexSession(runtimeStore, "runtime", texts);
					const written = await owner.get<{ rows: number | bigint }>(
						`SELECT count(*) AS rows FROM ${PREFIX}session_search_entries`,
					);
					const held = await pendingList(owner);
					assert.ok(
						held.pages * 8192 > SERVER_DEFAULT_LIMIT_BYTES,
						`the list outgrew the server's default limit: ${held.pages} pages`,
					);
					assert.equal(held.tuples, Number(written?.rows), "no write merged the list");
					const literal = texts[150]!.slice(9, 26);
					assert.deepEqual(
						await runtimeStore.searchIndex?.candidates("runtime", [[literal]], 1, texts.length, 10),
						[151],
						"a search reads the pending list",
					);

					// The owner's writes start a merge in the background once they have written enough text, which
					// empties the list of every role's text. Its last write is the one that starts it.
					const ownerTexts = Array.from(
						{ length: Math.ceil(SEARCH_PENDING_MERGE_CHARS / ENTRY_CHARS) },
						noisyText,
					);
					await createSession(ownerStore, "owner", ownerTexts.length);
					await indexSession(ownerStore, "owner", ownerTexts);
					const deadline = Date.now() + 60_000;
					while ((await pendingList(owner)).pages > 0) {
						assert.ok(Date.now() < deadline, "the background merge emptied the list");
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
					assert.deepEqual(
						await runtimeStore.searchIndex?.candidates("runtime", [[literal]], 1, texts.length, 10),
						[151],
						"a search finds the merged text",
					);
					await runtimeStore.close();
					await ownerStore.close();
				});
			} finally {
				const admin = await openPostgresAdmin();
				try {
					await admin.exec(`DROP ROLE IF EXISTS ${runtime}`);
				} finally {
					await admin.close();
				}
			}
		},
		TEST_TIMEOUT_MS,
	);
});
