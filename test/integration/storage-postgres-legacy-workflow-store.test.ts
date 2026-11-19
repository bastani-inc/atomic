import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import { POSTGRES_MOVED_SCHEMA_VERSION } from "../../packages/coding-agent/src/core/storage/postgres-schema.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { SqlSnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.js";
import { dumpLegacyWorkflowTables, LEGACY_STORE, seedLegacyStore } from "../helpers/legacy-store-0990.js";
import { postgresSkipReason, postgresTestPassword, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";
import { storageBackends } from "../helpers/storage-backends.js";

/**
 * A database Atomic 0.9.90 shared, workflow tables included, on the server backends: this release opens its sessions,
 * collects its snapshot blobs and migrates it without changing a workflow table, a row or a trigger on one, and on
 * PostgreSQL still moves those tables out of `public` with the rest and fences them there.
 */

const postgresPackage = resolve(moduleDir(import.meta.url), "../../packages/storage-postgres");
const libsql = storageBackends.find((backend) => backend.name === "libSQL server (sqld)")!;
const postgresIt = postgresSkipReason === undefined && postgresTestPassword !== undefined ? it : it.skip;
const libsqlIt = libsql.skipReason === undefined ? it : it.skip;
const TIMEOUT_MS = 120_000;

/** Lists the sessions, resumes the earlier one with a new entry, and collects snapshot blobs, as a session start does. */
async function useStore(database: SqliteDatabase, prefix: string): Promise<void> {
	const sessions = await SqlSessionStore.open(database, { prefix });
	try {
		const listed: string[] = [];
		for await (const summary of sessions.list({ includeInternal: true })) listed.push(summary.id);
		assert.deepEqual(listed.sort(), [LEGACY_STORE.sessionId, LEGACY_STORE.stageSessionId].sort());
		const loaded = await sessions.load(LEGACY_STORE.sessionId);
		await sessions.append(
			LEGACY_STORE.sessionId,
			[
				{
					type: "message",
					id: "m2",
					parentId: "w1",
					timestamp: "2026-11-20T09:00:00.000Z",
					message: { role: "user", content: "continued", timestamp: 1_795_000_000_000 },
				},
			],
			{ expectSeq: loaded.lastSeq },
		);
	} finally {
		await sessions.close();
	}
	const blobs = await SqlSnapshotBlobStore.open(database, prefix);
	const unreferenced = new TextEncoder().encode("referenced by nothing\n");
	const hash = createHash("sha256").update(unreferenced).digest("hex");
	await blobs.putBlobs([{ hash, data: unreferenced }]);
	assert.deepEqual((await collectSnapshotGarbage(blobs, { graceSeconds: 0 })).deleted, [hash]);
	for (const kept of [...LEGACY_STORE.runBlobs, LEGACY_STORE.sessionBlob])
		assert.ok(await blobs.getBlob(kept), `blob ${kept} was collected`);
}

/** `atomic storage migrate --db <url> --password-file <file> [--prefix <prefix>]`, as the database's owner. */
async function migrate(url: string, prefix: string | undefined) {
	const root = makeTempDirectory("legacy-workflow-migrate-");
	try {
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [postgresPackage] }));
		const passwordFile = join(root, "password");
		writeFileSync(passwordFile, postgresTestPassword ?? "", { mode: 0o600 });
		const out: string[] = [];
		const err: string[] = [];
		const code = await runStorageCommand(
			[
				"migrate",
				"--db",
				url,
				"--password-file",
				passwordFile,
				...(prefix === undefined ? [] : ["--prefix", prefix]),
			],
			{
				cwd: root,
				agentDir,
				log: (line) => out.push(line),
				error: (line) => err.push(line),
				loadBrokerState: () => import("../../packages/intercom/broker/open-broker-state.js"),
			},
		);
		return { code, out: out.join("\n"), err: err.join("\n") };
	} finally {
		removeTempDirectory(root);
	}
}

describe("a database 0.9.90 shared, with its workflow tables", () => {
	postgresIt(
		"on PostgreSQL, sessions, snapshot collection and storage migrate leave every workflow table as it was",
		async () => {
			await withPostgresDatabase(async (scope) => {
				const prefix = "team_";
				const database = await scope.open();
				await seedLegacyStore(database, { prefix });
				const before = await dumpLegacyWorkflowTables(database, { prefix });
				await useStore(database, prefix);
				const migrated = await migrate(scope.url, prefix);
				assert.equal(migrated.code, 0, migrated.err);
				assert.match(migrated.out, /set up for this version: sessions and Intercom/);
				assert.equal(await dumpLegacyWorkflowTables(database, { prefix }), before);
			});
		},
		TIMEOUT_MS,
	);

	postgresIt(
		"on PostgreSQL, storage migrate moves an earlier release's workflow tables out of public with the rest, and fences them",
		async () => {
			await withPostgresDatabase(async (scope) => {
				// An earlier release's layout: every table in public.
				const earlier = await scope.open({ schema: "public" });
				await seedLegacyStore(earlier);
				const before = await dumpLegacyWorkflowTables(earlier);
				const migrated = await migrate(scope.url, undefined);
				assert.equal(migrated.code, 0, migrated.err);
				assert.match(migrated.out, /from schema public to schema atomic/);
				const moved = await scope.open();
				assert.equal((await moved.get<{ schema: string }>("SELECT current_schema() AS schema"))?.schema, "atomic");
				assert.equal(await dumpLegacyWorkflowTables(moved), before);
				// The version tables of the workflow stores stay in public at a version no earlier release opens.
				for (const fence of ["wf_meta", "wf_runs_pool_meta", "wf_ps_session_meta"]) {
					const column = fence === "wf_runs_pool_meta" ? "version" : "schema_version";
					const fenced = await moved.all<Record<string, unknown>>(
						`SELECT ${column} AS version FROM public.${fence}`,
					);
					assert.deepEqual(
						fenced.map((entry) => Number(entry.version)),
						[POSTGRES_MOVED_SCHEMA_VERSION],
						fence,
					);
				}
			});
		},
		TIMEOUT_MS,
	);

	libsqlIt(
		"on a libSQL server, sessions and snapshot collection leave every workflow table as it was",
		async () => {
			const scope = await libsql.openScope();
			try {
				const database = await scope.connect();
				await seedLegacyStore(database, { prefix: scope.prefix });
				const before = await dumpLegacyWorkflowTables(database, { prefix: scope.prefix });
				await useStore(database, scope.prefix);
				assert.equal(await dumpLegacyWorkflowTables(database, { prefix: scope.prefix }), before);
			} finally {
				await scope.close();
			}
		},
		TIMEOUT_MS,
	);
});
