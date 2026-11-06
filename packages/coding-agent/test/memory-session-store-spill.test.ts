import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import type { CustomEntry } from "../src/core/session-manager-types.js";
import {
	isRetryableStorageError,
	isSessionSpillError,
	isStorageError,
	rehydrateStorageError,
	SESSION_SPILL_ERROR_CODES,
	SessionSpillError,
	serializeStorageError,
} from "../src/core/storage/errors.js";
import { StorageProvider } from "../src/core/storage/provider.js";
import { registerSessionStoreConformance } from "../src/core/storage/session/conformance.js";
import { SessionInvalidTextError, SessionNotFoundError, StoreClosedError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import { tempSessionHistoryFiles } from "../src/core/storage/session/temp-history-files.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { getProtectedSessionTempDirs, getTempRootDir } from "../src/core/tools/session-temp-dir.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile), rm: vi.fn(actual.rm) };
});

const open = vi.mocked(fsPromises.open);
const readFile = vi.mocked(fsPromises.readFile);
const rm = vi.mocked(fsPromises.rm);
const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

/** Lets `turns` turns of the event loop pass, enough for file operations already started to finish. */
async function eventLoopTurns(turns: number): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** Holds the next file `open` until the returned function runs, then fails it with `failure` or opens it. */
function holdNextOpen(failure?: Error): () => void {
	let resume!: () => void;
	const held = new Promise<void>((resolve) => {
		resume = resolve;
	});
	open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
		await held;
		if (failure !== undefined) throw failure;
		return actual.open(...args);
	});
	return resume;
}

/**
 * How the in-memory store keeps a released session's history out of process memory (#4502): `release()` moves the
 * entries it holds to the session's file, a load reads that file once and adds what was appended since, and an append
 * writes nothing to disk. Operations are counted, not timed.
 */
const agentDir = useTemporaryAgentDir();
function setTempRoot(path: string): () => void {
	const keys = ["TMPDIR", "TEMP", "TMP"] as const;
	const previous = keys.map((key) => process.env[key]);
	for (const key of keys) process.env[key] = path;
	return () => {
		for (const [index, key] of keys.entries()) {
			const value = previous[index];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

let restoreTmpdir: () => void = () => {};
beforeAll(() => {
	const tmp = join(agentDir, "tmp");
	mkdirSync(tmp, { recursive: true });
	restoreTmpdir = setTempRoot(tmp);
});
afterAll(() => restoreTmpdir());

const opened: MemorySessionStore[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	open.mockClear();
	readFile.mockClear();
	rm.mockClear();
	for (const store of opened.splice(0)) await store.close().catch(() => undefined);
});

function newStore(): MemorySessionStore {
	const store = new MemorySessionStore(undefined, tempSessionHistoryFiles);
	opened.push(store);
	return store;
}

const header = (id: string, cwd = "/repo") => ({
	id,
	version: 4 as const,
	createdAt: "2026-11-06T00:00:00.000Z",
	cwd,
});

function entry(id: string, text = `note ${id} ${"x".repeat(200)} → done`): CustomEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-11-06T00:00:00.000Z",
		customType: "note",
		data: { text },
	};
}

const entries = (prefix: string, count: number) =>
	Array.from({ length: count }, (_, index) => entry(`${prefix}-${index}`));

/** The UTF-8 bytes the store keeps for these entries: their JSON, comma-separated, without brackets. */
const entryBytes = (list: readonly CustomEntry[]) => Buffer.byteLength(JSON.stringify(list)) - 2;
const headerBytes = (id: string, cwd?: string) => Buffer.byteLength(JSON.stringify(header(id, cwd)));

/** The store's spill directories under Atomic's temp directory, and the files in each. */
function spillDirectories(): Array<{ path: string; files: string[] }> {
	const root = getTempRootDir();
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((name) => name.startsWith("memory-sessions-"))
		.map((name) => ({ path: join(root, name), files: readdirSync(join(root, name)) }));
}

function spillFileSizes(): number[] {
	return spillDirectories().flatMap(({ path, files }) => files.map((file) => statSync(join(path, file)).size));
}

async function created(store: MemorySessionStore, id: string, list: readonly CustomEntry[]) {
	await store.create(header(id), []);
	await store.append(id, list, { expectSeq: 0 });
}

