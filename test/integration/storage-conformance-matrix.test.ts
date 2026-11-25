import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import { renderStorageIdentifiers } from "../../packages/coding-agent/src/core/storage/prefix.js";
import { registerSessionStoreConformance } from "../../packages/coding-agent/src/core/storage/session/conformance.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { registerSqliteDatabaseConformance } from "../../packages/coding-agent/src/core/storage/testing.js";
import { databaseSubject, storageBackends } from "../helpers/storage-backends.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import { backendLabel, runnerFor, withSqlSessionStore } from "./storage-conformance-matrix-helpers.js";

/**
 * Every store's behavioural contract on every storage backend (#4793): the database facade and same-handle sessions
 * on a SQLite file, a libSQL server and Postgres. Reopen sessions and Intercom's multi-node routing state run in
 * sibling `storage-conformance-matrix-*.test.ts` files.
 */

useTemporaryAgentDir();

for (const backend of storageBackends) {
	const name = backendLabel(backend);
	const run = backend.skipReason === undefined ? test : test.skip;
	registerSqliteDatabaseConformance(runnerFor(backend), `database facade on ${name}`, databaseSubject(backend));

	registerSessionStoreConformance(
		runnerFor(backend, { includeSuite: (suite) => !suite.endsWith(" (reopen)") }),
		`SqlSessionStore on ${name}`,
		withSqlSessionStore(backend),
	);

	run(`projects an older session's resume state on ${name} without decoding its transcript (#5249)`, async () => {
		const scope = await backend.openScope();
		try {
			const database = await scope.connect();
			const store = await SqlSessionStore.open(database, { prefix: scope.prefix });
			const header = {
				id: "projected",
				version: 4 as const,
				createdAt: "2026-11-16T00:00:00.000Z",
				cwd: "/project",
			};
			const entries: SessionEntry[] = [
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp: header.createdAt,
					provider: "{provider}",
					modelId: "[model]",
				},
				{
					type: "thinking_level_change",
					id: "thinking",
					parentId: "model",
					timestamp: header.createdAt,
					thinkingLevel: "high",
				},
				{
					type: "custom",
					customType: "intercom_session_identity",
					id: "identity",
					parentId: "thinking",
					timestamp: header.createdAt,
					data: { sessionId: header.id },
				},
				{
					type: "custom",
					customType: "atomic-pooled-delivery-op",
					id: "receipt",
					parentId: "identity",
					timestamp: header.createdAt,
					data: { op: "delivered-op" },
				},
				{
					type: "custom_message",
					id: "ask",
					parentId: "receipt",
					timestamp: header.createdAt,
					customType: "intercom_message",
					content: "old body".repeat(500),
					display: true,
					details: { message: { id: "ask-id", expectsReply: true } },
				},
				{
					type: "message",
					id: "kept",
					parentId: "ask",
					timestamp: header.createdAt,
					message: { role: "user", content: "kept", timestamp: 1 },
				},
				{
					type: "compaction",
					id: "boundary",
					parentId: "kept",
					timestamp: header.createdAt,
					summary: "summary",
					tokensBefore: 100,
					firstKeptEntryId: "kept",
					details: { strategy: "verbatim-lines" },
				},
			];
			await store.create(header, entries);
			const expected = await store.readResume(header.id);
			const table = renderStorageIdentifiers("sessions", { sessions: "sessions" }, scope.prefix).sessions;
			const row = await database.get<{ summary_state: string }>(
				`SELECT summary_state FROM ${table} WHERE id = ?`,
				header.id,
			);
			const { resume: _resume, ...summary } = JSON.parse(row!.summary_state) as Record<string, unknown>;
			await database.run(`UPDATE ${table} SET summary_state = ? WHERE id = ?`, JSON.stringify(summary), header.id);
			assert.deepEqual(expected.recovery.deliveryOpIds, ["delivered-op"]);
			assert.deepEqual(await store.readResume(header.id), expected);
			await store.close();
		} finally {
			await scope.close();
		}
	});
}
