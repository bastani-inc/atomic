import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { storageBackends } from "../helpers/storage-backends.js";

const FORMAT = 1;

function header(id: string): SessionRecordHeader {
	return { id, version: SESSION_FORMAT_VERSION, createdAt: "2026-11-16T00:00:00.000Z", cwd: "/project" };
}

function message(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-11-16T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: 0 },
	};
}

const TEXTS = ["alpha needle", "plain", "Needle beta", 'a_b%c "q"', "axbyc \u017fong \u212Aelvin"];
const entries = TEXTS.map((text, index) => message(`e${index + 1}`, text));
const texts = TEXTS.map((text, index) => ({ seq: index + 1, text }));

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? it : it.skip;
	describe(`session search index on ${backend.name} (#5250)`, () => {
		run("finds an entry by its text only when it holds every string of a set, case aside (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				const index = store.searchIndex;
				assert.ok(index, "the store keeps a search index");
				await store.create(header("s"), entries);
				assert.deepEqual(await index.coverage("s", FORMAT), { indexedSeq: 0, lastSeq: 5 });
				assert.equal(await index.coverage("missing", FORMAT), undefined);
				assert.equal(await index.extend("s", FORMAT, 0, 3, texts.slice(0, 3)), true);
				assert.equal(
					await index.extend("s", FORMAT, 0, 3, texts.slice(0, 3)),
					false,
					"a stale extension is refused",
				);
				assert.equal(await index.extend("s", FORMAT, 3, 5, texts.slice(3)), true);
				assert.deepEqual(await index.coverage("s", FORMAT), { indexedSeq: 5, lastSeq: 5 });
				assert.deepEqual(await index.candidates("s", [["needle"]], 1, 5, 10), [1, 3]);
				assert.deepEqual(await index.candidates("s", [["needle", "beta"]], 1, 5, 10), [3]);
				assert.deepEqual(await index.candidates("s", [["zzzz"], ["alp"]], 1, 5, 10), [1]);
				assert.deepEqual(await index.candidates("s", [["needle"]], 2, 5, 10), [3]);
				assert.deepEqual(await index.candidates("s", [["needle"]], 1, 5, 1), [1]);
				assert.deepEqual(await index.candidates("s", [["a_b%c"]], 1, 5, 10), [4], "a LIKE wildcard is literal");
				assert.deepEqual(await index.candidates("s", [['"q"']], 1, 5, 10), [4], "a quote is literal");
				assert.deepEqual(
					await index.candidates("s", [["song", "kelvin"]], 1, 5, 10),
					[5],
					"letters that fold to ASCII",
				);
				assert.deepEqual(await index.candidates("other", [["needle"]], 1, 5, 10), []);
				assert.deepEqual(await index.coverage("s", FORMAT + 1), { indexedSeq: 0, lastSeq: 5 });
				assert.deepEqual(await index.candidates("s", [["needle"]], 1, 5, 10), [], "another format starts over");
			} finally {
				await scope.close();
			}
		});

		run("finds text anywhere in an entry too long for one index row (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				const index = store.searchIndex!;
				const longLiteral = `${"w".repeat(300)}straddling-needle${"v".repeat(300)}`;
				const text = `${"a".repeat(16_380)}${longLiteral}${"b".repeat(80_000)}tail-needle`;
				await store.create(header("long"), [message("e1", "short"), message("e2", text)]);
				assert.equal(
					await index.extend("long", FORMAT, 0, 2, [
						{ seq: 1, text: "short" },
						{ seq: 2, text },
					]),
					true,
				);
				assert.deepEqual(await index.candidates("long", [[longLiteral]], 1, 2, 10), [2]);
				assert.deepEqual(await index.candidates("long", [["tail-needle"]], 1, 2, 10), [2]);
				assert.deepEqual(await index.candidates("long", [["aaaa", "tail-needle"]], 1, 2, 10), [2]);
				assert.deepEqual(await index.candidates("long", [["short"], ["aaaa"]], 1, 2, 10), [1, 2]);
				assert.deepEqual(await index.candidates("long", [["absent-needle"]], 1, 2, 10), []);
			} finally {
				await scope.close();
			}
		});

		run("forgets a session's text when the session is rewritten or deleted (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const database = await scope.connect();
				const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
				const index = store.searchIndex!;
				await store.create(header("s"), entries);
				assert.equal(await index.extend("s", FORMAT, 0, 5, texts), true);
				await store.replace("s", header("s"), entries.slice(0, 2), { expectSeq: 5 });
				assert.deepEqual(await index.coverage("s", FORMAT), { indexedSeq: 0, lastSeq: 2 });
				assert.deepEqual(await index.candidates("s", [["needle"]], 1, 5, 10), []);
				assert.equal(await index.extend("s", FORMAT, 0, 2, texts.slice(0, 2)), true);
				await database.run(`DELETE FROM ${scope.prefix}session_entries WHERE session_id = ?`, "s");
				assert.deepEqual(await index.coverage("s", FORMAT), { indexedSeq: 0, lastSeq: 2 });
				assert.deepEqual(await index.candidates("s", [["needle"]], 1, 5, 10), []);
				await store.delete("s");
				assert.equal(await index.coverage("s", FORMAT), undefined);
				await store.create(header("s"), entries.slice(0, 1));
				assert.deepEqual(await index.coverage("s", FORMAT), { indexedSeq: 0, lastSeq: 1 });
				assert.deepEqual(await index.candidates("s", [["needle"]], 1, 5, 10), []);
			} finally {
				await scope.close();
			}
		});

		run("keeps reading entries by range without loading the session (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				await store.create(header("s"), entries);
				const page = await store.readEntryRange("s", { fromSeq: 2, toSeq: 4 });
				assert.deepEqual(
					page.entries.map((entry) => entry.seq),
					[2, 3, 4],
				);
				assert.equal(page.lastSeq, 5);
				assert.equal(page.throughSeq, 4);
				const capped = await store.readEntryRange("s", { fromSeq: 1, toSeq: 5, maxChars: 1 });
				assert.deepEqual(
					capped.entries.map((entry) => entry.seq),
					[1],
				);
				assert.equal(capped.throughSeq, 1);
			} finally {
				await scope.close();
			}
		});

		if (backend.name === "Postgres")
			run("prefilters with a pg_trgm index on Postgres (#5250)", async () => {
				const scope = await backend.openScope();
				try {
					const database = await scope.connect();
					await SqlSessionStore.open(database, { prefix: scope.prefix });
					const found = await database.get(
						"SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?",
						dialectOf(database).identifier(`${scope.prefix}session_search_trgm`),
					);
					assert.match(String(found?.indexdef), /gin_trgm_ops/);
				} finally {
					await scope.close();
				}
			});
	});
}
