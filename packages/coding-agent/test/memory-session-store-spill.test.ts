import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import type { CustomEntry } from "../src/core/session-manager-types.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
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
import { MemorySessionStore, SPILL_DIRECTORY_RETRY_MS } from "../src/core/storage/session/memory-session-store.js";
import {
	releasedHistoryDirectory,
	releasedHistoryFiles,
	sweepReleasedHistory,
} from "../src/core/storage/session/released-history-files.js";
import type { SessionStore } from "../src/core/storage/session/types.js";
import { setWindowsDirectorySecurityReaderForTesting } from "../src/core/tools/windows-directory-security.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: vi.fn(actual.open),
		readFile: vi.fn(actual.readFile),
		rm: vi.fn(actual.rm),
		mkdir: vi.fn(actual.mkdir),
		copyFile: vi.fn(actual.copyFile),
		rename: vi.fn(actual.rename),
	};
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});

const open = vi.mocked(fsPromises.open);
const readFile = vi.mocked(fsPromises.readFile);
const rm = vi.mocked(fsPromises.rm);
const mkdir = vi.mocked(fsPromises.mkdir);
const rename = vi.mocked(fsPromises.rename);
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
 * entries it holds to the session's file under the agent directory, a load reads that file once and adds what was
 * appended since, and an append writes nothing to disk. Operations are counted, not timed.
 */
const agentDir = useTemporaryAgentDir();
const files = releasedHistoryFiles(agentDir);

const opened: MemorySessionStore[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const mock of [open, readFile, rm, mkdir, rename]) mock.mockClear();
	for (const store of opened.splice(0)) await store.close().catch(() => undefined);
});