describe("a released session's history leaves process memory (#4502)", () => {
	test("release keeps only the header in memory; a load reads the file once and returns the whole history", async () => {
		const store = newStore();
		const history = entries("e", 400);
		await created(store, "s", history);
		const before = await store.load("s");
		assert.deepEqual(store.historyBytes(), { inMemory: headerBytes("s") + entryBytes(history), onDisk: 0 });

		await store.releaseSession("s");

		assert.deepEqual(store.historyBytes(), { inMemory: headerBytes("s"), onDisk: entryBytes(history) });
		assert.deepEqual(spillFileSizes(), [entryBytes(history)]);
		assert.equal(open.mock.calls.length, 1);
		readFile.mockClear();
		assert.deepEqual(await store.load("s"), before);
		assert.equal(readFile.mock.calls.length, 1, "one read of the file per load");
		assert.deepEqual(store.historyBytes(), { inMemory: headerBytes("s"), onDisk: entryBytes(history) });
		assert.deepEqual(await store.readHeader("s"), header("s"));
		assert.equal(readFile.mock.calls.length, 1, "the header is read from memory");
	});

	test("an append after release writes nothing to disk, and the next release writes only what it added", async () => {
		const store = newStore();
		const first = entries("a", 50);
		await created(store, "s", first);
		await store.releaseSession("s");
		open.mockClear();

		const later = entries("b", 3);
		assert.deepEqual(await store.append("s", later, { expectSeq: 50 }), { lastSeq: 53 });
		assert.equal(open.mock.calls.length + readFile.mock.calls.length, 0, "an append touches no file");
		assert.deepEqual(store.historyBytes(), {
			inMemory: headerBytes("s") + entryBytes(later),
			onDisk: entryBytes(first),
		});
		assert.deepEqual((await store.load("s")).entries, [...first, ...later]);

		await store.releaseSession("s");
		assert.equal(open.mock.calls.length, 1);
		assert.deepEqual(store.historyBytes(), {
			inMemory: headerBytes("s"),
			onDisk: entryBytes(first) + 1 + entryBytes(later),
		});
		assert.deepEqual(spillFileSizes(), [entryBytes(first) + 1 + entryBytes(later)]);
		assert.deepEqual(await store.load("s"), { header: header("s"), entries: [...first, ...later], lastSeq: 53 });
	});

	test("releasing again with nothing appended, an unknown session, a closed store or a private one writes nothing", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 5));
		await store.releaseSession("s");
		open.mockClear();
		await store.releaseSession("s");
		await store.releaseSession("missing");
		assert.equal(open.mock.calls.length, 0);

		const empty = newStore();
		await empty.create(header("empty"), []);
		await empty.releaseSession("empty");
		assert.equal(open.mock.calls.length, 0, "a session with no entries has nothing to move");

		const inMemoryOnly = new MemorySessionStore();
		await created(inMemoryOnly, "p", entries("p", 5));
		await inMemoryOnly.releaseSession("p");
		assert.deepEqual(inMemoryOnly.historyBytes(), {
			inMemory: headerBytes("p") + entryBytes(entries("p", 5)),
			onDisk: 0,
		});
		assert.deepEqual((await inMemoryOnly.load("p")).entries, entries("p", 5));
		assert.deepEqual(inMemoryOnly.spillDegradation(), []);
		await inMemoryOnly.delete("p");
		await (await inMemoryOnly.reopen()).close();
		await inMemoryOnly.close();

		const closing = newStore();
		await created(closing, "c", entries("c", 5));
		await closing.close();
		await closing.releaseSession("c");
		assert.equal(open.mock.calls.length, 0);
	});

	test("appends made while a release writes follow the written history, and a load waits for the write", async () => {
		const store = newStore();
		const first = entries("a", 30);
		await created(store, "s", first);
		const resume = holdNextOpen();
		const releasing = store.releaseSession("s");
		await vi.waitFor(() => assert.equal(open.mock.calls.length, 1));
		const during = entries("b", 2);
		await store.append("s", during, { expectSeq: 30 });
		const loading = store.load("s");
		resume();
		await releasing;
		assert.deepEqual((await loading).entries, [...first, ...during]);
		assert.deepEqual(store.historyBytes(), {
			inMemory: headerBytes("s") + entryBytes(during),
			onDisk: entryBytes(first),
		});
		await Promise.all([store.releaseSession("s"), store.releaseSession("s")]);
		assert.deepEqual((await store.load("s")).entries, [...first, ...during]);
		assert.equal(store.historyBytes().inMemory, headerBytes("s"));
	});

	test("bytes left past the written history by a failed write are never read, and the next release overwrites them", async () => {
		const store = newStore();
		const first = entries("a", 10);
		await created(store, "s", first);
		await store.releaseSession("s");
		const [{ path, files }] = spillDirectories();
		writeFileSync(join(path, files[0] as string), ',{"partial":', { flag: "a" });

		const later = entries("b", 2);
		await store.append("s", later, { expectSeq: 10 });
		assert.deepEqual((await store.load("s")).entries, [...first, ...later]);
		await store.releaseSession("s");
		assert.deepEqual((await store.load("s")).entries, [...first, ...later]);
		assert.deepEqual(spillFileSizes(), [entryBytes(first) + 1 + entryBytes(later)]);
	});

	test("delete and replace remove the session's file; list and findMostRecent read released sessions", async () => {
		const store = newStore();
		await created(store, "kept", entries("k", 20));
		await store.create(header("other", "/elsewhere"), entries("o", 4));
		await created(store, "gone", entries("g", 20));
		const listed = [];
		for await (const summary of store.list({ cwd: "/repo" })) listed.push(summary);
		const recent = await store.findMostRecent({ cwd: "/repo" });
		for (const id of ["kept", "other", "gone"]) await store.releaseSession(id);
		assert.equal(spillFileSizes().length, 3);

		readFile.mockClear();
		const relisted = [];
		for await (const summary of store.list({ cwd: "/repo" })) relisted.push(summary);
		assert.deepEqual(relisted, listed);
		assert.equal(readFile.mock.calls.length, 2, "a session in another cwd is not read");
		assert.deepEqual(await store.findMostRecent({ cwd: "/repo" }), recent);

		await store.delete("gone");
		assert.equal(spillFileSizes().length, 2);
		await assert.rejects(store.load("gone"), (error: Error) => error instanceof SessionNotFoundError);

		const replacement = entries("r", 2);
		assert.deepEqual(await store.replace("kept", header("kept"), replacement, { expectSeq: 20 }), { lastSeq: 2 });
		assert.equal(spillFileSizes().length, 1);
		assert.deepEqual(await store.load("kept"), { header: header("kept"), entries: replacement, lastSeq: 2 });
		assert.deepEqual(store.historyBytes(), {
			inMemory: headerBytes("kept") + entryBytes(replacement) + headerBytes("other", "/elsewhere"),
			onDisk: entryBytes(entries("o", 4)),
		});
	});

	test("a memory selection opens a store that keeps released history on disk, as SDK hosts and --no-session get it", async () => {
		const store = await new StorageProvider().openSessionStore({ kind: "memory" }, { agentDir, domain: "sessions" });
		const history = entries("e", 4);
		await store.create(header("s"), history);
		await store.releaseSession?.("s");
		assert.deepEqual(spillFileSizes(), [entryBytes(history)]);
		assert.deepEqual((await store.load("s")).entries, history);
		await store.close();
		assert.deepEqual(spillDirectories(), []);
	});

	test("a session deleted while its file is being read loads as not found", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 5));
		await store.releaseSession("s");
		let reading!: () => void;
		const gate = new Promise<void>((resolve) => {
			reading = resolve;
		});
		readFile.mockImplementationOnce(async (...args: Parameters<typeof actual.readFile>) => {
			await gate;
			return actual.readFile(...args);
		});
		const loading = store.load("s");
		await store.delete("s");
		reading();
		await assert.rejects(loading, (error: Error) => error instanceof SessionNotFoundError);
	});

	test("the directory is owner-only, protected from the temp sweep while open, and removed when the last handle closes", async () => {
		const store = new MemorySessionStore(undefined, tempSessionHistoryFiles);
		await created(store, "s", entries("e", 5));
		await store.releaseSession("s");
		const [{ path, files }] = spillDirectories();
		if (process.platform !== "win32") {
			assert.equal(statSync(path).mode & 0o777, 0o700);
			assert.equal(statSync(join(path, files[0] as string)).mode & 0o777, 0o600);
		}
		assert.ok(getProtectedSessionTempDirs().has(path));

		const reopened = await store.reopen();
		await store.close();
		assert.ok(existsSync(path), "a handle reopen() made keeps the directory");
		assert.deepEqual((await reopened.load("s")).entries, entries("e", 5));
		await assert.rejects(store.load("s"), (error: Error) => error instanceof StoreClosedError);

		await reopened.close();
		assert.equal(existsSync(path), false);
		assert.equal(getProtectedSessionTempDirs().has(path), false);
		assert.deepEqual(reopened.spillDegradation(), []);
	});

	test("a directory left by a store never closed is removed at exit, by one listener for the whole process", async () => {
		vi.resetModules();
		const fresh = await import("../src/core/storage/session/temp-history-files.js");
		const listening = () =>
			process.listeners("exit").filter((listener) => listener.toString().includes("liveDirectories"));
		const before = listening();
		const first = new MemorySessionStore(undefined, fresh.tempSessionHistoryFiles);
		const second = new MemorySessionStore(undefined, fresh.tempSessionHistoryFiles);
		for (const store of [first, second]) {
			await store.create(header("s"), entries("e", 5));
			await store.releaseSession("s");
		}
		const added = listening().filter((listener) => !before.includes(listener));
		assert.equal(added.length, 1);
		const directories = spillDirectories().map(({ path }) => path);
		assert.equal(directories.length, 2);
		(added[0] as () => void)();
		assert.deepEqual(
			directories.filter((path) => existsSync(path)),
			[],
		);
		process.removeListener("exit", added[0] as () => void);
	});

	test("closing a store waits for a write in flight, then removes the directory; a store that never wrote removes nothing", async () => {
		const store = new MemorySessionStore(undefined, tempSessionHistoryFiles);
		await created(store, "s", entries("e", 5));
		const resume = holdNextOpen();
		const releasing = store.releaseSession("s");
		await vi.waitFor(() => assert.equal(open.mock.calls.length, 1));
		const [{ path }] = spillDirectories();
		const closing = store.close();
		await eventLoopTurns(20);
		assert.ok(existsSync(path), "the directory stays while a write is in flight");
		resume();
		await Promise.all([releasing, closing]);
		assert.deepEqual(spillDirectories(), []);
		assert.deepEqual(store.spillDegradation(), []);

		const unused = new MemorySessionStore(undefined, tempSessionHistoryFiles);
		await created(unused, "u", entries("u", 2));
		await unused.close();
		assert.deepEqual(unused.spillDegradation(), []);
		assert.equal(rm.mock.calls.length, 1, "only the directory that was written is removed");
	});

	test("a directory something else already removed is not a cleanup failure", async () => {
		const store = new MemorySessionStore(undefined, tempSessionHistoryFiles);
		await created(store, "s", entries("e", 5));
		await store.releaseSession("s");
		const [{ path }] = spillDirectories();
		rmSync(path, { recursive: true });
		await store.close();
		assert.deepEqual(store.spillDegradation(), []);
	});

	test("a release waiting behind a write in flight writes nothing for a session deleted meanwhile, and the delete leaves no file", async () => {
		const store = newStore();
		await created(store, "s", entries("a", 5));
		const resume = holdNextOpen();
		const first = store.releaseSession("s");
		await vi.waitFor(() => assert.equal(open.mock.calls.length, 1));
		await store.append("s", entries("b", 2), { expectSeq: 5 });
		const second = store.releaseSession("s");
		const deleting = store.delete("s");
		await eventLoopTurns(20);
		resume();
		await Promise.all([first, second, deleting]);
		assert.equal(open.mock.calls.length, 1);
		assert.deepEqual(spillFileSizes(), []);
		assert.deepEqual(store.spillDegradation(), []);
	});

	test("a load waits for every release queued behind the write in flight, so what they took is never missed", async () => {
		const store = newStore();
		const first = entries("a", 5);
		await created(store, "s", first);
		const resumeFirst = holdNextOpen();
		const releasingFirst = store.releaseSession("s");
		await vi.waitFor(() => assert.equal(open.mock.calls.length, 1));
		const later = entries("b", 2);
		await store.append("s", later, { expectSeq: 5 });
		const resumeSecond = holdNextOpen();
		const releasingSecond = store.releaseSession("s");
		resumeFirst();
		await releasingFirst;
		await vi.waitFor(() => assert.equal(open.mock.calls.length, 2));
		const loading = store.load("s");
		resumeSecond();
		await releasingSecond;
		assert.deepEqual((await loading).entries, [...first, ...later]);
	});

	test("a session deleted while a listing reads its file is left out of the listing", async () => {
		const store = newStore();
		await created(store, "gone", entries("g", 3));
		await created(store, "kept", entries("k", 3));
		await store.releaseSession("gone");
		let reading!: () => void;
		const gate = new Promise<void>((resolve) => {
			reading = resolve;
		});
		readFile.mockImplementationOnce(async (...args: Parameters<typeof actual.readFile>) => {
			await gate;
			return actual.readFile(...args);
		});
		const listing = (async () => {
			const ids: string[] = [];
			for await (const summary of store.list({})) ids.push(summary.id);
			return ids;
		})();
		await vi.waitFor(() => assert.equal(readFile.mock.calls.length, 1));
		await store.delete("gone");
		reading();
		assert.deepEqual(await listing, ["kept"]);
	});

	test("a load whose file disappears because the store closed fails as a closed store", async () => {
		const store = new MemorySessionStore(undefined, tempSessionHistoryFiles);
		await created(store, "s", entries("e", 3));
		await store.releaseSession("s");
		let reading!: () => void;
		const gate = new Promise<void>((resolve) => {
			reading = resolve;
		});
		readFile.mockImplementationOnce(async (...args: Parameters<typeof actual.readFile>) => {
			await gate;
			return actual.readFile(...args);
		});
		const loading = store.load("s");
		await vi.waitFor(() => assert.equal(readFile.mock.calls.length, 1));
		await store.close();
		reading();
		await assert.rejects(loading, (error: Error) => error instanceof StoreClosedError);
	});

	test("releasing a session held in one buffer writes that buffer without copying it", async () => {
		const store = newStore();
		const encode = vi.spyOn(TextEncoder.prototype, "encode");
		await store.create(header("s"), entries("e", 20));
		const encoded = encode.mock.results.at(-1)?.value;
		assert.ok(encoded instanceof Uint8Array);
		encode.mockRestore();
		const written: Uint8Array[] = [];
		open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			return {
				write: (data: Uint8Array, offset: number, length: number, position: number) => {
					written.push(data);
					return handle.write(data, offset, length, position);
				},
				close: () => handle.close(),
			} as fsPromises.FileHandle;
		});
		await store.releaseSession("s");
		assert.equal(written.length, 1);
		assert.equal(written[0], encoded);
		assert.deepEqual((await store.load("s")).entries, entries("e", 20));
	});

	test("a write the filesystem takes in parts still writes the whole history, and the file is closed once", async () => {
		const store = newStore();
		const first = entries("a", 10);
		await created(store, "s", first);
		await store.releaseSession("s");
		const later = entries("b", 10);
		await store.append("s", later, { expectSeq: 10 });
		const writes: number[] = [];
		const lengths: number[] = [];
		let closes = 0;
		open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			return {
				write: (data: Uint8Array, offset: number, length: number, position: number) => {
					writes.push(position);
					lengths.push(length);
					return handle.write(data, offset, Math.min(length, 700), position);
				},
				close: () => {
					closes += 1;
					return handle.close();
				},
			} as unknown as fsPromises.FileHandle;
		});
		await store.releaseSession("s");
		const bytes = 1 + entryBytes(later);
		const parts = Math.ceil(bytes / 700);
		assert.deepEqual(
			writes,
			Array.from({ length: parts }, (_, index) => entryBytes(first) + index * 700),
		);
		assert.deepEqual(
			lengths,
			Array.from({ length: parts }, (_, index) => bytes - index * 700),
		);
		assert.equal(closes, 1);
		assert.deepEqual((await store.load("s")).entries, [...first, ...later]);
	});
});

