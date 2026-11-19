import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, it } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { dialectOf } from "../../packages/coding-agent/src/core/storage/dialect.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	SESSION_FORMAT_VERSION,
	type SessionRecordHeader,
} from "../../packages/coding-agent/src/core/storage/session/types.js";
import { createHistoryRouter } from "../../packages/coding-agent/src/core/tools/history-protocol.js";
import {
	openPostgresAdmin,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";
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

const SCAN_ENTRIES = 300;
const SCAN_NEEDLE = 240;
const SCAN_ROWS = 50;
const WINDOWED_ENTRIES = 5_000;
const WINDOWED_PAGE = 256;
const WINDOWED_NEEDLES = [1, 4_500, 4_999];
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
				const fresh = await index.coverage("s", FORMAT);
				assert.deepEqual(fresh, { indexedSeq: 0, lastSeq: 1 });
				assert.equal(
					await index.extend("s", FORMAT, 0, 1, texts.slice(0, 1), {
						generation: fresh?.generation,
						revision: "stale-revision",
					}),
					false,
				);
				assert.deepEqual(await index.candidates("s", [["needle"]], 1, 5, 10), []);
			} finally {
				await scope.close();
			}
		});

		run("indexes text that holds a NUL character (#5250)", async () => {
			const scope = await backend.openScope();
			try {
				const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
				const index = store.searchIndex!;
				const nulTexts = ["before\u0000after needle", "plain"];
				await store.create(
					header("nul"),
					nulTexts.map((text, seq) => message(`e${seq + 1}`, text)),
				);
				assert.equal(
					await index.extend(
						"nul",
						FORMAT,
						0,
						2,
						nulTexts.map((text, seq) => ({ seq: seq + 1, text })),
					),
					true,
				);
				assert.deepEqual(await index.candidates("nul", [["after needle"]], 1, 2, 10), [1]);
				assert.deepEqual(await index.candidates("nul", [["before"]], 1, 2, 10), [1]);
				assert.deepEqual(await index.candidates("nul", [["plain"]], 1, 2, 10), [2]);
			} finally {
				await scope.close();
			}
		});

		if (backend.name !== "libSQL server (sqld)")
			run("finds candidates across sequence windows of a long session (#5250)", async () => {
				const scope = await backend.openScope();
				try {
					const store = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
					const index = store.searchIndex!;
					const windowed = Array.from({ length: WINDOWED_ENTRIES }, (_, position) => {
						const seq = position + 1;
						return WINDOWED_NEEDLES.includes(seq) ? `windowed needle ${seq}` : `filler ${seq}`;
					});
					await store.create(
						header("windowed"),
						windowed.map((text, position) => message(`e${position + 1}`, text)),
					);
					for (let from = 0; from < WINDOWED_ENTRIES; from += WINDOWED_PAGE) {
						const through = Math.min(WINDOWED_ENTRIES, from + WINDOWED_PAGE);
						const page = windowed
							.slice(from, through)
							.map((text, position) => ({ seq: from + position + 1, text }));
						assert.equal(await index.extend("windowed", FORMAT, from, through, page), true);
					}
					assert.deepEqual(
						await index.candidates("windowed", [["windowed needle"]], 1, WINDOWED_ENTRIES, 10),
						WINDOWED_NEEDLES,
					);
					assert.deepEqual(await index.candidates("windowed", [["windowed needle"]], 2, WINDOWED_ENTRIES, 1), [
						WINDOWED_NEEDLES[1],
					]);
					assert.deepEqual(await index.candidates("windowed", [["absent needle"]], 1, WINDOWED_ENTRIES, 1), []);
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

describe("session search index on a PostgreSQL role that cannot install pg_trgm (#5250)", () => {
	const run = postgresSkipReason === undefined ? it : it.skip;
	run(
		"opens without a search index and scans within its budget, then indexes once pg_trgm is installed (#5250)",
		async () => {
			const role = `atomic_notrgm_${randomBytes(4).toString("hex")}`;
			const password = `pw-${randomUUID()}`;
			const scanTexts = Array.from({ length: SCAN_ENTRIES }, (_, position) =>
				position + 1 === SCAN_NEEDLE ? "scan needle" : `filler ${position + 1}`,
			);
			try {
				await withPostgresDatabase(async (scope) => {
					await scope.admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
					await scope.admin.exec(`GRANT CONNECT ON DATABASE ${scope.name} TO ${role}`);
					const superuserUrl = new URL(scope.url);
					superuserUrl.password = postgresTestPassword ?? "";
					const superuser = new pg.Client({ connectionString: superuserUrl.href });
					await superuser.connect();
					try {
						await superuser.query(`CREATE SCHEMA atomic AUTHORIZATION ${role}`);
						const roleUrl = new URL(scope.url);
						roleUrl.username = role;
						const openAsRole = () => scope.open({ url: roleUrl.href, password });
						const store = await SqlSessionStore.open(await openAsRole());
						assert.equal(
							store.searchIndex,
							undefined,
							"a store whose role cannot install pg_trgm exposes no search index",
						);
						assert.equal(
							(await superuser.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")).rowCount,
							0,
						);
						await store.create(
							header("scan"),
							scanTexts.map((text, position) => message(`e${position + 1}`, text)),
						);
						const router = createHistoryRouter({
							cwd: "/project",
							sessionStore: () => store,
							budget: { rows: SCAN_ROWS },
						});
						const found: string[] = [];
						let url: string | undefined = "history://sessions/scan";
						let calls = 0;
						for (; url !== undefined && calls < SCAN_ENTRIES; calls++) {
							const out: string =
								(await router.search?.(url, {
									pattern: "scan needle",
									ignoreCase: false,
									literal: false,
									contextBefore: 0,
									contextAfter: 0,
								})) ?? "";
							found.push(
								...out.split("\n").filter((line) => /^history:\/\/sessions\/scan:[1-9]\d*: /.test(line)),
							);
							url = /continue with (history:\/\/\S+?)\]?$/m.exec(out)?.[1];
						}
						assert.deepEqual(found, [`history://sessions/scan:${SCAN_NEEDLE}: scan needle`]);
						assert.ok(
							calls >= SCAN_ENTRIES / SCAN_ROWS,
							`the scan took ${calls} calls of at most ${SCAN_ROWS} rows`,
						);
						await superuser.query("CREATE EXTENSION pg_trgm");
						const reopened = await SqlSessionStore.open(await openAsRole());
						const index = reopened.searchIndex;
						assert.ok(index, "reopening after pg_trgm is installed adds the search index");
						const trigramIndex = await superuser.query(
							"SELECT indexdef FROM pg_indexes WHERE schemaname = 'atomic' AND indexname = 'session_search_trgm'",
						);
						assert.match(String(trigramIndex.rows[0]?.indexdef), /gin_trgm_ops/);
						assert.equal(
							await index.extend(
								"scan",
								FORMAT,
								0,
								SCAN_ENTRIES,
								scanTexts.map((text, position) => ({ seq: position + 1, text })),
							),
							true,
						);
						assert.deepEqual(await index.candidates("scan", [["scan needle"]], 1, SCAN_ENTRIES, 10), [
							SCAN_NEEDLE,
						]);
					} finally {
						await superuser.end();
					}
				});
			} finally {
				const admin = await openPostgresAdmin();
				try {
					await admin.exec(`DROP ROLE IF EXISTS ${role}`);
				} finally {
					await admin.close();
				}
			}
		},
	);
});