function newStore(): MemorySessionStore {
	const store = new MemorySessionStore(undefined, files);
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

/** Where released history is kept under an agent directory, spelled out so the tests pin it. */
const releasedHistoryUnder = (root: string) => join(root, "released-history");

/** The process directories under `root`'s released-history directory: `<host>/<pid>-<start>`, for every host. */
function processDirectories(root = agentDir): string[] {
	const released = releasedHistoryUnder(root);
	if (!existsSync(released)) return [];
	return readdirSync(released).flatMap((host) =>
		readdirSync(join(released, host)).map((name) => join(released, host, name)),
	);
}

/** The stores' directories in this process's directory under the agent directory, and the files in each. */
function spillDirectories(): Array<{ path: string; files: string[] }> {
	return processDirectories()
		.filter((directory) => directory.split(/[\\/]/).at(-1)?.startsWith(`${process.pid}-`))
		.flatMap((directory) =>
			readdirSync(directory).map((name) => ({
				path: join(directory, name),
				files: readdirSync(join(directory, name)),
			})),
		);
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

	test("an append after release writes nothing to disk, and the next release writes it after a copy of the file", async () => {
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
		readFile.mockClear();

		const written: number[] = [];
		open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			return {
				write: (data: Uint8Array, offset: number, length: number, position: number) => {
					written.push(length);
					return handle.write(data, offset, length, position);
				},
				close: () => handle.close(),
			} as unknown as fsPromises.FileHandle;
		});
		await store.releaseSession("s");
		assert.equal(open.mock.calls.length, 1);
		assert.deepEqual(written, [1 + entryBytes(later)], "only what was appended passes through memory");
		assert.equal(readFile.mock.calls.length, 0, "the history already on disk is copied, not read back");
		assert.deepEqual(store.historyBytes(), {
			inMemory: headerBytes("s"),
			onDisk: entryBytes(first) + 1 + entryBytes(later),
		});
		assert.deepEqual(spillFileSizes(), [entryBytes(first) + 1 + entryBytes(later)], "the file before it is removed");
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
		assert.deepEqual(store.spillDegradation(), []);

		const empty = newStore();
		await empty.create(header("empty"), []);
		await empty.releaseSession("empty");
		assert.equal(open.mock.calls.length, 0, "a session with no entries has nothing to move");
		assert.deepEqual(empty.spillDegradation(), []);

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

	test("a write cut short leaves no part of a file under a session's name, and the history before it stays whole", async () => {
		const store = newStore();
		const first = entries("a", 10);
		await created(store, "s", first);
		await store.releaseSession("s");
		const [{ path }] = spillDirectories();
		const later = entries("b", 2);
		await store.append("s", later, { expectSeq: 10 });
		vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		let stop!: () => void;
		const stopped = new Promise<void>((resolve) => {
			stop = resolve;
		});
		// The write stops after part of its data, as it would where the process is killed in the middle of it.
		open.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			return {
				write: async (data: Uint8Array, offset: number, length: number, position: number) => {
					await handle.write(data, offset, Math.min(length, 10), position);
					await stopped;
					throw Object.assign(new Error("I/O error"), { code: "EIO" });
				},
				close: () => handle.close(),
			} as unknown as fsPromises.FileHandle;
		});
		const named = () =>
			readdirSync(path)
				.filter((name) => /^[0-9]+$/.test(name))
				.map((name) => statSync(join(path, name)).size);
		const releasing = store.releaseSession("s");
		await vi.waitFor(() => assert.ok(readdirSync(path).some((name) => name.endsWith(".partial"))));
		assert.deepEqual(named(), [entryBytes(first)], "while it writes, only complete files have a session file's name");
		stop();
		await releasing;
		assert.deepEqual(readdirSync(path).length, 1, "the part written is removed");
		assert.deepEqual(named(), [entryBytes(first)]);
		assert.deepEqual((await store.load("s")).entries, [...first, ...later]);
		await store.releaseSession("s");
		assert.deepEqual(spillFileSizes(), [entryBytes(first) + 1 + entryBytes(later)]);
		assert.deepEqual((await store.load("s")).entries, [...first, ...later]);
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

	test("a load whose file a release replaced while it waited to read it reads the new file", async () => {
		const store = newStore();
		const first = entries("a", 5);
		await created(store, "s", first);
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
		const later = entries("b", 2);
		await store.append("s", later, { expectSeq: 5 });
		await store.releaseSession("s");
		reading();
		assert.deepEqual((await loading).entries, [...first, ...later]);
		assert.equal(readFile.mock.calls.length, 2, "the replaced file, then the new one");
	});

	test("the history is under the agent directory, in a directory named for this process, owner-only, and removed when the last handle closes", async () => {
		const store = new MemorySessionStore(undefined, files);
		await created(store, "s", entries("e", 5));
		await store.releaseSession("s");
		const [{ path, files: names }] = spillDirectories();
		const processDirectory = join(path, "..");
		const [pid, start] = (processDirectory.split(/[\\/]/).at(-1) as string).split("-");
		assert.equal(join(processDirectory, "..", ".."), releasedHistoryUnder(agentDir));
		assert.equal(releasedHistoryDirectory(agentDir), releasedHistoryUnder(agentDir));
		assert.equal(Number(pid), process.pid);
		if (process.platform === "linux") {
			const stat = fs.readFileSync("/proc/self/stat", "utf8");
			assert.equal(start, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], "the start time the kernel gives");
		} else assert.match(start as string, /^[A-Za-z0-9]+$/);
		if (process.platform !== "win32") {
			assert.equal(statSync(processDirectory).mode & 0o777, 0o700);
			assert.equal(statSync(path).mode & 0o777, 0o700);
			assert.equal(statSync(join(path, names[0] as string)).mode & 0o777, 0o600);
		}

		const reopened = await store.reopen();
		await store.close();
		assert.ok(existsSync(path), "a handle reopen() made keeps the directory");
		assert.deepEqual((await reopened.load("s")).entries, entries("e", 5));
		await assert.rejects(store.load("s"), (error: Error) => error instanceof StoreClosedError);

		await reopened.close();
		assert.equal(existsSync(path), false);
		assert.equal(existsSync(processDirectory), false, "the process's directory goes with its last store");
		assert.deepEqual(reopened.spillDegradation(), []);
	});

	test("a directory left by a store never closed is removed at exit, by one listener for the whole process", async () => {
		const listening = () =>
			process.listeners("exit").filter((listener) => listener.toString().includes("usedProcessDirectories"));
		const before = listening();
		vi.resetModules();
		const fresh = await import("../src/core/storage/session/released-history-files.js");
		const first = new MemorySessionStore(undefined, fresh.releasedHistoryFiles(agentDir));
		const second = new MemorySessionStore(undefined, fresh.releasedHistoryFiles(agentDir));
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
		const store = new MemorySessionStore(undefined, files);
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

		const unused = new MemorySessionStore(undefined, files);
		await created(unused, "u", entries("u", 2));
		await unused.close();
		assert.deepEqual(unused.spillDegradation(), []);
		assert.equal(rm.mock.calls.length, 1, "only the directory that was written is removed");
	});

	test("a directory something else already removed is not a cleanup failure", async () => {
		const store = new MemorySessionStore(undefined, files);
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
		const store = new MemorySessionStore(undefined, files);
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

	test("a same-length edit that remains valid JSON is detected after repeated releases", async () => {
		const store = newStore();
		await created(store, "s", [entry("first", "1234")]);
		await store.releaseSession("s");
		await store.append("s", [entry("later", "5678")], { expectSeq: 1 });
		await store.releaseSession("s");
		const [{ path, files: names }] = spillDirectories();
		const file = join(path, names[0] as string);
		const original = fs.readFileSync(file, "utf8");
		const changed = original.replace("1234", "9999");
		assert.notEqual(changed, original);
		assert.equal(changed.length, original.length);
		assert.doesNotThrow(() => JSON.parse(`[${changed}]`));
		writeFileSync(file, changed);
		await assert.rejects(
			store.load("s"),
			(error: Error) => isSessionSpillError(error) && error.code === "spill-corrupt",
		);
	});

	test("a file whose content was changed fails the load with spill-corrupt, a typed storage error", async () => {
		const store = newStore();
		const history = entries("e", 10);
		await created(store, "s", history);
		await store.releaseSession("s");
		const [{ path, files: names }] = spillDirectories();
		const file = join(path, names[0] as string);

		writeFileSync(file, "}".repeat(entryBytes(history)));
		const changed = await store.load("s").then(
			() => assert.fail("the load succeeded"),
			(error: Error) => error,
		);
		assert.ok(isSessionSpillError(changed));
		assert.equal(isStorageError(changed), true);
		assert.equal(changed.code, "spill-corrupt");
		assert.equal(changed.sessionId, "s");
		assert.equal(changed.directory, path);
		assert.equal(changed.bytes, entryBytes(history));
		assert.equal(changed.retryable, false);
		assert.ok(changed.cause instanceof SyntaxError);

		writeFileSync(file, `${JSON.stringify(history).slice(1, -1)},{}`);
		await assert.rejects(store.load("s"), (error: Error) => {
			assert.ok(isSessionSpillError(error));
			assert.equal(error.code, "spill-corrupt");
			assert.equal(error.foundBytes, entryBytes(history) + 3);
			return true;
		});
	});

	test("a listing leaves out a session whose history is lost, and records each such session once", async () => {
		const store = newStore();
		for (const id of ["missing", "changed", "kept"]) await created(store, id, entries(id, 4));
		await store.create(header("live"), entries("live", 2));
		for (const id of ["missing", "changed", "kept"]) await store.releaseSession(id);
		const [{ path, files: names }] = spillDirectories();
		const [missing, changed] = names.sort((a, b) => Number(a) - Number(b));
		rmSync(join(path, missing as string));
		writeFileSync(join(path, changed as string), "}".repeat(entryBytes(entries("changed", 4))));
		const warnings: Error[] = [];
		vi.spyOn(process, "emitWarning").mockImplementation((warning: string | Error) => {
			warnings.push(warning as Error);
		});

		const listed = async () => {
			const ids: string[] = [];
			for await (const summary of store.list({})) ids.push(summary.id);
			return ids;
		};
		assert.deepEqual(await listed(), ["kept", "live"]);
		assert.deepEqual(await listed(), ["kept", "live"]);
		assert.ok(["kept", "live"].includes((await store.findMostRecent({ cwd: "/repo" }))?.id as string));
		const recorded = store.spillDegradation().map((error) => [error.code, error.sessionId, error.directory]);
		assert.deepEqual(recorded, [
			["spill-missing", "missing", path],
			["spill-corrupt", "changed", path],
		]);
		assert.deepEqual(warnings, store.spillDegradation(), "each session is reported once");
		await assert.rejects(store.load("missing"), (error: Error) => isSessionSpillError(error));
		await store.delete("missing");
		assert.equal(store.spillDegradation().length, 2, "deleting a session whose file is gone is not a failure");
	});

	test("a session deleted while its first release creates the store's directory has nothing written", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 3));
		let resume!: () => void;
		const held = new Promise<void>((resolve) => {
			resume = resolve;
		});
		mkdir.mockImplementationOnce(async (...args: Parameters<typeof actual.mkdir>) => {
			await held;
			return actual.mkdir(...args);
		});
		open.mockClear();
		mkdir.mockClear();
		const releasing = store.releaseSession("s");
		await vi.waitFor(() => assert.ok(mkdir.mock.calls.length > 0));
		const deleting = store.delete("s");
		resume();
		await Promise.all([releasing, deleting]);
		assert.equal(open.mock.calls.length, 0);
		assert.deepEqual(spillFileSizes(), []);
		assert.deepEqual(store.spillDegradation(), []);
	});

	test("a listing that meets a read failure that passes fails with it, so it can be tried again", async () => {
		const store = newStore();
		await created(store, "s", entries("e", 3));
		await store.releaseSession("s");
		readFile.mockRejectedValueOnce(Object.assign(new Error("EMFILE"), { code: "EMFILE" }));
		const listed = async () => {
			const ids: string[] = [];
			for await (const summary of store.list({})) ids.push(summary.id);
			return ids;
		};
		await assert.rejects(listed(), (error: Error) => {
			assert.ok(isSessionSpillError(error));
			assert.equal(error.code, "spill-read-failed");
			assert.equal(isRetryableStorageError(error), true);
			return true;
		});
		assert.deepEqual(store.spillDegradation(), []);
		assert.deepEqual(await listed(), ["s"]);
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
		const store = new MemorySessionStore(undefined, files);
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

	test("a location that cannot hold the files keeps history in memory as spill-dir-refused, and is tried again no more than once a minute", async () => {
		const blocked = join(agentDir, "blocked-agent");
		writeFileSync(blocked, "");
		const store = new MemorySessionStore(undefined, releasedHistoryFiles(blocked));
		opened.push(store);
		for (let index = 0; index < 4; index++) await created(store, `s${index}`, entries(`e${index}`, 3));
		const warnings: Error[] = [];
		vi.spyOn(process, "emitWarning").mockImplementation((warning: string | Error) => {
			warnings.push(warning as Error);
		});
		let securityChecks = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			securityChecks += 1;
			return undefined;
		});
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		mkdir.mockClear();
		try {
			for (let round = 0; round < 10; round++)
				for (let index = 0; index < 4; index++) await store.releaseSession(`s${index}`);
			assert.equal(mkdir.mock.calls.length, 1, "40 releases within a minute ask for the directory once");
			const [degradation, ...others] = store.spillDegradation();
			assert.deepEqual(others, []);
			assert.equal(degradation?.code, "spill-dir-refused");
			assert.equal(degradation?.sessionId, undefined);
			assert.ok(degradation?.directory.startsWith(releasedHistoryUnder(blocked)));
			assert.ok(typeof degradation?.errno === "string");
			assert.deepEqual(warnings, [degradation]);
			assert.equal(store.historyBytes().onDisk, 0, "every history stays in memory");

			clock.mockReturnValue(now + SPILL_DIRECTORY_RETRY_MS - 1);
			await store.releaseSession("s0");
			assert.equal(mkdir.mock.calls.length, 1);
			clock.mockReturnValue(now + SPILL_DIRECTORY_RETRY_MS);
			await store.releaseSession("s0");
			await store.releaseSession("s1");
			assert.equal(mkdir.mock.calls.length, 2, "a minute later, one release asks again");

			rmSync(blocked);
			clock.mockReturnValue(now + 2 * SPILL_DIRECTORY_RETRY_MS);
			for (let index = 0; index < 4; index++) await store.releaseSession(`s${index}`);
			assert.equal(store.historyBytes().inMemory, 4 * headerBytes("s0"), "once it can, a release writes");
			assert.equal(warnings.length, 1, "the refusal is reported once");
			assert.equal(securityChecks, 0, "no release runs an ownership check");
		} finally {
			setWindowsDirectorySecurityReaderForTesting(undefined);
		}
	});

	test("across many stores and releases, boot identity and the process's start time are read once and its directory created once", async () => {
		vi.resetModules();
		const fresh = await import("../src/core/storage/session/released-history-files.js");
		const freshFs = vi.mocked(await import("node:fs"));
		const freshChildProcess = vi.mocked(await import("node:child_process"));
		const freshPromises = vi.mocked(await import("node:fs/promises"));
		for (const mock of [freshFs.readFileSync, freshChildProcess.execFile, freshPromises.mkdir]) mock.mockClear();
		let securityChecks = 0;
		setWindowsDirectorySecurityReaderForTesting(() => {
			securityChecks += 1;
			return undefined;
		});
		const counted = join(agentDir, "counted");
		const stores = Array.from(
			{ length: 20 },
			() => new MemorySessionStore(undefined, fresh.releasedHistoryFiles(counted)),
		);
		opened.push(...stores);
		try {
			for (const [index, store] of stores.entries())
				for (let session = 0; session < 5; session++) {
					await created(store, `s${session}`, entries(`e${index}-${session}`, 2));
					await store.releaseSession(`s${session}`);
				}
			// Boot identity and process start time each launch their own command on Windows and macOS.
			const bootIdentityLookups =
				freshFs.readFileSync.mock.calls.filter(([path]) => String(path) === "/proc/sys/kernel/random/boot_id")
					.length +
				freshChildProcess.execFile.mock.calls.filter(
					([command, args]) =>
						Array.isArray(args) &&
						(args.includes(
							"(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToFileTimeUtc()",
						) ||
							(command === "sysctl" && args.join(" ") === "-n kern.boottime")),
				).length;
			const startTimeLookups =
				freshFs.readFileSync.mock.calls.filter(([path]) => String(path) === `/proc/${process.pid}/stat`).length +
				freshChildProcess.execFile.mock.calls.filter(
					([command, args]) =>
						Array.isArray(args) &&
						(args.includes(`(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`) ||
							(command === "ps" && args.join(" ") === `-o lstart= -p ${process.pid}`)),
				).length;
			assert.equal(bootIdentityLookups, 1);
			assert.equal(startTimeLookups, 1);
			assert.equal(freshPromises.mkdir.mock.calls.length, 1 + stores.length, "the process's, then one per store");
			assert.equal(securityChecks, 0);
			assert.deepEqual(
				stores.map((store) => store.historyBytes().onDisk > 0),
				stores.map(() => true),
			);
		} finally {
			setWindowsDirectorySecurityReaderForTesting(undefined);
		}
	});
});