describe("spill failures are typed and never lose history (#4502)", () => {
	test("a write that fails keeps the history in memory, is recorded once, and the next release writes it", async () => {
		const store = newStore();
		const history = entries("e", 10);
		await created(store, "s", history);
		const warnings: Error[] = [];
		vi.spyOn(process, "emitWarning").mockImplementation((warning: string | Error) => {
			warnings.push(warning as Error);
		});
		const full = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
		open.mockRejectedValueOnce(full).mockRejectedValueOnce(full);

		await store.releaseSession("s");
		await store.releaseSession("s");

		assert.deepEqual(store.historyBytes(), { inMemory: headerBytes("s") + entryBytes(history), onDisk: 0 });
		const [degradation, ...rest] = store.spillDegradation();
		assert.deepEqual(rest, []);
		assert.ok(degradation instanceof SessionSpillError);
		assert.equal(degradation.code, "spill-write-failed");
		assert.equal(degradation.sessionId, "s");
		assert.equal(degradation.errno, "ENOSPC");
		assert.equal(degradation.bytes, entryBytes(history));
		assert.equal(degradation.cause, full);
		assert.equal(degradation.retryable, false);
		assert.deepEqual(warnings, [degradation]);
		assert.deepEqual((await store.load("s")).entries, history);

		await store.releaseSession("s");
		assert.deepEqual(store.historyBytes(), { inMemory: headerBytes("s"), onDisk: entryBytes(history) });
		assert.deepEqual((await store.load("s")).entries, history);
	});

	test("appends made while a write fails stay after the history it was writing", async () => {
		const store = newStore();
		const first = entries("a", 10);
		await created(store, "s", first);
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const resume = holdNextOpen(Object.assign(new Error("denied"), { code: "EACCES" }));
		const releasing = store.releaseSession("s");
		await vi.waitFor(() => assert.equal(open.mock.calls.length, 1));
		const during = entries("b", 2);
		await store.append("s", during, { expectSeq: 10 });
		resume();
		await releasing;
		assert.deepEqual((await store.load("s")).entries, [...first, ...during]);
		assert.equal(store.historyBytes().inMemory, headerBytes("s") + entryBytes(first) + 1 + entryBytes(during));
	});

	test("a missing or truncated file fails the load with spill-missing, never as a session that does not exist", async () => {
		const store = newStore();
		const history = entries("e", 10);
		await created(store, "s", history);
		await store.releaseSession("s");
		const [{ path, files }] = spillDirectories();
		const file = join(path, files[0] as string);

		truncateSync(file, 100);
		await assert.rejects(store.load("s"), (error: Error) => {
			assert.ok(isSessionSpillError(error));
			assert.ok(!(error instanceof SessionNotFoundError));
			assert.equal(error.code, "spill-missing");
			assert.equal(error.sessionId, "s");
			assert.equal(error.directory, path);
			assert.equal(error.bytes, entryBytes(history));
			assert.equal(error.foundBytes, 100);
			assert.equal(error.retryable, false);
			return true;
		});

		await fsPromises.unlink(file);
		await assert.rejects(store.load("s"), (error: Error) => {
			assert.ok(isSessionSpillError(error));
			assert.equal(error.code, "spill-missing");
			assert.equal(error.errno, "ENOENT");
			assert.equal(error.foundBytes, undefined);
			return true;
		});
		assert.deepEqual(await store.readHeader("s"), header("s"), "the session still exists");
	});

	test("a read that fails is spill-read-failed, retryable only when the filesystem failure passes", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 3));
		await store.releaseSession("s");
		const cause = (code: string) => Object.assign(new Error(code), { code });
		const tooMany = cause("EMFILE");
		readFile.mockRejectedValueOnce(tooMany).mockRejectedValueOnce(cause("EIO"));

		const transient = await store.load("s").then(
			() => assert.fail("the load succeeded"),
			(error: Error) => error,
		);
		assert.ok(isSessionSpillError(transient));
		assert.equal(transient.code, "spill-read-failed");
		assert.equal(transient.errno, "EMFILE");
		assert.equal(transient.retryable, true);
		assert.equal(transient.cause, tooMany);
		assert.equal(isRetryableStorageError(new Error("wake failed", { cause: transient })), true);

		const lasting = await store.load("s").then(
			() => assert.fail("the load succeeded"),
			(error: Error) => error,
		);
		assert.ok(isSessionSpillError(lasting));
		assert.equal(lasting.code, "spill-read-failed");
		assert.equal(lasting.retryable, false);
		assert.equal(isRetryableStorageError(lasting), false);
		assert.deepEqual((await store.load("s")).entries, entries("e", 3));
	});

	test("files that cannot be removed are recorded as spill-cleanup-failed, and the session is still gone", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 3));
		await created(store, "t", entries("t", 3));
		await store.releaseSession("s");
		await store.releaseSession("t");
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
		rm.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
		await store.delete("s");
		await assert.rejects(store.load("s"), (error: Error) => error instanceof SessionNotFoundError);
		const [{ path }] = spillDirectories();
		await store.close();
		assert.deepEqual(
			store.spillDegradation().map((error) => [error.code, error.sessionId, error.directory, error.errno]),
			[["spill-cleanup-failed", "s", path, "EBUSY"]],
		);
		opened.splice(opened.indexOf(store), 1);
		rmSync(path, { recursive: true, force: true });
	});

	test("a write the filesystem rejects keeps the history in memory, and a close that fails after it stays attached to it", async () => {
		const store = newStore();
		const history = entries("e", 10);
		await created(store, "s", history);
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const ioError = Object.assign(new Error("I/O error"), { code: "EIO" });
		const closeError = Object.assign(new Error("bad descriptor"), { code: "EBADF" });
		let closes = 0;
		open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			return {
				write: async () => {
					throw ioError;
				},
				close: async () => {
					closes += 1;
					await handle.close();
					throw closeError;
				},
			} as unknown as fsPromises.FileHandle;
		});
		await store.releaseSession("s");
		assert.equal(closes, 1);
		const [degradation] = store.spillDegradation();
		assert.equal(degradation?.code, "spill-write-failed");
		assert.equal(degradation?.errno, "EIO");
		assert.equal(degradation?.cause, ioError);
		assert.equal((ioError as { cleanupCause?: Error }).cleanupCause, closeError);
		assert.deepEqual(store.historyBytes(), { inMemory: headerBytes("s") + entryBytes(history), onDisk: 0 });
		assert.deepEqual((await store.load("s")).entries, history);
	});

	test("a write that fails with something other than an Error keeps that failure as the cause", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 2));
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			return {
				write: () => Promise.reject("EIO"),
				close: async () => {
					await handle.close();
					throw new Error("close failed too");
				},
			} as unknown as fsPromises.FileHandle;
		});
		await store.releaseSession("s");
		const [degradation] = store.spillDegradation();
		assert.equal(degradation?.code, "spill-write-failed");
		assert.equal(degradation?.cause, "EIO");
	});

	test("a close that fails after a whole write keeps the history in memory, with the close failure as the cause", async () => {
		const store = newStore();
		const history = entries("e", 4);
		await created(store, "s", history);
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const closeError = Object.assign(new Error("no space at close"), { code: "ENOSPC" });
		open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			return {
				write: (data: Uint8Array, offset: number, length: number, position: number) =>
					handle.write(data, offset, length, position),
				close: async () => {
					await handle.close();
					throw closeError;
				},
			} as unknown as fsPromises.FileHandle;
		});
		await store.releaseSession("s");
		const [degradation] = store.spillDegradation();
		assert.equal(degradation?.code, "spill-write-failed");
		assert.equal(degradation?.cause, closeError);
		assert.equal(degradation?.errno, "ENOSPC");
		assert.equal(store.historyBytes().onDisk, 0);
		await store.releaseSession("s");
		assert.deepEqual(store.historyBytes(), { inMemory: headerBytes("s"), onDisk: entryBytes(history) });
		assert.deepEqual((await store.load("s")).entries, history);
	});

	test("a session whose first write failed leaves no file, so deleting it is not a cleanup failure", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 3));
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		open.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
		await store.releaseSession("s");
		await store.delete("s");
		assert.deepEqual(
			store.spillDegradation().map((error) => error.code),
			["spill-write-failed"],
		);
	});

	test("a directory that cannot be removed when the store closes is recorded as spill-cleanup-failed for the directory", async () => {
		const store = new MemorySessionStore(undefined, tempSessionHistoryFiles);
		await created(store, "s", entries("e", 3));
		await store.releaseSession("s");
		const [{ path }] = spillDirectories();
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
		rm.mockRejectedValueOnce(busy);
		await store.close();
		const [degradation, ...others] = store.spillDegradation();
		assert.deepEqual(others, []);
		assert.equal(degradation?.code, "spill-cleanup-failed");
		assert.equal(degradation?.directory, path);
		assert.equal(degradation?.sessionId, undefined);
		assert.equal(degradation?.errno, "EBUSY");
		assert.equal(degradation?.cause, busy);
		rmSync(path, { recursive: true, force: true });
	});

	test("a session id with a NUL character is refused at the boundary", async () => {
		const store = newStore();
		await assert.rejects(store.releaseSession("bad\0id"), (error: Error) => {
			assert.ok(error instanceof SessionInvalidTextError);
			assert.equal(error.field, "sessionId");
			assert.equal(error.reason, "nul-character");
			return true;
		});
	});

	test("a spill directory that cannot be trusted keeps history in memory and is recorded as spill-dir-refused", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 3));
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const file = join(agentDir, "not-a-directory");
		writeFileSync(file, "");
		const restore = setTempRoot(file);
		try {
			await store.releaseSession("s");
		} finally {
			restore();
		}
		const [degradation, ...others] = store.spillDegradation();
		assert.deepEqual(others, []);
		assert.equal(degradation?.code, "spill-dir-refused");
		assert.equal((degradation?.cause as Error | undefined)?.name, "TempDirRefusedError");
		assert.equal(degradation?.sessionId, undefined);
		assert.ok(degradation?.directory.startsWith(file));
		assert.deepEqual(store.historyBytes(), {
			inMemory: headerBytes("s") + entryBytes(entries("e", 3)),
			onDisk: 0,
		});
		await store.releaseSession("s");
		assert.equal(
			store.historyBytes().inMemory,
			headerBytes("s"),
			"a later release, with a usable directory, writes it",
		);
	});
});

