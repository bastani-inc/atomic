import assert from "node:assert/strict";

import pg from "pg";
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
	test("a chat record read sends one statement text however many anchors it reads (#6560)", async () => {
		await withPostgresDatabase(async ({ open }) => {
			const store = await SqlSessionStore.open(await open());
			const texts = new Set<string>();
			const query = pg.Client.prototype.query;
			try {
				const { epoch } = await store.create(
					{ id: "s", version: SESSION_FORMAT_VERSION, createdAt: "2026-11-26T00:00:00.000Z", cwd: "/p" },
					[],
				);
				assert.ok(epoch);
				const owner = { id: "s", epoch };
				const chat = store.chatRecords;
				assert.ok(chat);
				for (const anchor of ["a", "b", "c"])
					await chat.append(owner, anchor, { kind: "line", level: "error", text: anchor });
				pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
					const first = args[0] as string | { text?: string } | undefined;
					const text = typeof first === "string" ? first : first?.text;
					if (text?.includes("page_bytes")) texts.add(text);
					return Reflect.apply(query, this, args);
				} as pg.Client["query"];
				assert.equal((await chat.read(owner, ["a"])).length, 1);
				assert.equal((await chat.read(owner, ["a", "b", "c"])).length, 3);
				assert.equal(texts.size, 1, [...texts].join("\n---\n"));
			} finally {
				pg.Client.prototype.query = query;
				await store.close();
			}
		});
	});

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