const FIXTURE = fileURLToPath(new URL("./fixtures/released-history-host.ts", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
/** Loading the store through jiti in a new process, then a release: structural, not a slow test. */
const HOST_TIMEOUT_MS = 60_000;
/** Two startup sweeps plus process identity lookups on Windows need setup headroom beyond their removal deadlines. */
const STARTUP_SWEEP_TEST_TIMEOUT_MS = 60_000;
const DIRECTORY_REMOVAL_TIMEOUT_MS = 20_000;
const DIRECTORY_REMOVAL_POLL_MS = 250;

/** Starts a process that releases a session into a store over `root` (see the fixture), once it has printed `ready`. */
async function startHost(root: string, mode: string, ready: string) {
	const child = childProcess.spawn(process.execPath, ["--import", "jiti/register", FIXTURE, root, mode], {
		cwd: REPOSITORY,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.on("exit", (code, signal) => resolve({ code, signal })),
	);
	let output = "";
	let errors = "";
	child.stderr.on("data", (chunk: Buffer) => {
		errors += chunk.toString();
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes(ready)) resolve();
		});
		child.on("exit", () => reject(new Error(`the host ended before it printed ${ready}: ${errors}`)));
	});
	return { child, ended };
}

/** Files at any depth under `directory`. */
const filesUnder = (directory: string): string[] =>
	readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));

