import assert from "node:assert/strict";
import pg from "pg";
import { test, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import type { SqliteRow, SqliteValue } from "../../packages/coding-agent/src/core/storage/database.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import {
	SESSION_ENTRY_CHUNK_BYTES,
	SESSION_RESUME_REBUILD,
	SESSION_TABLES,
	SqlSessionStore,
} from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { seedLegacyResumeSession } from "../helpers/legacy-resume-session.js";
import { postgresTestPassword, postgresUrlFor } from "../helpers/postgres-database.js";
import { refuseChunkProjection } from "../helpers/resume-projection-limit.js";
import { storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();
const timestamp = "2026-11-16T00:00:00.000Z";
const header = { id: "old-session", version: 4 as const, cwd: "/project", createdAt: timestamp };
const op = '🙂\\"op';
function transcript(padding: string): SessionEntry[] {
	return [
		{
			type: "custom",
			id: "receipt",
			parentId: null,
			timestamp,
			data: { padding, op },
			customType: "atomic-pooled-delivery-op",
		},
		{
			type: "message",
			id: "kept",
			parentId: "receipt",
			timestamp,
			message: { role: "user", timestamp: 1, content: "kept" },
		},
		{
			type: "compaction",
			id: "boundary",
			parentId: "kept",
			timestamp,
			summary: "compacted",
			firstKeptEntryId: "kept",
			tokensBefore: 1,
			details: { strategy: "verbatim-lines" },
		},
	];
}

for (const backend of storageBackends) {
	const run = backend.skipReason === undefined ? test : test.skip;
	run(`a malformed inline field does not reread fitting entries on ${backend.name} (#5590)`, async () => {
		const scope = await backend.openScope();
		try {
			const db = await scope.connect();
			const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
			const [large] = transcript("x".repeat(2 * SESSION_ENTRY_CHUNK_BYTES));
			await store.create(header, [
				large!,
				{
					type: "custom",
					customType: "extension",
					id: "malformed",
					parentId: "receipt",
					timestamp,
					data: { groups: "{not JSON" },
				},
			]);
			const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
			await db.run(`UPDATE ${tables.sessions} SET summary_state = '{}' WHERE id = ?`, header.id);
			let projections = 0;
			let chunkReads = 0;
			const all = db.all.bind(db);
			db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const rows = await all<T>(sql, ...args);
				if (rows.some((row) => "resume_type" in row)) projections++;
				return rows;
			};
			const get = db.get.bind(db);
			db.get = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const row = await get<T>(sql, ...args);
				if (row?.data instanceof Uint8Array) chunkReads++;
				return row;
			};
			await assert.rejects(() => store.findLatestCompaction(header.id), SyntaxError);
			assert.deepEqual({ projections, chunkReads }, { projections: 1, chunkReads: 0 });
		} finally {
			await scope.close();
		}
	});
	run(`an interrupted page scan restarts without publishing a prefix on ${backend.name} (#5590)`, async () => {
		const scope = await backend.openScope();
		try {
			const db = await scope.connect();
			const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
			const page = SESSION_RESUME_REBUILD.pageEntries;
			await store.create(
				header,
				Array.from({ length: page + 1 }, (_, i) => ({
					type: "custom",
					customType: "atomic-pooled-delivery-op",
					id: `e${i + 1}`,
					parentId: i ? `e${i}` : null,
					timestamp,
					data: { op: `op${i}` },
				})),
			);
			const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
			const summary = async () =>
				(await db.get<{ summary_state: string }>(`SELECT summary_state FROM ${table} WHERE id = ?`, header.id))!
					.summary_state;
			const { resume, ...base } = JSON.parse(await summary());
			const missing = JSON.stringify(base);
			await db.run(`UPDATE ${table} SET summary_state = ? WHERE id = ?`, missing, header.id);
			const realNow = performance.now.bind(performance);
			let elapsed = 0;
			const clock = vi.spyOn(performance, "now").mockImplementation(() => realNow() + elapsed);
			const all = db.all.bind(db);
			db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const rows = await all<T>(sql, ...args);
				if (rows[0] && "resume_type" in rows[0]) {
					if (elapsed) throw new Error("lost reader on page two");
					elapsed = 60_001;
				}
				return rows;
			};
			try {
				await assert.rejects(() => store.findLatestCompaction(header.id), /lost reader on page two/);
			} finally {
				clock.mockRestore();
				await store.close();
			}
			assert.equal(await summary(), missing);
			const next = await scope.connect();
			const reopened = await SqlSessionStore.open(next, { prefix: scope.prefix });
			const read = next.all.bind(next);
			const starts: number[] = [];
			next.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const rows = await read<T>(sql, ...args);
				if (rows[0] && "resume_type" in rows[0]) starts.push(Number(rows[0].seq));
				return rows;
			};
			assert.equal(await reopened.findLatestCompaction(header.id), undefined);
			assert.deepEqual(starts, [1, page + 1]);
			assert.equal(JSON.stringify(JSON.parse(await summary()).resume), JSON.stringify(resume));
			await reopened.close();
		} finally {
			await scope.close();
		}
	});
	run(`a native JSON error in an inline entry stays final on ${backend.name} (#5590)`, async () => {
		const scope = await backend.openScope();
		try {
			const db = await scope.connect();
			const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
			const [large, kept, boundary] = transcript("p".repeat(2 * SESSION_ENTRY_CHUNK_BYTES));
			const legacy = {
				type: "message",
				id: "legacy",
				parentId: large!.id,
				timestamp,
				message: { role: "assistant", timestamp: 0, content: ["legacy plain text"] },
			} as unknown as SessionEntry;
			await store.create(header, [large!, legacy, { ...kept!, parentId: "legacy" }, boundary!]);
			const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
			await db.run(`UPDATE ${tables.sessions} SET summary_state = '{}' WHERE id = ?`, header.id);
			let projections = 0;
			let chunkProbes = 0;
			const all = db.all.bind(db);
			db.all = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				if (sql.includes("resume_toolcalls")) projections++;
				return all<T>(sql, ...args);
			};
			const get = db.get.bind(db);
			db.get = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				if (sql.includes(tables.entryChunks)) chunkProbes++;
				return get<T>(sql, ...args);
			};
			await assert.rejects(() => store.findLatestCompaction(header.id), { name: "StorageUnavailableError" });
			assert.deepEqual({ projections, chunkProbes }, { projections: 1, chunkProbes: 0 });
		} finally {
			await scope.close();
		}
	});
	run(
		`counts encoded tool calls alongside legacy text in a fitting chunked message on ${backend.name} (#5590)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const [, kept, boundary] = transcript("");
				const encoded = backend.name === "Postgres" ? '{"type":"toolCall"}' : "/* legacy */ {type:'toolCall'}";
				const legacy = {
					type: "message",
					id: "receipt",
					parentId: null,
					timestamp,
					message: {
						role: "assistant",
						timestamp: 0,
						content: ["legacy plain text", encoded],
						errorMessage: "x".repeat(2 * SESSION_ENTRY_CHUNK_BYTES),
					},
				} as unknown as SessionEntry;
				await store.create(header, [legacy, kept!, boundary!]);
				const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
				await db.run(`UPDATE ${table} SET summary_state = '{}' WHERE id = ?`, header.id);
				assert.equal((await store.findLatestCompaction(header.id))?.entry.id, "boundary");
				const state = (await db.get<{ summary_state: string }>(
					`SELECT summary_state FROM ${table} WHERE id = ?`,
					header.id,
				))!;
				assert.equal(JSON.parse(state.summary_state).resume.totals.toolCalls, 1);
			} finally {
				await scope.close();
			}
		},
	);
	run(`a malformed field in a fitting chunked extension stays final on ${backend.name} (#5590)`, async () => {
		const scope = await backend.openScope();
		try {
			const db = await scope.connect();
			const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
			const entries = transcript("");
			const receipt = entries[0]!;
			assert.ok(receipt.type === "custom");
			receipt.customType = "third-party";
			receipt.data = { owner: "{bad", ignored: "x".repeat(SESSION_ENTRY_CHUNK_BYTES + 37) };
			await store.create(header, entries);
			const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
			await db.run(`UPDATE ${tables.sessions} SET summary_state = '{}' WHERE id = ?`, header.id);
			let projections = 0;
			let chunkReads = 0;
			const all = db.all.bind(db);
			db.all = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				if (sql.includes("resume_toolcalls")) projections++;
				return all<T>(sql, ...args);
			};
			const get = db.get.bind(db);
			db.get = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				if (sql.includes(tables.entryChunks)) chunkReads++;
				return get<T>(sql, ...args);
			};
			await assert.rejects(() => store.findLatestCompaction(header.id), SyntaxError);
			assert.deepEqual({ projections, chunkReads }, { projections: 1, chunkReads: 0 });
			assert.equal(
				(await db.get(`SELECT summary_state FROM ${tables.sessions} WHERE id = ?`, header.id))?.summary_state,
				"{}",
			);
		} finally {
			await scope.close();
		}
	});
	if (backend.name !== "Postgres") {
		run(`a wide inline-only session needs no additional rebuild reads on ${backend.name} (#5590)`, async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				// The database does contain chunks, but not for the session being rebuilt.
				await store.create(header, transcript("x".repeat(2 * SESSION_ENTRY_CHUNK_BYTES)));
				const id = "w".repeat(600);
				await seedLegacyResumeSession(
					db,
					store,
					{ ...header, id },
					2 * SESSION_RESUME_REBUILD.pageEntries + 1,
					scope.prefix,
				);
				const get = vi.spyOn(db, "get");
				const all = vi.spyOn(db, "all");
				assert.equal(await store.findLatestCompaction(id), undefined);
				// One header, three pages, and the final revision check; no layout or chunk round trip.
				assert.equal(get.mock.calls.length + all.mock.calls.length, 5);
			} finally {
				await scope.close();
			}
		});
		for (const shadowed of [false, true]) {
			run(
				`a wide session key preserves logical chunk order on ${backend.name}${shadowed ? " with a declared rowid" : ""} (#5590)`,
				async () => {
					const scope = await backend.openScope();
					try {
						const db = await scope.connect();
						const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
						// An application column can shadow SQLite's physical rowid; its values are not chunk addresses.
						if (shadowed)
							await db.exec(`CREATE TABLE ${tables.entryChunks} (
					session_id TEXT NOT NULL, seq INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL,
					rowid INTEGER DEFAULT 1, PRIMARY KEY(session_id,seq,idx)) STRICT`);
						const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
						const id = "w".repeat(4096);
						const entries = transcript("");
						await store.create({ ...header, id }, entries);
						const json = JSON.stringify(entries[0]);
						const at = json.indexOf("🙂");
						const pieces = [json.slice(0, at), "🙂", json.slice(at + 2)].map((s) => Buffer.from(s));
						await db.transaction(async (tx) => {
							await tx.run(
								`UPDATE ${tables.entries} SET chunks = 3, entry_json = ? WHERE session_id = ? AND seq = 1`,
								JSON.stringify({ type: "custom", id: "receipt", parentId: null }),
								id,
							);
							for (const idx of [0, 2, 1])
								await tx.run(
									`INSERT INTO ${tables.entryChunks} (session_id,seq,idx,data) VALUES (?,1,?,?)`,
									id,
									idx,
									pieces[idx]!,
								);
							await tx.run(`UPDATE ${tables.sessions} SET summary_state = '{}' WHERE id = ?`, id);
						});
						const get = db.get.bind(db);
						db.get = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
							const row = await get<T>(sql, ...args);
							assert.ok(!(row?.data instanceof Uint8Array), "fitting metadata stays in the database");
							return row;
						};
						assert.deepEqual((await store.readResume(id)).recovery.deliveryOpIds, [op]);
					} finally {
						await scope.close();
					}
				},
			);
		}
	}
	if (backend.name === "Postgres") {
		run("a resume lookup does not wait for chunk tables it does not read (#5590)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				await store.create(
					header,
					Array.from({ length: SESSION_RESUME_REBUILD.pageEntries + 1 }, (_, i) => ({
						type: "custom",
						customType: "extension",
						id: `e${i}`,
						parentId: i ? `e${i - 1}` : null,
						timestamp,
						data: {},
					})),
				);
				const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
				await db.run(`UPDATE ${tables.sessions} SET summary_state = '{}' WHERE id = ?`, header.id);
				const { schema, name } = (await db.get<{ schema: string; name: string }>(
					"SELECT current_schema() AS schema, current_database() AS name",
				))!;
				const address = new URL(postgresUrlFor(name));
				address.password = postgresTestPassword ?? "";
				const locker = new pg.Client({ connectionString: address.href, connectionTimeoutMillis: 5_000 });
				try {
					await locker.connect();
					await locker.query("BEGIN");
					await locker.query(`LOCK TABLE ${schema}.${tables.blobChunks} IN ACCESS EXCLUSIVE MODE`);
					db.all = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) =>
						db.transaction(async (tx) => {
							await tx.exec("SET LOCAL lock_timeout = '250ms'");
							return tx.all<T>(sql, ...args);
						});
					db.get = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) =>
						db.transaction(async (tx) => {
							await tx.exec("SET LOCAL lock_timeout = '250ms'");
							return tx.get<T>(sql, ...args);
						});
					assert.equal(
						await store.findLatestCompaction(header.id),
						undefined,
						"cold lookup needs entries, not blobs",
					);
					await locker.query(`LOCK TABLE ${schema}.${tables.entryChunks} IN ACCESS EXCLUSIVE MODE`);
					assert.equal(
						await store.findLatestCompaction(header.id),
						undefined,
						"warm lookup needs neither chunk table",
					);
				} finally {
					await locker.end();
				}
			} finally {
				await scope.close();
			}
		});
		run("projecting retired inline errors does not spool their decoded bodies (#5590)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const entries: SessionEntry[] = Array.from({ length: 24 }, (_, i) => ({
					type: "message",
					id: `error${i}`,
					parentId: i ? `error${i - 1}` : null,
					timestamp,
					message: {
						role: "assistant",
						api: "openai-completions",
						provider: "p",
						model: "m",
						content: [],
						errorMessage: "x".repeat(320 * 1024),
						stopReason: "error",
						timestamp: i,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				}));
				await store.create(header, entries);
				const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
				await db.run(`UPDATE ${tables.sessions} SET summary_state = '{}' WHERE id = ?`, header.id);
				const all = db.all.bind(db);
				let tempBlocks: number | undefined;
				db.all = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
					if (sql.includes("resume_toolcalls"))
						await db.transaction(async (tx) => {
							await tx.exec("SET LOCAL work_mem = '4MB'");
							const plan = await tx.get<{ "QUERY PLAN": string }>(
								`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
								...args,
							);
							tempBlocks = JSON.parse(plan!["QUERY PLAN"])[0].Plan["Temp Written Blocks"];
						});
					return all<T>(sql, ...args);
				};
				assert.equal(await store.findLatestCompaction(header.id), undefined);
				assert.equal(tempBlocks, 0);
			} finally {
				await scope.close();
			}
		});
	}
	if (backend.name === "libSQL server (sqld)") {
		run("a refused inline response is final after one projection and one page-key check (#5590)", async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const entries: SessionEntry[] = Array.from({ length: 250 }, (_, i) => ({
					type: "message",
					id: `tool${i}`,
					parentId: i ? `tool${i - 1}` : null,
					timestamp,
					message: {
						role: "toolResult",
						toolName: "scan",
						toolCallId: "t".repeat(49_152),
						content: [],
						isError: false,
						timestamp: i,
					},
				}));
				const fitting = "fitting";
				await store.create({ ...header, id: fitting }, entries.slice(0, 1));
				await store.create(header, entries);
				const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
				await db.run(`UPDATE ${tables.sessions} SET summary_state = '{}'`);
				let projections = 0;
				let probes = 0;
				const all = db.all.bind(db);
				db.all = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
					if (sql.includes("resume_toolcalls")) projections++;
					return all<T>(sql, ...args);
				};
				const get = db.get.bind(db);
				db.get = <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
					if (sql.includes(tables.entryChunks)) probes++;
					return get<T>(sql, ...args);
				};
				assert.equal(await store.findLatestCompaction(fitting), undefined);
				assert.deepEqual({ projections, probes }, { projections: 1, probes: 0 });
				projections = 0;
				await assert.rejects(() => store.findLatestCompaction(header.id), {
					name: "StoragePayloadTooLargeError",
					kind: "response",
				});
				assert.deepEqual({ projections, probes }, { projections: 1, probes: 1 });
			} finally {
				await scope.close();
			}
		});
		run(
			"a 17,500-entry resume rebuild writes only the completed index while another session appends (#5590)",
			async () => {
				const scope = await backend.openScope();
				try {
					const db = await scope.connect();
					const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
					const page = SESSION_RESUME_REBUILD.pageEntries;
					const count = 17_500;
					const message = (i: number, parentId: string | null, content: string): SessionEntry => ({
						type: "message",
						id: `e${i}`,
						parentId,
						timestamp,
						message: { role: "user", timestamp: i, content },
					});
					// The jump also exercises the active-branch refold. Neither pass should save a prefix.
					await seedLegacyResumeSession(db, store, header, count, scope.prefix, page);
					const otherId = "other-session";
					await store.create({ ...header, id: otherId }, []);
					const table = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix).sessions;
					const conn = await scope.connect();
					const reader = await SqlSessionStore.open(conn, { prefix: scope.prefix });
					const execute = conn.run.bind(conn);
					let readerWrites = 0;
					conn.run = (sql, ...args) => {
						readerWrites++;
						return execute(sql, ...args);
					};
					// Count lock acquisitions, not milliseconds waiting for an unrelated writer or a CI worker.
					const competingBody = "n".repeat(SESSION_ENTRY_CHUNK_BYTES + SESSION_ENTRY_CHUNK_BYTES / 2);
					const competingAppends = 6;
					const results = await Promise.allSettled([
						reader.findLatestCompaction(header.id),
						(async () => {
							for (let i = 0; i < competingAppends; i++)
								await store.append(otherId, [message(i, i ? `e${i - 1}` : null, competingBody)], {
									expectSeq: i,
								});
						})(),
					]);
					for (const result of results) if (result.status === "rejected") throw result.reason;
					const finalPublications = 1;
					assert.equal(readerWrites, finalPublications, "only the completed index needs the server's write lock");
					const row = await db.get<{ summary_state: string }>(
						`SELECT summary_state FROM ${table} WHERE id = ?`,
						header.id,
					);
					assert.equal(JSON.parse(row!.summary_state).resume.seq, count);
				} finally {
					await scope.close();
				}
			},
			120_000,
		);
	}
	run(
		`builds byte-identical indexes from chunked and inline protocol metadata on ${backend.name} (#5590)`,
		async () => {
			const scope = await backend.openScope();
			try {
				const db = await scope.connect();
				const store = await SqlSessionStore.open(db, { prefix: scope.prefix });
				const protocols: [string, object][] = [
					["intercom_session_identity", { sessionId: "s", intercomSessionId: "i" }],
					["intercom_session_memberships", { groups: ["λ", "日"], sessionId: "s", homeGroup: "home" }],
					[
						"subagent-child",
						{
							z: 1,
							longField: false,
							[backend.name === "SQLite file" ? "field\ud800" : "field日"]: null,
							childId: "child",
							version: 1,
							state: "running",
							runId: "r",
							agent: "a",
							cwd: "/p",
							index: 0,
							owner: { sessionId: "s" },
						},
					],
					["workflow-stage-parked-tasks", { tasks: [{ ownerId: "s", taskId: "t" }] }],
					["intercom_inbox", { message: { id: "msg", replyTo: "asked", expectsReply: true } }],
					["task-completion-intent", { completionId: "intent", ownerId: "s", taskId: "t" }],
					["task-completion-ack", { completionId: "intent" }],
					["web-search-results", { id: "search", timestamp: 2, type: "fetch", urls: ["url"] }],
					["workflow.run.start", { runId: 1e-8 }],
				];
				const entries: SessionEntry[] = protocols.map(([customType, data], i) => ({
					type: "custom",
					timestamp,
					data,
					customType,
					id: `c${i}`,
					parentId: i ? `c${i - 1}` : null,
				}));
				entries.push({
					type: "custom_message",
					timestamp,
					id: "msg",
					parentId: entries.at(-1)!.id,
					customType: "intercom_message",
					content: "✈",
					display: true,
					stageAdmissionKey: "s",
					details: { message: { id: "msg", expectsReply: true }, historyOnly: true },
				});
				entries.push({
					type: "message",
					timestamp,
					id: "assistant",
					parentId: "msg",
					message: {
						role: "assistant",
						// The server cannot return an inline projection with invalid UTF-8; compare only inputs it can project.
						provider: backend.name === "libSQL server (sqld)" ? "p🙂" : "p\ud800",
						model: "m",
						api: "openai-completions",
						stopReason: "toolUse",
						timestamp: 0,
						content: [
							{ type: "toolCall", id: "call", name: "edit", arguments: { type: "toolCall" } },
							{ type: "text", text: '\\\\"日' },
						],
						usage: {
							output: 4,
							input: 3,
							totalTokens: 7,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { total: 0.25, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					},
				});
				await store.create(header, entries);
				const tables = renderStorageIdentifiers("sessions", SESSION_TABLES, scope.prefix);
				const stored = entries.map((entry) => JSON.stringify(entry));
				// The SQL array iterator also accepts a content block encoded as JSON text.
				const assistant = JSON.parse(stored.at(-1)!);
				assistant.message.content.push(JSON.stringify({ type: "toolCall", arguments: { escaped: '"' } }));
				stored[stored.length - 1] = JSON.stringify(assistant);
				await db.run(
					`UPDATE ${tables.entries} SET entry_json = ? WHERE session_id = ? AND seq = ?`,
					stored.at(-1)!,
					header.id,
					stored.length,
				);
				const state = async () =>
					JSON.parse(
						(await db.get<{ summary_state: string }>(
							`SELECT summary_state FROM ${tables.sessions} WHERE id = ?`,
							header.id,
						))!.summary_state,
					);
				const { resume: _ignored, ...summary } = await state();
				const rebuild = async (refused = false) => {
					await db.run(
						`UPDATE ${tables.sessions} SET summary_state = ? WHERE id = ?`,
						JSON.stringify(summary),
						header.id,
					);
					const connection = await scope.connect();
					const reader = await SqlSessionStore.open(connection, { prefix: scope.prefix });
					if (refused) refuseChunkProjection(connection, entries[0]!.id);
					try {
						await reader.readResume(header.id);
						return JSON.stringify((await state()).resume);
					} finally {
						await reader.close();
					}
				};
				const inline = await rebuild();
				// Change only the physical representation. The old SQL projection still serves as an independent oracle.
				await db.transaction(async (tx) => {
					for (const [i, entry] of entries.entries()) {
						const bytes = Buffer.from(stored[i]!);
						const part = 53;
						await tx.run(
							`UPDATE ${tables.entries} SET entry_json = ?, chunks = ? WHERE session_id = ? AND seq = ?`,
							JSON.stringify({ type: entry.type, id: entry.id, parentId: entry.parentId }),
							Math.ceil(bytes.length / part),
							header.id,
							i + 1,
						);
						for (let offset = 0; offset < bytes.length; offset += part)
							await tx.run(
								`INSERT INTO ${tables.entryChunks} (session_id, seq, idx, data) VALUES (?, ?, ?, ?)`,
								header.id,
								i + 1,
								offset / part,
								bytes.subarray(offset, offset + part),
							);
					}
				});
				assert.equal(await rebuild(), inline);
				assert.equal(await rebuild(true), inline);
			} finally {
				await scope.close();
			}
		},
	);
	run(`does not send chunked metadata back as a single SQL value on ${backend.name} (#5590)`, async () => {
		const scope = await backend.openScope();
		try {
			const database = await scope.connect();
			const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
			const entries = transcript("");
			const operation = "r".repeat(SESSION_ENTRY_CHUNK_BYTES + 19);
			const receipt = entries[0]!;
			assert.ok(receipt.type === "custom");
			// This extension field is text, not the JSON-encoded groups of a membership record.
			receipt.data = { op: operation, groups: "{not a membership record" };
			await store.create(header, entries);
			const table = renderStorageIdentifiers("sessions", { sessions: "sessions" }, scope.prefix).sessions;
			await database.run(
				`UPDATE ${table} SET summary_state = ? WHERE id = ?`,
				JSON.stringify({ resume: { version: 1 } }),
				header.id,
			);
			const get = database.get.bind(database);
			database.get = <T extends SqliteRow>(sql: string, ...params: SqliteValue[]) => {
				assert.ok(
					params.every(
						(param) => typeof param !== "string" || Buffer.byteLength(param) <= SESSION_ENTRY_CHUNK_BYTES,
					),
					"oversized projection input",
				);
				return get<T>(sql, ...params);
			};
			const rebuilt = await store.readResume(header.id);
			assert.deepEqual(rebuilt.recovery.deliveryOpIds, [operation]);
		} finally {
			await scope.close();
		}
	});
	run(`rebuilds the missing resume index of a multi-page entry on ${backend.name} (#5590)`, async () => {
		const scope = await backend.openScope();
		try {
			const database = await scope.connect();
			const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
			// The first byte of a retained four-byte character ends the sixth chunk.
			const prefix = JSON.stringify(transcript("")[0]).split("🙂")[0]!;
			await store.create(
				header,
				transcript("x".repeat(6 * SESSION_ENTRY_CHUNK_BYTES - 1 - Buffer.byteLength(prefix))),
			);
			const table = renderStorageIdentifiers("sessions", { sessions: "sessions" }, scope.prefix).sessions;
			const row = await database.get<{ summary_state: string }>(
				`SELECT summary_state FROM ${table} WHERE id = ?`,
				header.id,
			);
			const { resume, ...summary } = JSON.parse(row!.summary_state);
			await database.run(`UPDATE ${table} SET summary_state = ? WHERE id = ?`, JSON.stringify(summary), header.id);
			const lost = await scope.connect();
			const interrupted = await SqlSessionStore.open(lost, { prefix: scope.prefix });
			// sqld enforces its own 5 MB cap; exercise an interrupted bounded read on the other engines too.
			if (backend.name !== "libSQL server (sqld)") refuseChunkProjection(lost, "receipt");
			const get = lost.get.bind(lost);
			let chunks = 0;
			lost.get = async <T extends SqliteRow>(sql: string, ...args: SqliteValue[]) => {
				const row = await get<T>(sql, ...args);
				if (row?.data instanceof Uint8Array && ++chunks === 2) throw new Error("lost chunk reader");
				return row;
			};
			await assert.rejects(() => interrupted.readResume(header.id), /lost chunk reader/);
			await interrupted.close();
			const reader = await SqlSessionStore.open(await scope.connect(), { prefix: scope.prefix });
			const actual = await reader.readResume(header.id);
			assert.deepEqual(
				actual.branch.map(({ entry }) => entry.id),
				["kept", "boundary"],
			);
			assert.deepEqual(actual.recovery.deliveryOpIds, [op]);
			const rebuilt = await database.get<{ summary_state: string }>(
				`SELECT summary_state FROM ${table} WHERE id = ?`,
				header.id,
			);
			assert.equal(JSON.stringify(JSON.parse(rebuilt!.summary_state).resume), JSON.stringify(resume));
		} finally {
			await scope.close();
		}
	});
}
