import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	getWriterQueueStats,
	openNodeSqliteDatabase,
} from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

const cli = fileURLToPath(new URL("../../packages/coding-agent/dist/cli.js", import.meta.url));
const timestamp = new Date(0).toISOString();
const digest = async (path: string) =>
	createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
function message(i: number, content: string) {
	return {
		type: "message" as const,
		id: `m${i}`,
		parentId: i ? `m${i - 1}` : null,
		timestamp,
		message: { role: "user" as const, timestamp: i, content },
	};
}

describe.each(["Node", "Bun"])("%s storage search-session", (runtime) => {
	let root: string, cwd: string, path: string, agentDir: string;
	const args = () => [
		runtime === "Node" ? process.execPath : bunExecutable(),
		cli,
		"storage",
		"search-session",
		path,
		"sample",
		"needle",
	];
	const env = () => ({
		...process.env,
		NODE_NO_WARNINGS: "1",
		ATOMIC_OFFLINE: "1",
		ATOMIC_CODING_AGENT_DIR: agentDir,
	});
	const search = () => spawnSyncCollect(args(), { cwd, env: env() });

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "atomic-readonly-search-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);
		path = join(cwd, "source #% ü.sqlite");
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function seed(count = 2, content = "needle") {
		// Close and copy only the SQLite file, leaving no adapter bookkeeping in the directory under test.
		const source = join(root, "seed.sqlite");
		const db = await openNodeSqliteDatabase(source);
		try {
			const store = await SqlSessionStore.open(db);
			try {
				await store.create(
					{ id: "sample", version: 4, cwd, createdAt: timestamp },
					Array.from({ length: count }, (_, i) => message(i, content)),
				);
				await store.create({ id: "peer", version: 4, cwd, createdAt: timestamp }, []);
			} finally {
				await store.close();
			}
		} finally {
			await db.close();
		}
		await copyFile(source, path);
	}

	test("searches the transcript without creating missing search-index or presence tables (#5479)", async () => {
		await seed();
		const db = new DatabaseSync(path);
		try {
			db.exec("DROP TABLE session_search_state; DROP TABLE session_open");
		} finally {
			db.close();
		}
		const before = await readFile(path);
		const result = search();
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.match(result.stdout.toString(), /needle/);
		assert.deepEqual(await readFile(path), before);
	});

	test("reads committed live WAL entries without changing the existing sidecars (#5479)", async () => {
		await seed();
		const held = new DatabaseSync(path);
		try {
			held.exec(
				"UPDATE session_entries SET entry_json=replace(entry_json, 'needle', 'needle-from-WAL') WHERE session_id='sample'",
			);
			const files = [path, `${path}-wal`, `${path}-shm`];
			const before = await Promise.all(files.map(digest));
			const result = search();
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.match(result.stdout.toString(), /needle-from-WAL/);
			assert.deepEqual(await Promise.all(files.map(digest)), before);
		} finally {
			held.close();
		}
	});

	test("does not create a missing WAL index or silently search a stale checkpoint (#5479)", async () => {
		await seed();
		const wal = `${path}-wal`;
		await writeFile(wal, "unpaired WAL");
		const result = search();
		assert.notEqual(result.exitCode, 0);
		assert.match(result.stderr.toString(), /close.*writer/i);
		assert.equal(await readFile(wal, "utf8"), "unpaired WAL");
		assert.equal((await readdir(cwd)).length, 2);
	});

	test("a closed output pipe stops successfully before reading later pages (#5479)", async () => {
		const line = "界".repeat(500);
		await seed(120, [line, `needle-${line}`, line, line, line].join("\n"));
		// A later page that cannot be read distinguishes stopping from silently discarding every page on Bun.
		const db = new DatabaseSync(path);
		try {
			db.exec(
				"PRAGMA ignore_check_constraints=ON; UPDATE session_entries SET entry_json = '{' WHERE session_id='sample' AND seq=120",
			);
		} finally {
			db.close();
		}
		const full = search();
		assert.match(full.stdout.toString(), /needle/);
		assert.notEqual(full.exitCode, 0, "the unreadable late page must be reached with an open pipe");
		const [bin, ...argv] = args();
		const scan = spawn(bin!, argv, { cwd, env: env(), stdio: ["ignore", "pipe", "pipe"] });
		const closed = once(scan, "close");
		let errors = "";
		scan.stderr.setEncoding("utf8").on("data", (text) => {
			errors += text;
		});
		try {
			scan.stdout.destroy();
			assert.equal((await closed)[0], 0, errors);
			assert.equal(errors, "");
		} finally {
			if (scan.exitCode === null) scan.kill();
			await closed;
		}
	});

	test("an independent append commits without the search entering the writer queue (#5479)", async () => {
		await seed(201);
		const peer = await openNodeSqliteDatabase(path);
		try {
			const store = await SqlSessionStore.open(peer);
			const raw = new DatabaseSync(path);
			try {
				raw.exec("BEGIN IMMEDIATE");
				const first = peer.transaction(async () => {});
				while (!getWriterQueueStats(peer).waiters) await delay(5);
				const [bin, ...argv] = args();
				const scan = spawn(bin!, argv, { cwd, env: env(), stdio: ["ignore", "pipe", "pipe"] });
				const closed = once(scan, "close");
				let output = "",
					errors = "";
				scan.stdout.setEncoding("utf8").on("data", (text) => {
					output += text;
				});
				scan.stderr.setEncoding("utf8").on("data", (text) => {
					errors += text;
				});
				try {
					// An existing FIFO forces any competing write to take a ticket, even on a read-only connection.
					while (!output && scan.exitCode === null && getWriterQueueStats(peer).waiters === 1) await delay(5);
					const queued = getWriterQueueStats(peer).waiters;
					const append = store.append("peer", [message(0, "unrelated append")], { expectSeq: 0 });
					raw.exec("ROLLBACK");
					await first;
					assert.equal((await append).lastSeq, 1);
					assert.equal((await closed)[0], 0, errors);
					assert.match(output, /needle/);
					assert.equal(queued, 1, "the search took a writer ticket ahead of the unrelated append");
				} finally {
					if (scan.exitCode === null) scan.kill();
					await closed;
				}
			} finally {
				raw.close();
				await store.close();
			}
		} finally {
			await peer.close();
		}
	});

	test.each(["clean", "sentinels", "not SQLite", "read-only directory"])(
		"preserves the files beside a %s input (#5479)",
		async (scenario) => {
			if (scenario === "not SQLite") await writeFile(path, "not a database");
			else await seed();
			if (scenario === "sentinels" || scenario === "not SQLite") {
				await writeFile(`${path}-open.lock`, "a different application's lock");
				await writeFile(`${path}-shm`, "a different application's data");
			}
			const snapshot = async () =>
				Promise.all((await readdir(cwd)).sort().map(async (name) => [name, await digest(join(cwd, name))]));
			const before = await snapshot();
			if (scenario === "read-only directory") {
				await chmod(path, 0o444);
				if (process.platform === "win32") {
					const denied = spawnSyncCollect(["icacls", cwd, "/deny", "*S-1-1-0:(WD,AD)"]);
					assert.equal(denied.exitCode, 0, denied.stderr.toString());
				} else await chmod(cwd, 0o555);
			}
			try {
				const result = search();
				assert.deepEqual(await snapshot(), before);
				assert.equal(result.exitCode, scenario === "not SQLite" ? 1 : 0, result.stderr.toString());
				if (scenario !== "not SQLite") assert.match(result.stdout.toString(), /needle/);
			} finally {
				if (scenario === "read-only directory") {
					if (process.platform === "win32") {
						const restored = spawnSyncCollect(["icacls", cwd, "/remove:d", "*S-1-1-0"]);
						assert.equal(restored.exitCode, 0, restored.stderr.toString());
					} else await chmod(cwd, 0o755);
					await chmod(path, 0o644);
				}
			}
		},
	);
});