/** Observe removal before starting a background sweep; completion, not a one-second polling budget, is the signal. */
async function afterDirectoryRemoval<T>(path: string, start: () => T | Promise<T>): Promise<T> {
	let watcher: fs.FSWatcher | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	const removed = new Promise<void>((resolve, reject) => {
		const check = () => {
			if (!existsSync(path)) resolve();
		};
		watcher = fs.watch(dirname(path), check);
		watcher.on("error", reject);
		check();
		poll = setInterval(check, DIRECTORY_REMOVAL_POLL_MS);
		timeout = setTimeout(() => {
			if (!existsSync(path)) resolve();
			else reject(new Error(`startup sweep did not remove ${path}`));
		}, DIRECTORY_REMOVAL_TIMEOUT_MS);
	});
	try {
		const [result] = await Promise.all([start(), removed]);
		return result;
	} finally {
		watcher?.close();
		clearTimeout(timeout);
		clearInterval(poll);
	}
}

describe("directory-removal observation (#4519)", () => {
	test("an already-absent target resolves without waiting for a notification", async () => {
		mkdirSync(agentDir, { recursive: true });
		vi.useFakeTimers();
		let completed = false;
		const removal = afterDirectoryRemoval(join(agentDir, "already-absent"), () => "started").then((result) => {
			assert.equal(result, "started");
			completed = true;
		});
		const settled = removal.catch(() => undefined);
		try {
			await vi.advanceTimersByTimeAsync(0);
			assert.equal(completed, true);
		} finally {
			await vi.advanceTimersByTimeAsync(DIRECTORY_REMOVAL_TIMEOUT_MS);
			await settled;
			vi.useRealTimers();
		}
	});

	test("polling observes removal when watcher notifications are suppressed", async () => {
		const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
		vi.spyOn(fs, "watch").mockImplementationOnce((path) => actualFs.watch(path, () => undefined));
		const target = join(agentDir, "unnotified-removal");
		mkdirSync(target, { recursive: true });
		vi.useFakeTimers();
		let completed = false;
		const removal = afterDirectoryRemoval(target, () => rmSync(target, { recursive: true })).then(() => {
			completed = true;
		});
		const settled = removal.catch(() => undefined);
		try {
			await vi.advanceTimersByTimeAsync(DIRECTORY_REMOVAL_POLL_MS);
			assert.equal(completed, true);
		} finally {
			await vi.advanceTimersByTimeAsync(DIRECTORY_REMOVAL_TIMEOUT_MS);
			await settled;
			vi.useRealTimers();
		}
	});
});