describe("SessionSpillError (#4502)", () => {
	const fields = { directory: "/tmp/atomic-1000/memory-sessions-1-ab", sessionId: "s", bytes: 120, errno: "EMFILE" };

	it("is a storage error with a stable code, a hint, and a guard that recognizes copies", () => {
		const error = new SessionSpillError("spill-read-failed", fields, { cause: new Error("too many open files") });
		assert.ok(error instanceof SessionSpillError);
		assert.equal(error.name, "SessionSpillError");
		assert.equal(isStorageError(error), true);
		assert.equal(isSessionSpillError({ name: "SessionSpillError", code: "spill-missing" }), true);
		assert.equal(isSessionSpillError({ name: "SessionSpillError", code: "spill-unknown" }), false);
		assert.equal(isSessionSpillError({ name: "SessionBlobError", code: "spill-missing" }), false);
		assert.equal(isSessionSpillError(undefined), false);
		assert.deepEqual(SESSION_SPILL_ERROR_CODES, [
			"spill-dir-refused",
			"spill-write-failed",
			"spill-read-failed",
			"spill-missing",
			"spill-cleanup-failed",
		]);
		assert.equal(
			error.message,
			"Could not read a released session's history: session s in /tmp/atomic-1000/memory-sessions-1-ab (spill-read-failed). Check that the system temp directory (TMPDIR) is readable and that the process has file descriptors to spare, then reopen the session",
		);
		assert.ok(error.message.endsWith(error.hint));
	});

	it("names its subject for every code", () => {
		const subjects = SESSION_SPILL_ERROR_CODES.map(
			(code) => new SessionSpillError(code, fields).message.split(" (")[0],
		);
		assert.deepEqual(subjects, [
			"Could not use a directory for released sessions' history: /tmp/atomic-1000/memory-sessions-1-ab",
			"Could not move a released session's history out of memory: session s in /tmp/atomic-1000/memory-sessions-1-ab",
			"Could not read a released session's history: session s in /tmp/atomic-1000/memory-sessions-1-ab",
			"A released session's history is missing: session s in /tmp/atomic-1000/memory-sessions-1-ab, 0 of 120 bytes found",
			"Could not remove released sessions' history from disk: session s in /tmp/atomic-1000/memory-sessions-1-ab",
		]);
		assert.equal(
			new SessionSpillError("spill-cleanup-failed", { directory: "/d" }).message.split(" (")[0],
			"Could not remove released sessions' history from disk: /d",
		);
		assert.deepEqual(
			SESSION_SPILL_ERROR_CODES.map((code) => new SessionSpillError(code, fields).retryable),
			[false, false, true, false, false],
		);
	});

	it("carries a hint after its code for every code, and only the facts it was given", () => {
		for (const code of SESSION_SPILL_ERROR_CODES) {
			const error = new SessionSpillError(code, fields);
			assert.ok(error.hint.length > 40, `${code} has a hint`);
			assert.ok(error.message.endsWith(`(${code}). ${error.hint}`), code);
		}
		assert.deepEqual(Object.keys(new SessionSpillError("spill-dir-refused", { directory: "/d" })).sort(), [
			"code",
			"directory",
			"hint",
			"name",
			"retryable",
		]);
		assert.deepEqual(
			Object.keys(
				new SessionSpillError("spill-missing", {
					directory: "/d",
					sessionId: "s",
					bytes: 1,
					foundBytes: 0,
					errno: "ENOENT",
				}),
			).sort(),
			["bytes", "code", "directory", "errno", "foundBytes", "hint", "name", "retryable", "sessionId"],
		);
	});

	it("is retryable only for a read that met a filesystem failure that passes", () => {
		const retryable = (
			errno: string | undefined,
			code: (typeof SESSION_SPILL_ERROR_CODES)[number] = "spill-read-failed",
		) =>
			new SessionSpillError(code, { directory: "/d", sessionId: "s", ...(errno === undefined ? {} : { errno }) })
				.retryable;
		assert.deepEqual(
			["EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EINTR"].map((errno) => retryable(errno)),
			[true, true, true, true, true],
		);
		assert.deepEqual(
			["EIO", "EACCES", "ENOENT", undefined].map((errno) => retryable(errno)),
			[false, false, false, false],
		);
		assert.equal(retryable("EMFILE", "spill-write-failed"), false);
	});

	it("crosses a process boundary as the same class with its code, fields, hint, retryability and cause", () => {
		const original = new SessionSpillError(
			"spill-missing",
			{ directory: "/d", sessionId: "s", bytes: 120, foundBytes: 7, errno: "ENOENT" },
			{ cause: Object.assign(new Error("gone"), { code: "ENOENT" }) },
		);
		const rebuilt = rehydrateStorageError(JSON.parse(JSON.stringify(serializeStorageError(original))));
		assert.ok(rebuilt instanceof SessionSpillError);
		assert.equal(isSessionSpillError(rebuilt), true);
		for (const key of [
			"name",
			"code",
			"message",
			"hint",
			"retryable",
			"directory",
			"sessionId",
			"bytes",
			"foundBytes",
			"errno",
		])
			assert.deepEqual(rebuilt[key as keyof SessionSpillError], original[key as keyof SessionSpillError], key);
		assert.equal((rebuilt.cause as Error).message, "gone");

		const transient = new SessionSpillError("spill-read-failed", fields);
		const rebuiltTransient = rehydrateStorageError(serializeStorageError(transient));
		assert.equal(isRetryableStorageError(rebuiltTransient), true);
		assert.equal("cause" in rebuiltTransient, false);
		const unknownCode = rehydrateStorageError({ ...serializeStorageError(transient), code: "spill-later" });
		assert.ok(!(unknownCode instanceof SessionSpillError));
		assert.equal(unknownCode.name, "SessionSpillError");
		const bare = rehydrateStorageError({
			name: "SessionSpillError",
			code: "spill-missing",
			message: "m",
			fields: {},
		});
		assert.ok(bare instanceof SessionSpillError);
		assert.equal(bare.directory, "");
	});
});

