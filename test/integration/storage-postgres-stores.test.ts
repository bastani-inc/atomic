import assert from "node:assert/strict";

import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";

import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";

import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

/**
 * Sessions and workflow runs kept on PostgreSQL end to end (#4793): a workflow runs through a journal on the server,
 * fails, and resumes from a second connection, and a session keeps entries whose JSON Postgres's `jsonb` cannot hold.
 */

describe.skipIf(postgresSkipReason !== undefined)("sessions and workflow runs on PostgreSQL (#4793)", () => {
	test("a session keeps entries whose JSON carries NUL and lone surrogates, and indexes their snapshots", async () => {
		await withPostgresDatabase(async (scope) => {
			const timestamp = "2026-10-15T00:00:00.000Z";
			const entries: SessionEntry[] = [
				{
					type: "message",
					id: "first",
					parentId: null,
					timestamp,
					message: { role: "user", content: "nul \u0000 and lone \udfff", timestamp: Date.parse(timestamp) },
				},
				{
					type: "custom",
					id: "second",
					parentId: "first",
					timestamp,
					customType: "payload",
					data: { text: "\u0000", nested: [{ value: "\ud800" }] },
				},
			];
			const store = await SqlSessionStore.open(await scope.open());
			await store.create({ id: "session", version: SESSION_FORMAT_VERSION, createdAt: timestamp, cwd: "/project" }, [
				entries[0]!,
			]);
			await store.append("session", [entries[1]!], { expectSeq: 1 });

			const reopened = await SqlSessionStore.open(await scope.open());
			assert.deepEqual((await reopened.load("session")).entries, entries);
			// The reference index linked the second entry to its parent, as on SQLite.
			const database = await scope.open();
			assert.deepEqual(
				(await database.all("SELECT entry_id, parent_id, broken FROM snapshot_session_links ORDER BY seq")).map(
					(row) => ({ ...row, broken: Number(row.broken) }),
				),
				[
					{ entry_id: "first", parent_id: null, broken: 0 },
					{ entry_id: "second", parent_id: "first", broken: 0 },
				],
			);
		});
	});
});
