import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import { createPostgresDatabase, postgresSkipReason, postgresStorageSelection } from "../helpers/postgres-database.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Moving sessions off libSQL (#6624): what `atomic storage export` of 0.10.11-alpha.2 wrote from a libSQL store, forks
 * and worktree snapshots included (test/fixtures/libsql-export-0.10.11-alpha.2), imports with this release into local
 * SQLite and into PostgreSQL, and exports from there again byte for byte.
 */

const exported = join(moduleDir(import.meta.url), "../fixtures/libsql-export-0.10.11-alpha.2");
/** Each import and export loads the stores and, for PostgreSQL, the adapter through jiti. */
const TRANSFER_TIMEOUT_MS = 120_000;

let root: string;
let agentDir: string;
let project: string;

beforeEach(() => {
	for (const name of ["ATOMIC_STORAGE", "ATOMIC_SESSIONS_STORAGE", "ATOMIC_CODING_AGENT_SESSION_DIR"])
		vi.stubEnv(name, "");
	root = makeTempDirectory("libsql-export-import-");
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

async function storage(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runStorageCommand(args, {
		cwd: project,
		agentDir,
		log: (line) => out.push(line),
		error: (line) => err.push(line),
		loadControl: async () => {
			throw new Error("no broker in this test");
		},
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

function files(directory: string): Record<string, string> {
	const sessions = join(directory, "sessions");
	return Object.fromEntries(
		readdirSync(sessions)
			.sort()
			.map((name) => [name, readFileSync(join(sessions, name), "utf8")]),
	);
}

/** Imports the libSQL export into `target` (none: the local default store), twice, and exports it again. */
async function roundTrip(target: string[]): Promise<void> {
	const first = await storage(["import", exported, ...target]);
	assert.equal(first.code, 0, first.err);
	assert.match(first.out, /^Imported 4 sessions .*\(4 added, 0 updated, 0 already up to date\)\.$/);
	const again = await storage(["import", exported, ...target]);
	assert.equal(again.code, 0, again.err);
	assert.match(again.out, /\(0 added, 0 updated, 4 already up to date\)\.$/);
	const out = join(root, "reexported");
	const back = await storage(["export", out, ...target]);
	assert.equal(back.code, 0, back.err);
	assert.deepEqual(files(out), files(exported), "every session, fork and snapshot reads back byte for byte");
}

test("the libSQL export holds forks with their whole history and a worktree snapshot with its content", () => {
	const sessions = Object.values(files(exported)).map((text) =>
		text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line)),
	);
	assert.equal(sessions.length, 4);
	const forks = sessions.filter(([header]) => typeof header.parentSessionId === "string");
	assert.equal(forks.length, 2);
	for (const [header, ...entries] of forks) {
		assert.ok(sessions.some(([parent]) => parent.id === header.parentSessionId));
		assert.ok(entries.some((entry) => entry.type === "message" && entry.message.content === "first question"));
	}
	const snapshots = sessions.flat().filter((entry) => entry.type === "worktree_snapshot");
	assert.ok(snapshots.length >= 1);
	for (const snapshot of snapshots) assert.ok(Object.keys(snapshot.blobs ?? {}).length > 0, "snapshot content inline");
});

test(
	"a libSQL export of 0.10.11-alpha.2 imports into the local SQLite store and exports unchanged (#6624)",
	() => roundTrip([]),
	TRANSFER_TIMEOUT_MS,
);

describe.skipIf(postgresSkipReason !== undefined)("moving a libSQL export to PostgreSQL (#6624)", () => {
	test(
		"a libSQL export of 0.10.11-alpha.2 imports into PostgreSQL and exports unchanged (#6624)",
		async () => {
			const database = await createPostgresDatabase();
			try {
				await roundTrip(["--storage", postgresStorageSelection(database.url)]);
			} finally {
				await database.drop();
			}
		},
		TRANSFER_TIMEOUT_MS,
	);
});
