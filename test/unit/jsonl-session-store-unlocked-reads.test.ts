import assert from "node:assert/strict";
import * as fsCallback from "node:fs";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import {
	SessionConflictError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	JsonlSessionStore,
	type SessionLockFs,
} from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";

const hooks = vi.hoisted(() => ({
	handlePaths: new WeakMap<object, string>(),
	onSyncFile: undefined as ((path: string, runSync: () => Promise<void>) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: (async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			hooks.handlePaths.set(handle, String(args[0]));
			return handle;
		}) as typeof actual.open,
	};
});

vi.mock("../../packages/coding-agent/src/core/storage/file-sync.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../packages/coding-agent/src/core/storage/file-sync.js")>();
	return {
		...actual,
		syncFile: async (handle: fs.FileHandle) => {
			if (hooks.onSyncFile) {
				const path = hooks.handlePaths.get(handle) ?? "?";
				await hooks.onSyncFile(path, () => actual.syncFile(handle));
				return;
			}
			await actual.syncFile(handle);
		},
	};
});

const CREATED_AT = "2026-11-26T00:00:00.000Z";
const header = (id: string, cwd = "/project") => ({ id, version: 4 as const, createdAt: CREATED_AT, cwd });

function message(id: string, parentId: string | null = null, text = `text of ${id}`): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: CREATED_AT,
		message: { role: "user", content: text, timestamp: 1 },
	} as SessionEntry;
}

function countingLockFs(): { fs: SessionLockFs; locks: () => number; reset: () => void } {
	let locks = 0;
	const lockFs: SessionLockFs = {
		mkdir: ((...args: Parameters<typeof fsCallback.mkdir>) => {
			locks++;
			return fsCallback.mkdir(...args);
		}) as SessionLockFs["mkdir"],
		rmdir: fsCallback.rmdir,
		stat: fsCallback.stat,
		utimes: fsCallback.utimes,
		realpath: fsCallback.realpath,
	};
	return {
		fs: lockFs,
		locks: () => locks,
		reset: () => {
			locks = 0;
		},
	};
}

type ReadMethod = (this: fs.FileHandle, ...args: unknown[]) => Promise<{ bytesRead: number; buffer: Buffer }>;

async function interceptReads<T>(
	work: () => Promise<T>,
	onRead: (
		path: string,
		position: number | null | undefined,
		runRead: () => Promise<{ bytesRead: number; buffer: Buffer }>,
	) => Promise<{ bytesRead: number; buffer: Buffer }>,
): Promise<T> {
	const probe = await fs.open(fileURLToPath(import.meta.url), "r");
	const proto = Object.getPrototypeOf(probe) as { read: ReadMethod };
	await probe.close();
	const originalRead = proto.read;
	proto.read = async function (this: fs.FileHandle, ...args: unknown[]) {
		const path = hooks.handlePaths.get(this) ?? "?";
		const position = args[3] as number | null | undefined;
		return onRead(path, position, () => originalRead.apply(this, args));
	};
	try {
		return await work();
	} finally {
		proto.read = originalRead;
	}
}