/** Every write is followed by a release, so the conformance checks run against released sessions. */
function releasingAfterWrites(store: MemorySessionStore): SessionStore {
	return {
		get descriptor() {
			return store.descriptor;
		},
		create: async (recordHeader, list) => {
			const result = await store.create(recordHeader, list);
			await store.releaseSession(recordHeader.id);
			return result;
		},
		append: async (sessionId, list, options) => {
			const result = await store.append(sessionId, list, options);
			await store.releaseSession(sessionId);
			return result;
		},
		replace: async (sessionId, recordHeader, list, options) => {
			const result = await store.replace(sessionId, recordHeader, list, options);
			await store.releaseSession(sessionId);
			return result;
		},
		load: (sessionId) => store.load(sessionId),
		readHeader: (sessionId) => store.readHeader(sessionId),
		delete: (sessionId) => store.delete(sessionId),
		list: (query) => store.list(query),
		findMostRecent: (query) => store.findMostRecent(query),
		putBlob: (sessionId, data) => store.putBlob(sessionId, data),
		getBlob: (sessionId, hash) => store.getBlob(sessionId, hash),
		close: () => store.close(),
		releaseSession: (sessionId) => store.releaseSession(sessionId),
	};
}

registerSessionStoreConformance(
	{ describe, it },
	"MemorySessionStore released after every write (#4502)",
	async (body) => {
		let store = new MemorySessionStore(undefined, tempSessionHistoryFiles);
		const keeper = await store.reopen();
		try {
			await body({
				store: releasingAfterWrites(store),
				reopen: async () => {
					store = await store.reopen();
					return releasingAfterWrites(store);
				},
			});
			assert.deepEqual(store.spillDegradation(), []);
		} finally {
			await store.close().catch((error: Error) => assert.ok(error instanceof StoreClosedError));
			await keeper.close();
		}
	},
);
