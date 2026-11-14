import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { postgresDialect } from "../../packages/coding-agent/src/core/storage/dialect.js";
import {
	exportWorkflowRuns,
	importWorkflowRuns,
} from "../../packages/coding-agent/src/core/storage/journal-transfer.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SESSION_FORMAT_VERSION } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { run } from "../../packages/workflows/src/runs/foreground/sdk-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Sessions and workflow runs kept on PostgreSQL end to end (#4793): a workflow runs through a journal on the server,
 * fails, and resumes from a second connection, and a session keeps entries whose JSON Postgres's `jsonb` cannot hold.
 */

describe.skipIf(postgresSkipReason !== undefined)("sessions and workflow runs on PostgreSQL (#4793)", () => {
	test("a workflow runs through a journal on the server and resumes from another connection", async () => {
		await withPostgresDatabase(async (scope) => {
			const runId = "postgres-run";
			const effects: string[] = [];
			let failing = true;
			const definition = workflow({
				name: "postgres-run",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					// Its output carries a NUL and a lone surrogate, which the journal's payloads keep as JSON escapes.
					const once = await ctx.tool("once", {}, async () => {
						effects.push("once");
						return "saved \u0000 \ud800";
					});
					assert.equal(once, "saved \u0000 \ud800");
					await ctx.tool("flaky", {}, async () => {
						effects.push("flaky");
						if (failing) throw new Error("the first attempt fails");
						return "done";
					});
					return {};
				},
			});
			const runOn = async (database: SqliteDatabase) => {
				const backend = await JournalDurableBackend.open(await SqlRunJournal.open(database));
				try {
					return await run(
						definition,
						{},
						{ runId, cwd: "/project", store: createStore(), durableBackend: backend },
					);
				} finally {
					await backend.close();
				}
			};

			const first = await scope.open();
			assert.equal(first.dialect, postgresDialect);
			assert.equal((await runOn(first)).status, "failed");
			failing = false;
			const resumed = await runOn(await scope.open());

			assert.equal(resumed.status, "completed", JSON.stringify(resumed));
			assert.deepEqual(effects, ["once", "flaky", "flaky"]);
			const journal = await SqlRunJournal.open(await scope.open());
			try {
				assert.equal((await journal.getRun(runId))?.status, "completed");
				const events = [];
				for await (const entry of journal.read(runId)) events.push(entry);
				assert.deepEqual(
					events.map((entry) => entry.seq),
					events.map((_, index) => index + 1),
				);
				assert.ok(events.some((entry) => JSON.stringify(entry.event.payload).includes("saved \\u0000 \\ud800")));
			} finally {
				await journal.close();
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
	test("workflow runs export from and import into a database on the server", async () => {
		const directory = makeTempDirectory("postgres-run-transfer-");
		try {
			await withPostgresDatabase(async (scope) => {
				const journal = await SqlRunJournal.open(await scope.open(), { prefix: "source_" });
				try {
					await journal.createRun({
						runId: "moved",
						name: "transfer",
						cwd: "/project",
						createdAt: 1_000,
						status: "running",
					});
					const outcome = await journal.acquire("moved", "holder");
					assert.equal(outcome.status, "acquired");
					if (outcome.status !== "acquired") return;
					await journal.append(outcome.lease, {
						type: "CheckpointRecorded",
						payload: { kind: "tool", checkpointId: "step", output: "nul \u0000" },
					});
					await journal.append(outcome.lease, { type: "StatusChanged", payload: { status: "failed" } });
					await journal.release(outcome.lease);
				} finally {
					await journal.close();
				}
				const storage = (prefix: string) =>
					({ kind: "database", open: () => scope.open(), location: scope.url, prefix }) as const;
				const exported = join(directory, "first");
				assert.deepEqual((await exportWorkflowRuns(storage("source_"), exported)).written, ["moved"]);

				// Into a journal that exists already, as on a database this machine joined, but lacks the run.
				await (await SqlRunJournal.open(await scope.open(), { prefix: "copy_" })).close();
				assert.deepEqual(await importWorkflowRuns(storage("copy_"), exported), {
					added: ["moved"],
					updated: [],
					unchanged: [],
				});
				assert.deepEqual((await importWorkflowRuns(storage("copy_"), exported)).unchanged, ["moved"]);
				const again = join(directory, "again");
				await exportWorkflowRuns(storage("copy_"), again);
				const files = readdirSync(exported);
				assert.deepEqual(readdirSync(again), files);
				for (const file of files)
					assert.equal(readFileSync(join(again, file), "utf8"), readFileSync(join(exported, file), "utf8"));
				const copy = await SqlRunJournal.open(await scope.open(), { prefix: "copy_" });
				try {
					assert.equal((await copy.getRun("moved"))?.status, "failed");
					assert.equal((await copy.acquire("moved", "resumer")).status, "acquired");
				} finally {
					await copy.close();
				}
			});
		} finally {
			removeTempDirectory(directory);
		}
	});
});