describe("JSONL session store unlocked reads (#6719)", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "jsonl-unlocked-reads-"));
	});
	afterEach(async () => {
		hooks.onSyncFile = undefined;
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	});

	it("runs warm load, readTail, readRange and readResume without taking the directory lock (#6719)", async () => {
		const counter = countingLockFs();
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true, lockFs: counter.fs });
		try {
			await store.create(header("warm"), [message("a"), message("b", "a"), message("c", "b")]);
			await store.readResume("warm");
			counter.reset();

			const loaded = await store.load("warm");
			const tail = await store.readTail("warm", 2);
			const range = await store.readRange("warm", 1, 3);
			const resumed = await store.readResume("warm");

			assert.equal(counter.locks(), 0, "warm reads must not acquire .session.lock");
			assert.deepEqual(
				loaded.entries.map((e) => e.id),
				["a", "b", "c"],
			);
			assert.deepEqual(
				tail.entries.map((e) => e.id),
				["b", "c"],
			);
			assert.deepEqual(
				range.entries.map((e) => e.id),
				["a", "b", "c"],
			);
			assert.equal(resumed.leafId, "c");

			// A second freshly opened store with an existing .idx sidecar also reads without locking.
			const secondCounter = countingLockFs();
			const second = await JsonlSessionStore.open(directory, {
				exactDirectory: true,
				scanExisting: false,
				lockFs: secondCounter.fs,
			});
			try {
				assert.equal((await second.load("warm")).lastSeq, 3);
				assert.equal((await second.readTail("warm", 2)).entries.length, 2);
				assert.equal((await second.readRange("warm", 1, 3)).entries.length, 3);
				assert.equal((await second.readResume("warm")).leafId, "c");
				assert.equal(secondCounter.locks(), 0, "cold store reading pre-indexed session must not lock");
			} finally {
				await second.close();
			}
		} finally {
			await store.close();
		}
	});

	it("never writes or unlinks the .idx sidecar while unlocked, and persists it under lock after rechecking revision (#6719)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await writer.create(header("sidecar"), [message("a"), message("b", "a")]);
			const path = (await writer.findFile("sidecar"))!;
			const sidecarPath = `${path}.idx`;
			const lockPath = join(directory, ".session.lock");
			assert.equal(existsSync(sidecarPath), false);

			const mutationsWhileUnlocked: string[] = [];
			const mutationsWhileLocked: string[] = [];
			const origWriteFile = fs.writeFile;
			const origRename = fs.rename;
			const origUnlink = fs.unlink;
			const record = (op: string, target: unknown) => {
				const p = String(target);
				if (!p.includes(".idx")) return;
				if (existsSync(lockPath)) mutationsWhileLocked.push(`${op}:${p}`);
				else mutationsWhileUnlocked.push(`${op}:${p}`);
			};
			vi.spyOn(fs, "writeFile").mockImplementation(async (target, ...rest) => {
				record("writeFile", target);
				return origWriteFile(target, ...rest);
			});
			vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				record("rename", to);
				return origRename(from, to);
			});
			vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
				record("unlink", target);
				return origUnlink(target);
			});

			// load never writes or unlinks .idx at all.
			assert.equal((await reader.load("sidecar")).lastSeq, 2);
			assert.equal(existsSync(sidecarPath), false);
			assert.deepEqual(mutationsWhileUnlocked, []);
			assert.deepEqual(mutationsWhileLocked, []);

			// Cold readTail builds the index unlocked, then persists .idx ONLY while holding .session.lock.
			const tail = await reader.readTail("sidecar", 1);
			assert.equal(tail.entries.length, 2);
			assert.deepEqual(mutationsWhileUnlocked, [], "must never mutate .idx while unlocked");
			assert.ok(mutationsWhileLocked.length >= 2, "persisted .idx under lock");
			assert.equal(existsSync(sidecarPath), true);

			// Subsequent warm reads do not write or unlink .idx at all.
			mutationsWhileLocked.length = 0;
			assert.equal((await reader.readTail("sidecar", 1)).entries.length, 2);
			assert.equal((await reader.readRange("sidecar", 1, 2)).entries.length, 2);
			assert.equal((await reader.readResume("sidecar")).lastSeq, 2);
			assert.deepEqual(mutationsWhileUnlocked, []);
			assert.deepEqual(mutationsWhileLocked, []);
		} finally {
			await reader.close();
			await writer.close();
		}
	});

	it("skips writing a stale .idx if the file changes before deferred locked persistence acquires the lock (#6719)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await writer.create(header("stale-idx"), [message("a")]);
			const path = (await writer.findFile("stale-idx"))!;
			const sidecarPath = `${path}.idx`;
			assert.equal(existsSync(sidecarPath), false);

			const origStat = fs.stat;
			let mutatedBetweenValidationAndPersist = false;
			const statSpy = vi.spyOn(fs, "stat").mockImplementation((async (
				target: Parameters<typeof fs.stat>[0],
				options?: Parameters<typeof fs.stat>[1],
			) => {
				const result = await origStat(target, options as never);
				if (!mutatedBetweenValidationAndPersist && String(target) === path) {
					mutatedBetweenValidationAndPersist = true;
					await writer.append("stale-idx", [message("b", "a")], { expectSeq: 1 });
				}
				return result;
			}) as typeof fs.stat);
			try {
				const range = await reader.readRange("stale-idx", 1, 1);
				assert.deepEqual(
					range.entries.map((e) => e.id),
					["a"],
				);
			} finally {
				statSpy.mockRestore();
			}
			assert.equal(existsSync(sidecarPath), false, "must not write stale .idx after revision changed");
			assert.deepEqual(
				(await reader.readRange("stale-idx", 1, 2)).entries.map((e) => e.id),
				["a", "b"],
			);
		} finally {
			await reader.close();
			await writer.close();
		}
	});

	it("never returns uncommitted rolled-back bytes when reads interleave with a failed sync and rollback truncate (#6719)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await writer.create(header("rollback"), [message("committed")]);
			await writer.readResume("rollback");
			const path = (await writer.findFile("rollback"))!;

			let inSync!: () => void;
			const enteredSync = new Promise<void>((resolve) => {
				inSync = resolve;
			});
			let releaseSync!: () => void;
			const allowSyncToFail = new Promise<void>((resolve) => {
				releaseSync = resolve;
			});

			hooks.onSyncFile = async (syncedPath, runSync) => {
				if (syncedPath === path) {
					inSync();
					await allowSyncToFail;
					throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
				}
				await runSync();
			};

			const failedAppend = writer.append("rollback", [message("lost-uncommitted", "committed")], {
				expectSeq: 1,
			});
			await enteredSync;
			assert.match(await readFile(path, "utf8"), /"id":"lost-uncommitted"/);

			const reads = Promise.all([
				reader.load("rollback"),
				reader.readTail("rollback", 1),
				reader.readRange("rollback", 1, 5),
				reader.readResume("rollback"),
			]);

			await new Promise((resolve) => setTimeout(resolve, 30));
			releaseSync();

			await assert.rejects(failedAppend, StorageUnavailableError);
			const [loaded, tail, range, resumed] = await reads;
			assert.deepEqual(
				loaded.entries.map((e) => e.id),
				["committed"],
			);
			assert.deepEqual(
				tail.entries.map((e) => e.id),
				["committed"],
			);
			assert.deepEqual(
				range.entries.map((e) => e.id),
				["committed"],
			);
			assert.equal(resumed.leafId, "committed");
			assert.equal(resumed.lastSeq, 1);
		} finally {
			hooks.onSyncFile = undefined;
			await reader.close();
			await writer.close();
		}
	});

	it("rejects uncommitted bytes even if the writer rolls back and releases the lock right after the reader read them (#6719)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await writer.create(header("late-rollback"), [message("committed")]);
			const path = (await writer.findFile("late-rollback"))!;

			let inSync!: () => void;
			const enteredSync = new Promise<void>((resolve) => {
				inSync = resolve;
			});
			let releaseSync!: () => void;
			const allowSyncToFail = new Promise<void>((resolve) => {
				releaseSync = resolve;
			});

			hooks.onSyncFile = async (syncedPath, runSync) => {
				if (syncedPath === path) {
					inSync();
					await allowSyncToFail;
					throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
				}
				await runSync();
			};

			const failedAppend = writer.append("late-rollback", [message("uncommitted-ghost", "committed")], {
				expectSeq: 1,
			});
			await enteredSync;

			// Pause reader right after it reads the uncommitted bytes, then fail sync & release lock
			// BEFORE reader runs its post-read lock + stat check.
			let triggered = false;
			const loaded = await interceptReads(
				() => reader.load("late-rollback"),
				async (readPath, _pos, runRead) => {
					const result = await runRead();
					if (!triggered && readPath === path) {
						triggered = true;
						releaseSync();
						await assert.rejects(failedAppend, StorageUnavailableError);
					}
					return result;
				},
			);
			assert.equal(triggered, true);
			assert.deepEqual(
				loaded.entries.map((e) => e.id),
				["committed"],
			);
		} finally {
			hooks.onSyncFile = undefined;
			await reader.close();
			await writer.close();
		}
	});

	it("handles a torn last line unlocked without warning on transient races, and ignores committed torn tails (#6719)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await writer.create(header("torn-live"), [message("a")]);
			const path = (await writer.findFile("torn-live"))!;
			const lockPath = join(directory, ".session.lock");

			const warnings: string[] = [];
			const onWarning = (warning: Error & { code?: string }) => {
				if (warning.code === "ATOMIC_SESSION_TORN_LINE") warnings.push(warning.message);
			};
			process.on("warning", onWarning);
			try {
				await mkdir(lockPath);
				const fullEntry = `${JSON.stringify(message("b", "a"))}\n`;
				const half = Math.floor(fullEntry.length / 2);
				await appendFile(path, fullEntry.slice(0, half));

				const loadPromise = reader.load("torn-live");
				await new Promise((resolve) => setTimeout(resolve, 25));
				await appendFile(path, fullEntry.slice(half));
				await rm(lockPath, { recursive: true, force: true });

				const loaded = await loadPromise;
				assert.deepEqual(
					loaded.entries.map((e) => e.id),
					["a", "b"],
				);
				assert.deepEqual(warnings, [], "transient mid-write torn bytes must not emit ATOMIC_SESSION_TORN_LINE");

				await appendFile(path, '{"type":"message","id":"half');
				const [sLoad, sTail, sRange, sResume] = await Promise.all([
					reader.load("torn-live"),
					reader.readTail("torn-live", 1),
					reader.readRange("torn-live", 1, 5),
					reader.readResume("torn-live"),
				]);
				assert.deepEqual(
					sLoad.entries.map((e) => e.id),
					["a", "b"],
				);
				assert.deepEqual(
					sTail.entries.map((e) => e.id),
					["a", "b"],
				);
				assert.deepEqual(
					sRange.entries.map((e) => e.id),
					["a", "b"],
				);
				assert.equal(sResume.leafId, "b");
				assert.equal(warnings.length, 1, "committed torn last line emits warning once");
			} finally {
				process.off("warning", onWarning);
			}
		} finally {
			await reader.close();
			await writer.close();
		}
	});

	it("retries under lock when replace or updateHeader renames over the path, and closes stale kept handles (#6719)", async () => {
		const counter = countingLockFs();
		const storeA = await JsonlSessionStore.open(directory, { exactDirectory: true, lockFs: counter.fs });
		const storeB = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await storeA.create(header("rename", "/v1"), [message("a")]);
			await storeA.append("rename", [message("b", "a")], { expectSeq: 1 });
			await storeA.readResume("rename");
			const path = (await storeA.findFile("rename"))!;
			const oldIno = (await stat(path, { bigint: true })).ino;

			await storeB.replace("rename", header("rename", "/v2"), [message("r1"), message("r2", "r1")], {
				expectSeq: 2,
			});
			const newIno = (await stat(path, { bigint: true })).ino;
			assert.notEqual(newIno, oldIno);

			counter.reset();
			const afterReplace = await storeA.readTail("rename", 1);
			assert.equal(afterReplace.header.cwd, "/v2");
			assert.deepEqual(
				afterReplace.entries.map((e) => e.id),
				["r1", "r2"],
			);
			assert.ok(counter.locks() >= 1, "stale kept handle falls back to lock");

			counter.reset();
			assert.equal((await storeA.load("rename")).header.cwd, "/v2");
			assert.equal((await storeA.readRange("rename", 1, 2)).entries.length, 2);
			assert.equal((await storeA.readResume("rename")).header.cwd, "/v2");
			assert.equal(counter.locks(), 0, "subsequent reads succeed unlocked after stale kept handle closed");

			let renamedMidRead = false;
			let pendingUpdate: Promise<unknown> | undefined;
			const lockPath = join(directory, ".session.lock");
			const updated = await interceptReads(
				() => storeA.load("rename"),
				async (readPath, _pos, runRead) => {
					const result = await runRead();
					if (!renamedMidRead && readPath === path) {
						renamedMidRead = true;
						if (process.platform === "win32") {
							let settled = false;
							pendingUpdate = storeB.updateHeader(header("rename", "/v3"), { expectSeq: 2 }).finally(() => {
								settled = true;
							});
							const deadline = Date.now() + 5_000;
							while (!existsSync(lockPath) && !settled && Date.now() < deadline)
								await new Promise((resolve) => setTimeout(resolve, 5));
						} else {
							await storeB.updateHeader(header("rename", "/v3"), { expectSeq: 2 });
						}
					}
					return result;
				},
			);
			if (pendingUpdate) await pendingUpdate;
			assert.equal(renamedMidRead, true);
			assert.equal(updated.header.cwd, "/v3");
			assert.deepEqual(
				updated.entries.map((e) => e.id),
				["r1", "r2"],
			);
		} finally {
			await storeB.close();
			await storeA.close();
		}
	});

	it("retries transient Windows rename refusals in replace and updateHeader when an unlocked reader holds the file open (#6719)", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header("win-rename", "/v1"), [message("a")]);
			const path = (await store.findFile("win-rename"))!;
			const origRename = fs.rename;
			let refusals = 0;
			const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
				if (String(to) === path && refusals < 2) {
					refusals++;
					throw Object.assign(
						new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`),
						{
							code: "EPERM",
						},
					);
				}
				return origRename(from, to);
			});
			try {
				await store.updateHeader(header("win-rename", "/v2"), { expectSeq: 1 });
				assert.equal(refusals, 2);
				assert.equal((await store.load("win-rename")).header.cwd, "/v2");
			} finally {
				spy.mockRestore();
			}
		} finally {
			await store.close();
			Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
		}
	});

	it("keeps legacy header files locked for load, readTail, readRange and readResume until upgraded, then reads unlocked (#6719)", async () => {
		for (const [index, readOp] of [
			(store: JsonlSessionStore, id: string) => store.load(id).then((r) => r.entries.map((e) => e.id)),
			(store: JsonlSessionStore, id: string) => store.readTail(id, 1).then((r) => r.entries.map((e) => e.id)),
			(store: JsonlSessionStore, id: string) => store.readRange(id, 1, 5).then((r) => r.entries.map((e) => e.id)),
			(store: JsonlSessionStore, id: string) =>
				store.readResume(id).then((r) => r.branch.map(({ entry }) => entry.id)),
		].entries()) {
			const subDir = join(directory, `legacy-${index}`);
			await mkdir(subDir, { recursive: true });
			const id = `legacy-id-${index}`;
			const legacyPath = join(subDir, `2026-11-26T00-00-00-000Z_${id}.jsonl`);
			const legacyHeader = {
				type: "session",
				version: 3,
				id,
				timestamp: CREATED_AT,
				cwd: "/legacy",
			};
			await writeFile(legacyPath, `${JSON.stringify(legacyHeader)}\n${JSON.stringify(message("m1"))}\n`);

			const counter = countingLockFs();
			const store = await JsonlSessionStore.open(subDir, {
				exactDirectory: true,
				scanExisting: false,
				lockFs: counter.fs,
			});
			try {
				counter.reset();
				const ids = await readOp(store, id);
				assert.ok(counter.locks() >= 1, `legacy op ${index} must fall back to lock`);
				assert.deepEqual(ids, ["m1"]);

				// Once upgraded to v4 (and indexed for indexed ops), subsequent reads run unlocked.
				counter.reset();
				assert.deepEqual(await readOp(store, id), ["m1"]);
				assert.equal(counter.locks(), 0, `upgraded op ${index} runs unlocked`);
			} finally {
				await store.close();
			}
		}
	});

	it("triggers locked retry when a stale .session.lock exists on disk (#6719)", async () => {
		const counter = countingLockFs();
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true, lockFs: counter.fs });
		try {
			await store.create(header("stale-lock"), [message("a"), message("b", "a")]);
			await store.readResume("stale-lock");

			const lockPath = join(directory, ".session.lock");
			for (const readOp of [
				() => store.load("stale-lock").then((r) => r.lastSeq),
				() => store.readTail("stale-lock", 1).then((r) => r.entries.length),
				() => store.readRange("stale-lock", 1, 2).then((r) => r.entries.length),
				() => store.readResume("stale-lock").then((r) => r.lastSeq),
			]) {
				await mkdir(lockPath);
				const staleTime = new Date(Date.now() - 30_000);
				await utimes(lockPath, staleTime, staleTime);
				counter.reset();

				assert.equal(await readOp(), 2);
				assert.ok(counter.locks() >= 1, "stale lock must trigger locked retry");
				assert.equal(existsSync(lockPath), false, "locked retry cleared stale lock");

				counter.reset();
				assert.equal(await readOp(), 2);
				assert.equal(counter.locks(), 0, "subsequent read runs unlocked once stale lock is cleared");
			}
		} finally {
			await store.close();
		}
	});

	it("propagates genuine errors on unchanged unlocked files without locking (#6719)", async () => {
		const counter = countingLockFs();
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true, lockFs: counter.fs });
		try {
			const { epoch } = await store.create(header("errors"), [message("a")]);
			await store.readRange("errors", 1, 1, epoch);
			counter.reset();

			await assert.rejects(store.readRange("errors", 1, 1, "wrong-epoch"), SessionConflictError);
			assert.equal(counter.locks(), 0);

			const path = (await store.findFile("errors"))!;
			await appendFile(path, "{corrupt\n");
			await assert.rejects(store.load("errors"), StorageUnavailableError);
		} finally {
			await store.close();
		}
	});

	it("preserves intra-store read/write order on the store queue (#6719)", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header("ordered"), []);
			const [a1, l1, a2, t2, a3, r3, res3] = await Promise.all([
				store.append("ordered", [message("e1")], { expectSeq: 0 }),
				store.load("ordered"),
				store.append("ordered", [message("e2", "e1")], { expectSeq: 1 }),
				store.readTail("ordered", 1),
				store.append("ordered", [message("e3", "e2")], { expectSeq: 2 }),
				store.readRange("ordered", 1, 3),
				store.readResume("ordered"),
			]);
			assert.equal(a1.lastSeq, 1);
			assert.deepEqual(
				l1.entries.map((e) => e.id),
				["e1"],
			);
			assert.equal(a2.lastSeq, 2);
			assert.deepEqual(
				t2.entries.map((e) => e.id),
				["e1", "e2"],
			);
			assert.equal(a3.lastSeq, 3);
			assert.deepEqual(
				r3.entries.map((e) => e.id),
				["e1", "e2", "e3"],
			);
			assert.equal(res3.leafId, "e3");
		} finally {
			await store.close();
		}
	});

	it("does not block concurrent readers or writers in another store while a reader is mid-read (#6719)", async () => {
		const storeA = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const storeB = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await storeA.create(header("s1"), [message("a1")]);
			await storeA.create(header("s2"), [message("b1")]);
			await storeA.readResume("s1");
			await storeB.readResume("s1");
			const path1 = (await storeA.findFile("s1"))!;

			let pausedInRead!: () => void;
			const enteredRead = new Promise<void>((resolve) => {
				pausedInRead = resolve;
			});
			let releaseRead!: () => void;
			const allowReadToFinish = new Promise<void>((resolve) => {
				releaseRead = resolve;
			});

			let paused = false;
			const slowRead = interceptReads(
				() => storeA.load("s1"),
				async (readPath, _pos, runRead) => {
					if (!paused && readPath === path1) {
						paused = true;
						pausedInRead();
						await allowReadToFinish;
					}
					return runRead();
				},
			);
			await enteredRead;

			const bRead = await storeB.readTail("s1", 1);
			assert.deepEqual(
				bRead.entries.map((e) => e.id),
				["a1"],
			);
			const bWrite = await storeB.append("s2", [message("b2", "b1")], { expectSeq: 1 });
			assert.equal(bWrite.lastSeq, 2);

			releaseRead();
			const aLoaded = await slowRead;
			assert.deepEqual(
				aLoaded.entries.map((e) => e.id),
				["a1"],
			);
		} finally {
			await storeB.close();
			await storeA.close();
		}
	});

	it("stays consistent under concurrent replace, updateHeader, append and failed-sync rollback stress (#6719)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			let generation = 0;
			let seq = 1;
			await writer.create(header("stress", "/gen-0"), [message("g0-e1")]);
			const path = (await writer.findFile("stress"))!;

			let failNextSync = false;
			hooks.onSyncFile = async (syncedPath, runSync) => {
				if (syncedPath === path && failNextSync) {
					failNextSync = false;
					throw Object.assign(new Error("EIO: injected sync failure"), { code: "EIO" });
				}
				await runSync();
			};

			let stop = false;
			const writerLoop = (async () => {
				for (let step = 1; step <= 60; step++) {
					if (step % 10 === 0) {
						generation++;
						seq = 2;
						await writer.replace(
							"stress",
							header("stress", `/gen-${generation}`),
							[message(`g${generation}-e1`), message(`g${generation}-e2`, `g${generation}-e1`)],
							{ expectSeq: (await writer.load("stress")).lastSeq },
						);
					} else if (step % 7 === 0) {
						failNextSync = true;
						await assert.rejects(
							writer.append("stress", [message(`uncommitted-${step}`, `g${generation}-e${seq}`)], {
								expectSeq: seq,
							}),
							StorageUnavailableError,
						);
					} else if (step % 5 === 0) {
						await writer.updateHeader(header("stress", `/gen-${generation}`), { expectSeq: seq });
					} else {
						const prev = `g${generation}-e${seq}`;
						seq++;
						await writer.append("stress", [message(`g${generation}-e${seq}`, prev)], { expectSeq: seq - 1 });
					}
				}
				stop = true;
			})();

			let reads = 0;
			const readerLoop = (async () => {
				while (!stop || reads < 10) {
					const [loaded, tail, range, resumed] = await Promise.all([
						reader.load("stress"),
						reader.readTail("stress", 1),
						reader.readRange("stress", 1, 200),
						reader.readResume("stress"),
					]);
					for (const snap of [
						{ cwd: loaded.header.cwd, ids: loaded.entries.map((e) => e.id) },
						{ cwd: tail.header.cwd, ids: tail.entries.map((e) => e.id) },
						{ cwd: resumed.header.cwd, ids: resumed.branch.map(({ entry }) => entry.id) },
					]) {
						const gen = snap.cwd.slice("/gen-".length);
						assert.ok(snap.ids.length >= 1);
						for (const id of snap.ids) {
							assert.ok(!id.startsWith("uncommitted-"), `observed rolled-back entry: ${id}`);
							assert.ok(id.startsWith(`g${gen}-`), `torn mix: ${snap.cwd} vs ${id}`);
						}
					}
					assert.ok(range.entries.length >= 1);
					const rangeGen = range.entries[0]!.id.split("-")[0]!;
					for (const entry of range.entries) {
						assert.ok(!entry.id.startsWith("uncommitted-"), `observed rolled-back range entry: ${entry.id}`);
						assert.ok(entry.id.startsWith(`${rangeGen}-`), `torn range: ${entry.id} vs ${rangeGen}`);
					}
					reads++;
				}
			})();

			await Promise.all([writerLoop, readerLoop]);
			assert.ok(reads >= 10, `ran ${reads} concurrent read rounds`);
		} finally {
			hooks.onSyncFile = undefined;
			await reader.close();
			await writer.close();
		}
	});
});
