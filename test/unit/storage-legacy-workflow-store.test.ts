import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import type { StorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { SqlSnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.js";
import { collectSnapshotGarbage } from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.js";
import {
	dumpLegacyWorkflowTables,
	LEGACY_STORE,
	seedLegacyStore,
	seedLegacyWorkflowTables,
} from "../helpers/legacy-store-0990.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * A store an earlier release wrote, with its workflow runs, keeps working in a release without workflows: its sessions
 * list, resume, export and import, storage commands report it, and snapshot collection keeps the blobs its runs need.
 * Nothing changes the workflow tables, the journal store's files, worker pool state or run artifacts.
 */

const STORAGE_VARIABLES = [
	"ATOMIC_STORAGE",
	"ATOMIC_SESSIONS_STORAGE",
	"ATOMIC_WORKFLOWS_JOURNAL",
	"ATOMIC_CODING_AGENT_SESSION_DIR",
	"ATOMIC_WORKFLOW_JOURNAL_PATH",
	"ATOMIC_PROFILE",
];

let root: string;
let agentDir: string;
let project: string;
let sessionDatabase: string;
let workflowFiles: string[];

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function dumpSessionDatabase(): Promise<string> {
	const database = await openNodeSqliteDatabase(sessionDatabase, { readOnly: true });
	try {
		return await dumpLegacyWorkflowTables(database);
	} finally {
		await database.close();
	}
}

async function storage(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runStorageCommand(args, {
		cwd: project,
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

beforeEach(async () => {
	for (const name of STORAGE_VARIABLES) vi.stubEnv(name, "");
	root = makeTempDirectory("legacy-workflow-store-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(project, { recursive: true });
	const workflows = join(agentDir, "workflows");
	mkdirSync(join(workflows, "journal"), { recursive: true });
	mkdirSync(join(workflows, "pool"), { recursive: true });
	mkdirSync(join(workflows, "runs", LEGACY_STORE.runId), { recursive: true });
	// The session database of 0.9.90, which held its default run journal's tables too.
	sessionDatabase = join(workflows, "journal.sqlite");
	const database = await openNodeSqliteDatabase(sessionDatabase);
	await seedLegacyStore(database);
	await database.close();
	// The journal store, worker pool state and run artifacts of 0.9.90, which this release never opens.
	for (const name of ["catalog.sqlite", "shard-0001.sqlite"]) {
		const shard = await openNodeSqliteDatabase(join(workflows, "journal", name));
		await seedLegacyWorkflowTables(shard);
		await shard.close();
	}
	writeFileSync(join(workflows, "pool", "host-id"), "legacy-host\n");
	writeFileSync(join(workflows, "runs", LEGACY_STORE.runId, "notes.md"), "# legacy run\n");
	workflowFiles = [
		join(workflows, "journal", "catalog.sqlite"),
		join(workflows, "journal", "shard-0001.sqlite"),
		join(workflows, "pool", "host-id"),
		join(workflows, "runs", LEGACY_STORE.runId, "notes.md"),
	];
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

describe("a 0.9.90 store with workflow runs", () => {
	test("its sessions list, resume and take new entries, and its workflow tables and files stay as they were", async () => {
		const before = await dumpSessionDatabase();
		const files = workflowFiles.map(digest);

		const store: SessionStore = await resolveSessionStore(project, { agentDir });
		try {
			assert.deepEqual(store.descriptor, { adapter: "node-sqlite", location: sessionDatabase });
			const listed = [];
			for await (const summary of store.list({})) listed.push(summary.id);
			assert.deepEqual(listed, [LEGACY_STORE.sessionId]);
			const all = [];
			for await (const summary of store.list({ includeInternal: true })) all.push(summary.id);
			assert.deepEqual(all.sort(), [LEGACY_STORE.sessionId, LEGACY_STORE.stageSessionId].sort());
			const stage = await store.readHeader(LEGACY_STORE.stageSessionId);
			assert.deepEqual(stage?.workflow, { runId: LEGACY_STORE.runId, stageId: "stage-build", stageName: "build" });

			const loaded = await store.load(LEGACY_STORE.sessionId);
			assert.deepEqual(
				loaded.entries.map((entry) => entry.type),
				["message", "worktree_snapshot"],
			);
			await store.append(
				LEGACY_STORE.sessionId,
				[
					{
						type: "message",
						id: "m2",
						parentId: "w1",
						timestamp: "2026-11-20T09:00:00.000Z",
						message: { role: "user", content: "continued in this release", timestamp: 1_795_000_000_000 },
					},
				],
				{ expectSeq: loaded.lastSeq },
			);
			assert.equal((await store.load(LEGACY_STORE.sessionId)).entries.length, 3);
		} finally {
			await store.close();
		}

		const status = await storage(["status", "--json"]);
		assert.equal(status.code, 0, status.err);
		const parsed: StorageStatus = JSON.parse(status.out);
		assert.deepEqual(
			parsed.domains.map((domain) => domain.domain),
			["sessions", "intercom"],
		);
		assert.equal(parsed.domains[0]!.selection, `SQLite ${sessionDatabase}`);
		assert.equal(parsed.domains[0]!.probe?.connection.status, "ok");

		const exported = join(root, "exported");
		const exportResult = await storage(["export", exported]);
		assert.equal(exportResult.code, 0, exportResult.err);
		assert.deepEqual(readdirSync(exported), ["sessions"]);
		assert.deepEqual(readdirSync(join(exported, "sessions")).sort(), [
			`${LEGACY_STORE.sessionId}.jsonl`,
			`${LEGACY_STORE.stageSessionId}.jsonl`,
		]);
		const migrate = await storage(["migrate"]);
		assert.equal(migrate.code, 0, migrate.err);
		assert.match(migrate.out, /No shared storage is selected here/);

		assert.equal(await dumpSessionDatabase(), before);
		assert.deepEqual(workflowFiles.map(digest), files);
	});

	test("an export of an earlier release imports its sessions and leaves its workflow runs unread", async () => {
		const exported = join(root, "exported");
		assert.equal((await storage(["export", exported])).code, 0);
		// What an earlier release's export added beside the sessions, including a file this release could not read.
		mkdirSync(join(exported, "workflows"));
		writeFileSync(join(exported, "workflows", `${LEGACY_STORE.runId}.jsonl`), "not a workflow run export\n");
		const target = join(root, "target.sqlite");
		const imported = await storage(["import", exported, "--storage", JSON.stringify({ path: target })]);
		assert.equal(imported.code, 0, imported.err);
		assert.match(imported.out, /Imported 2 sessions .*\(2 added, 0 updated, 0 already up to date\)/);
		assert.doesNotMatch(imported.out, /workflow run/i);
		const database = await openNodeSqliteDatabase(target, { readOnly: true });
		try {
			const tables = await database.all(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wf\\_%' ESCAPE '\\'",
			);
			assert.deepEqual(tables, []);
		} finally {
			await database.close();
		}
	});

	test("snapshot collection keeps the blobs a paused run of the earlier release references, and only those", async () => {
		const before = await dumpSessionDatabase();
		const database = await openNodeSqliteDatabase(sessionDatabase);
		try {
			const blobs = await SqlSnapshotBlobStore.open(database);
			const unreferenced = new TextEncoder().encode("referenced by nothing\n");
			const hash = createHash("sha256").update(unreferenced).digest("hex");
			await blobs.putBlobs([{ hash, data: unreferenced }]);
			const { deleted } = await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
			assert.deepEqual(deleted, [hash]);
			for (const kept of [...LEGACY_STORE.runBlobs, LEGACY_STORE.sessionBlob])
				assert.ok(await blobs.getBlob(kept), `blob ${kept} was collected`);
		} finally {
			await database.close();
		}
		const after = await dumpSessionDatabase();
		// Collection may add the reference index's triggers on the run tables that the earlier release had not installed
		// yet, as that release does on its next open; no table, row, index or earlier trigger changes.
		const withoutIndexTriggers = (dump: string) =>
			dump
				.split("\n")
				.filter((line) => !/^trigger \S*_snapshot_/.test(line))
				.join("\n");
		assert.equal(withoutIndexTriggers(after), withoutIndexTriggers(before));
		for (const line of before.split("\n").filter((line) => line.startsWith("trigger ")))
			assert.ok(after.includes(line), `trigger dropped or changed: ${line.slice(0, 80)}`);
	});

	test("a snapshot blob over 1 MiB writes no workflow journal table, and leaves an earlier journal's version alone", async () => {
		const large = new Uint8Array(1024 * 1024 + 1).fill(7);
		const hash = createHash("sha256").update(large).digest("hex");
		// A database that never held a run journal.
		const fresh = await openNodeSqliteDatabase(join(root, "fresh.sqlite"));
		try {
			await (await SqlSnapshotBlobStore.open(fresh)).putBlobs([{ hash, data: large }]);
			assert.deepEqual(await fresh.all("SELECT name FROM sqlite_master WHERE name LIKE 'wf\\_%' ESCAPE '\\'"), []);
		} finally {
			await fresh.close();
		}
		// A journal at the schema version of builds before chunked payloads.
		const database = await openNodeSqliteDatabase(sessionDatabase);
		try {
			await database.exec("UPDATE wf_meta SET schema_version = 1");
			const before = await dumpLegacyWorkflowTables(database);
			await (await SqlSnapshotBlobStore.open(database)).putBlobs([{ hash, data: large }]);
			assert.deepEqual(await database.all("SELECT schema_version FROM wf_meta"), [{ schema_version: 1 }]);
			assert.equal(await dumpLegacyWorkflowTables(database), before);
		} finally {
			await database.close();
		}
	});

	test("the storage commands and options that went with workflows are refused, saying they were removed", async () => {
		for (const args of [
			["adopt", join(agentDir, "workflows", "journal.sqlite")],
			["consolidate"],
			["export", join(root, "out"), "--workflows"],
			["export", join(root, "out"), "--run", LEGACY_STORE.runId],
			["export", join(root, "out"), "--unfinished"],
			["import", join(root, "out"), "--workflows"],
		]) {
			const result = await storage(args);
			assert.equal(result.code, 1, args.join(" "));
			assert.match(result.err, /was removed in 0\.10\.0 with workflows/, args.join(" "));
		}
		const sessionsOnly = await storage(["export", join(root, "out"), "--sessions"]);
		assert.equal(sessionsOnly.code, 0, sessionsOnly.err);
		assert.match(sessionsOnly.out, /Exported 2 sessions/);
	});
});