describe("released history outlives no process, except one killed, until the next sweep (#4502)", () => {
	test(
		"a sweep removes what processes that are gone left, and keeps what a process that may run holds",
		async () => {
			const root = join(agentDir, "sweep");
			const store = new MemorySessionStore(undefined, releasedHistoryFiles(root));
			opened.push(store);
			await created(store, "s", entries("e", 2));
			await store.releaseSession("s");
			const [own] = processDirectories(root) as [string];
			const host = join(own, "..");
			const gonePid = childProcess.spawnSync(process.execPath, ["-e", ""]).pid;
			const plant = (name: string) => {
				mkdirSync(join(host, name, "store"), { recursive: true });
				writeFileSync(join(host, name, "store", "1"), "{}");
				return join(host, name);
			};
			const gone = plant(`${gonePid}-1`);
			const pidReused = plant(`${process.ppid}-1`);
			const earlierOwnPid = plant(`${process.pid}-1`);
			const startUnknown = plant(`${process.ppid}-unknown`);
			const notCreatedHere = [plant("notes"), plant("0-1"), plant(`a${gonePid}-1`), plant(`${gonePid}-1.keep`)];
			const parentStart = (() => {
				if (process.platform !== "linux") return [];
				const stat = fs.readFileSync(`/proc/${process.ppid}/stat`, "utf8");
				return [plant(`${process.ppid}-${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`)];
			})();

			await sweepReleasedHistory(root);

			assert.deepEqual(
				[gone, pidReused, earlierOwnPid].filter((path) => existsSync(path)),
				[],
				"no process has that pid, or has it with another start time",
			);
			assert.deepEqual(
				[own, startUnknown, ...parentStart, ...notCreatedHere].filter((path) => existsSync(path)),
				[own, startUnknown, ...parentStart, ...notCreatedHere],
			);
			assert.deepEqual((await store.load("s")).entries, entries("e", 2));

			const opening = join(agentDir, "sweep-on-open");
			const left = join(releasedHistoryUnder(opening), basename(host), `${process.pid}-1`);
			mkdirSync(left, { recursive: true });
			const memory = await afterDirectoryRemoval(left, () =>
				new StorageProvider().openSessionStore({ kind: "memory" }, { agentDir: opening, domain: "sessions" }),
			);
			assert.equal(existsSync(left), false, "opening a store sweeps its agent directory");
			await memory.close();

			const resolving = join(agentDir, "sweep-on-resolve");
			const leftThere = join(releasedHistoryUnder(resolving), basename(host), `${process.pid}-1`);
			mkdirSync(leftThere, { recursive: true });
			const sessions = await afterDirectoryRemoval(leftThere, () =>
				resolveSessionStore(resolving, {
					agentDir: resolving,
					sessionStore: { kind: "jsonl", dir: join(resolving, "sessions") },
				}),
			);
			assert.equal(existsSync(leftThere), false, "resolving any session store at startup sweeps it too");
			await sessions.close();
		},
		STARTUP_SWEEP_TEST_TIMEOUT_MS,
	);

	test(
		"a process killed with SIGKILL leaves its directory, and the next process to open a store there removes it",
		async () => {
			const root = join(agentDir, "killed");
			const { child, ended } = await startHost(root, "wait", "released");
			const [left] = processDirectories(root) as [string];
			assert.equal(filesUnder(left).length, 1);
			child.kill("SIGKILL");
			await ended;
			assert.equal(filesUnder(left).length, 1, "nothing runs in a killed process");
			assert.ok(filesUnder(left).every((file) => !file.endsWith(".partial")));

			await afterDirectoryRemoval(left, () => releasedHistoryFiles(root));
			assert.equal(existsSync(left), false);
		},
		HOST_TIMEOUT_MS,
	);

	test.skipIf(process.platform === "win32")(
		"a host whose SIGTERM handler ends it with process.exit(), as Atomic's own do, leaves nothing",
		async () => {
			const root = join(agentDir, "terminated");
			const { child, ended } = await startHost(root, "exit-on-sigterm", "released");
			assert.equal(processDirectories(root).length, 1);
			child.kill("SIGTERM");
			assert.equal((await ended).code, 143);
			assert.deepEqual(processDirectories(root), []);
		},
		HOST_TIMEOUT_MS,
	);

	for (const mode of ["workers-exit", "workers-sigterm", "workers-terminate", "workers-late-import"]) {
		test.skipIf(process.platform === "win32" && mode === "workers-sigterm")(
			`main-thread exit cleans worker-only stores: ${mode}`,
			async () => {
				const root = join(agentDir, mode);
				const { ended } = await startHost(root, mode, "all released");
				assert.equal((await ended).code, mode === "workers-sigterm" ? 143 : 0);
				assert.deepEqual(processDirectories(root), []);
			},
			HOST_TIMEOUT_MS,
		);
	}

	test(
		"worker-only SDK imports never wait for a main listener; the next sweep cleans terminated workers",
		async () => {
			const root = join(agentDir, "worker-no-listener");
			const { ended } = await startHost(root, "worker-no-listener", "all released");
			assert.equal((await ended).code, 0);
			await sweepReleasedHistory(root);
			assert.deepEqual(processDirectories(root), []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a worker thread removes its stores' directories when it ends by itself",
		async () => {
			const root = join(agentDir, "worker");
			const { child, ended } = await startHost(root, "worker", "worker exited");
			assert.deepEqual(processDirectories(root), []);
			assert.ok(existsSync(releasedHistoryUnder(root)), "the worker did release into it");
			child.kill("SIGKILL");
			await ended;
		},
		HOST_TIMEOUT_MS,
	);
});

describe("SessionSpillError (#4502)", () => {
	const directory = "/home/u/.atomic/agent/released-history/host/1-2/ab";
	const fields = { directory, sessionId: "s", bytes: 120, errno: "EMFILE" };

	it("is a storage error with a stable code, a hint, and a guard that recognizes copies", () => {
		const error = new SessionSpillError("spill-read-failed", fields, { cause: new Error("too many open files") });
		assert.ok(error instanceof SessionSpillError);
		assert.equal(error.name, "SessionSpillError");
		assert.equal(isStorageError(error), true);
		assert.equal(isSessionSpillError({ name: "SessionSpillError", code: "spill-missing" }), true);
		assert.equal(isSessionSpillError({ name: "SessionSpillError", code: "spill-corrupt" }), true);
		assert.equal(isSessionSpillError({ name: "SessionSpillError", code: "spill-unknown" }), false);
		assert.equal(isSessionSpillError({ name: "SessionBlobError", code: "spill-missing" }), false);
		assert.equal(isSessionSpillError(undefined), false);
		assert.deepEqual(SESSION_SPILL_ERROR_CODES, [
			"spill-dir-refused",
			"spill-write-failed",
			"spill-read-failed",
			"spill-missing",
			"spill-corrupt",
			"spill-cleanup-failed",
		]);
		assert.equal(
			error.message,
			`Could not read a released session's history: session s in ${directory} (spill-read-failed). Check that the agent directory is readable and that the process has file descriptors to spare, then reopen the session`,
		);
		assert.ok(error.message.endsWith(error.hint));
	});

	it("names its subject for every code", () => {
		const subjects = SESSION_SPILL_ERROR_CODES.map(
			(code) => new SessionSpillError(code, fields).message.split(" (")[0],
		);
		assert.deepEqual(subjects, [
			`Could not use a directory for released sessions' history: ${directory}`,
			`Could not move a released session's history out of memory: session s in ${directory}`,
			`Could not read a released session's history: session s in ${directory}`,
			`A released session's history is missing: session s in ${directory}, 0 of 120 bytes found`,
			`A released session's history was changed on disk: session s in ${directory}`,
			`Could not remove released sessions' history from disk: session s in ${directory}`,
		]);
		assert.equal(
			new SessionSpillError("spill-cleanup-failed", { directory: "/d" }).message.split(" (")[0],
			"Could not remove released sessions' history from disk: /d",
		);
		assert.deepEqual(
			SESSION_SPILL_ERROR_CODES.map((code) => new SessionSpillError(code, fields).retryable),
			[false, false, true, false, false, false],
		);
	});

	it("carries a hint after its code for every code, and only the facts it was given", () => {
		for (const code of SESSION_SPILL_ERROR_CODES) {
			const error = new SessionSpillError(code, fields);
			assert.ok(error.hint.length > 40, `${code} has a hint`);
			assert.ok(error.message.endsWith(`(${code}). ${error.hint}`), code);
			assert.doesNotMatch(error.hint, /TMPDIR|TEMP|temp directory/, `${code} names no temp directory variable`);
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
		let store = new MemorySessionStore(undefined, files);
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
