import assert from "node:assert/strict";
import { test } from "vitest";
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
	if (backend.name === "libSQL server (sqld)") {
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
					let readerWrites = 0;
					const countWrites =
						(execute: typeof conn.run): typeof conn.run =>
						(sql, ...args) => {
							readerWrites++;
							return execute(sql, ...args);
						};
					conn.run = countWrites(conn.run.bind(conn));
					// Publication can be a standalone statement or run in the store's format-fenced transaction.
					const transaction = conn.transaction.bind(conn);
					conn.transaction = (body, options) =>
						transaction(
							(tx) =>
								body({
									exec: tx.exec.bind(tx),
									get: tx.get.bind(tx),
									all: tx.all.bind(tx),
									run: countWrites(tx.run.bind(tx)),
								}),
							options,
						);
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
					["workflow.run.start", { runId: "bad-name", name: { name: "not a string" }, ts: 1 }],
					["workflow.run.start", { runId: "bad-ts", name: "work", ts: "1" }],
					["workflow.run.start", { runId: "waiting", name: "work", ts: 1 }],
				];
				const entries: SessionEntry[] = protocols.map(([customType, data], i) => ({
					type: "custom",
					timestamp,
					data,
					customType,
					id: `c${i}`,
					parentId: i ? `c${i - 1}` : null,
				}));
				const root = "/checkout";
				const snapshot = {
					version: 1 as const,
					id: "snapshot",
					root,
					remotes: [],
					branch: null,
					head: "head",
					snapshot: "commit",
					tree: "tree",
					envHash: "env",
					delta: { base: "head", patch: null, bytes: 0 },
					chain: [],
					bundle: null,
					omitted: [],
					filters: null,
					capturedAt: timestamp,
				};
				entries.push({
					type: "worktree_snapshot",
					timestamp,
					id: "snapshot-record",
					parentId: entries.at(-1)!.id,
					root,
					snapshotId: snapshot.id,
					captureMs: 42,
					snapshot,
				});
				entries.push({
					type: "worktree_snapshot",
					timestamp,
					id: "snapshot-restore",
					parentId: "snapshot-record",
					root,
					snapshotId: snapshot.id,
					restore: { from: root, to: "/restored", snapshotId: snapshot.id, tree: "tree", restoredAt: timestamp },
				});
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
				assert.deepEqual(
					Object.values(JSON.parse(inline).workflowStarts),
					[protocols.length],
					"only a valid workflow start may reopen a run",
				);
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
