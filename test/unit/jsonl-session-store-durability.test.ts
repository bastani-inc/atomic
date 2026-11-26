import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import * as fileSync from "../../packages/coding-agent/src/core/storage/file-sync.js";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	JsonlSessionStore,
	JsonlStoragePoisonedError,
} from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import type { ForkArchiveSource } from "../../packages/coding-agent/src/core/storage/session/types.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

vi.mock("../../packages/coding-agent/src/core/storage/file-sync.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/coding-agent/src/core/storage/file-sync.js")>()),
}));

const CREATED_AT = "2026-11-26T00:00:00.000Z";
const header = (id: string) => ({ id, version: 4 as const, createdAt: CREATED_AT, cwd: "/project" });
function message(id: string, parentId: string | null = null, content = `text of ${id}`): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: CREATED_AT,
		message: { role: "user", content, timestamp: 1 },
	} as SessionEntry;
}

/** The path each handle opened while syncs were counted was opened on, as a kept handle outlives one count. */
const paths = new WeakMap<object, string>();

/**
 * Every sync the store makes through `file-sync` while `work` runs (covering native `fsyncDescriptor` on macOS as well
 * as `FileHandle.datasync`/`sync` elsewhere), as the path synced. `gate` runs in place of each sync so a test can hold
 * or fail it.
 */
async function syncs<T>(
	work: () => Promise<T>,
	gate: (path: string, sync: () => Promise<void>) => Promise<void> = (_path, sync) => sync(),
): Promise<{ result: T; synced: string[] }> {
	const originalOpen = fs.open;
	const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await originalOpen(...args);
		paths.set(handle, String(args[0]));
		return handle;
	});
	const originalSyncFile = fileSync.syncFile;
	const originalSyncDirectory = fileSync.syncDirectory;
	const originalSyncPath = fileSync.syncPath;
	const synced: string[] = [];
	const syncFileSpy = vi.spyOn(fileSync, "syncFile").mockImplementation(async (handle) => {
		const path = paths.get(handle) ?? "?";
		synced.push(path);
		await gate(path, () => originalSyncFile(handle));
	});
	const syncDirSpy = vi.spyOn(fileSync, "syncDirectory").mockImplementation(async (dirPath) => {
		if (process.platform === "win32") return;
		synced.push(dirPath);
		await gate(dirPath, () => originalSyncDirectory(dirPath));
	});
	const syncPathSpy = vi.spyOn(fileSync, "syncPath").mockImplementation(async (filePath, handle, writable) => {
		synced.push(filePath);
		await gate(filePath, () => originalSyncPath(filePath, handle, writable));
	});
	try {
		return { result: await work(), synced };
	} finally {
		syncPathSpy.mockRestore();
		syncDirSpy.mockRestore();
		syncFileSpy.mockRestore();
		opened.mockRestore();
	}
}

describe("JSONL session store durability (#6686)", () => {
	let directory: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "jsonl-durability-"));
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("acknowledges an append only once a sync of its session file has finished", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header("held"), []);
			const path = (await store.findFile("held"))!;
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let syncing!: () => void;
			const started = new Promise<void>((resolve) => {
				syncing = resolve;
			});
			let acknowledged = false;
			const { synced } = await syncs(
				async () => {
					const append = store.append("held", [message("a")], { expectSeq: 0 }).then((result) => {
						acknowledged = true;
						return result;
					});
					await Promise.race([started, append]);
					assert.equal(acknowledged, false, "acknowledged before any sync");
					// The lines are in the file, but the sync that covers them has not finished.
					assert.match(await readFile(path, "utf8"), /"id":"a"/);
					await new Promise((resolve) => setTimeout(resolve, 20));
					assert.equal(acknowledged, false);
					release();
					assert.deepEqual(await append, { lastSeq: 1 });
				},
				async (syncedPath, sync) => {
					if (syncedPath === path) {
						syncing();
						await held;
					}
					await sync();
				},
			);
			assert.deepEqual(synced, [path]);
		} finally {
			await store.close();
		}
	});

	it("syncs appends made together once, and appends made in turn once each", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header("group"), []);
			const path = (await store.findFile("group"))!;
			const together = await syncs(() =>
				Promise.all(
					Array.from({ length: 10 }, (_, index) =>
						store.append("group", [message(`together-${index}`)], { expectSeq: index }),
					),
				),
			);
			assert.deepEqual(
				together.result.map(({ lastSeq }) => lastSeq),
				[1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			);
			assert.deepEqual(together.synced, [path]);
			const inTurn = await syncs(async () => {
				for (let index = 0; index < 3; index++)
					await store.append("group", [message(`turn-${index}`)], { expectSeq: 10 + index });
			});
			assert.deepEqual(inTurn.synced, [path, path, path]);
		} finally {
			await store.close();
		}
	});

	/**
	 * The syncs a new session file needs to last a crash: its bytes before its name is linked or renamed into place, then
	 * the directory that holds the name. Windows cannot open a directory to sync it.
	 */
	function assertPlacedDurably(synced: readonly string[], path: string): void {
		assert.equal(synced.length, process.platform === "win32" ? 1 : 2, synced.join("\n"));
		assert.ok(synced[0]!.startsWith(`${path}.`) && synced[0]!.endsWith(".tmp"), synced[0]);
		if (process.platform !== "win32") assert.equal(synced[1], directory);
	}

	/** Syncs as {@link syncs} does, checking that the directory is synced only once the session file is at `path`. */
	function directoryAfter(path: () => string) {
		return async (syncedPath: string, sync: () => Promise<void>) => {
			if (syncedPath === directory) assert.ok(existsSync(path()), "directory synced before the file was placed");
			await sync();
		};
	}

	it("syncs a created session's file before linking it, and its directory after", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			const path = store.locationFor(header("created"));
			const { synced } = await syncs(
				() => store.create(header("created"), [message("a")]),
				directoryAfter(() => path),
			);
			assertPlacedDurably(synced, path);
			assert.deepEqual(readdirSync(directory), [basename(path)]);
		} finally {
			await store.close();
		}
	});

	it("syncs a replaced session's file before renaming it into place, and its directory after", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header("replaced"), [message("a")]);
			const path = (await store.findFile("replaced"))!;
			const replaced = await syncs(
				() => store.replace("replaced", header("replaced"), [message("b")], { expectSeq: 1 }),
				directoryAfter(() => path),
			);
			assertPlacedDurably(replaced.synced, path);
			const renamed = await syncs(
				() => store.updateHeader({ ...header("replaced"), parentSessionId: "parent" }, { expectSeq: 1 }),
				directoryAfter(() => path),
			);
			assertPlacedDurably(renamed.synced, path);
			assert.equal((await store.load("replaced")).header.parentSessionId, "parent");
		} finally {
			await store.close();
		}
	});

	it("syncs a forked session's file before linking it, and its directory after", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			const path = store.locationFor(header("fork"));
			const source: ForkArchiveSource = { store, sessionId: "source", hashes: [], receipts: new Map() };
			const { synced, result } = await syncs(
				() => store.createFork(header("fork"), [message("a"), message("b")], source),
				directoryAfter(() => path),
			);
			assert.equal(result?.lastSeq, 2);
			assertPlacedDurably(synced, path);
			assert.deepEqual(readdirSync(directory).sort(), [basename(path), `${basename(path)}.idx`].sort());
		} finally {
			await store.close();
		}
	});

	it("rejects every append of a group whose sync fails, and cuts its lines back off the file", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header("failing"), [message("kept")]);
			const path = (await store.findFile("failing"))!;
			const before = await readFile(path, "utf8");
			let failed = false;
			const { result } = await syncs(
				() =>
					Promise.allSettled([
						store.append("failing", [message("lost-1")], { expectSeq: 1 }),
						store.append("failing", [message("lost-2")], { expectSeq: 2 }),
					]),
				async (syncedPath, sync) => {
					if (syncedPath === path && !failed) {
						failed = true;
						throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
					}
					await sync();
				},
			);
			for (const outcome of result) {
				assert.equal(outcome.status, "rejected");
				assert.ok(outcome.reason instanceof StorageUnavailableError, String(outcome.reason));
			}
			assert.equal(await readFile(path, "utf8"), before);
			assert.deepEqual(await store.append("failing", [message("next")], { expectSeq: 1 }), { lastSeq: 2 });
			assert.deepEqual(
				(await store.load("failing")).entries.map((entry) => entry.id),
				["kept", "next"],
			);
		} finally {
			await store.close();
		}
	});

	it.skipIf(process.platform === "win32")(
		"exposes native plain fsyncDescriptor on Unix and skips Node FileHandle sync/datasync on macOS (#6686, #6717)",
		async () => {
			const { fsyncDescriptor } = await import("@bastani/atomic-natives");
			const probe = join(directory, "native-sync.txt");
			await writeFile(probe, "hello\n");
			const handle = await fs.open(probe, "r+");
			try {
				await fsyncDescriptor(handle.fd);
			} finally {
				await handle.close();
			}
			await assert.rejects(fsyncDescriptor(-1), /fsync:/);

			if (process.platform === "darwin" && fileSync.usesNativePlainSync()) {
				const handleProbe = await fs.open(fileURLToPath(import.meta.url), "r");
				const prototype = Object.getPrototypeOf(handleProbe) as {
					sync: (this: fs.FileHandle) => Promise<void>;
					datasync: (this: fs.FileHandle) => Promise<void>;
				};
				await handleProbe.close();
				const nodeSync = vi.spyOn(prototype, "sync");
				const nodeDatasync = vi.spyOn(prototype, "datasync");
				const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
				try {
					await store.create(header("mac-plain"), [message("a")]);
					await store.append("mac-plain", [message("b", "a")], { expectSeq: 1 });
					await store.replace("mac-plain", header("mac-plain"), [message("c")], { expectSeq: 2 });
					assert.equal(nodeSync.mock.calls.length, 0, "macOS must not call Node's F_FULLFSYNC FileHandle.sync");
					assert.equal(
						nodeDatasync.mock.calls.length,
						0,
						"macOS must not call Node's F_FULLFSYNC FileHandle.datasync",
					);
				} finally {
					nodeSync.mockRestore();
					nodeDatasync.mockRestore();
					await store.close();
				}
			}
		},
	);

	it("recovers valid entries before a zero-filled corrupt mid-file line and removes the tail on next append (#6717)", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		try {
			const e1 = message("e1", null, "first committed");
			const e2 = message("e2", "e1", "second committed");
			await store.create(header("zero-mid"), [e1, e2]);
			const path = (await store.findFile("zero-mid"))!;
			const committed = await readFile(path, "utf8");
			// Out-of-order page writeback + power loss: an unwritten zero-filled page followed by a later complete line.
			const zeroLine = `${"\0".repeat(512)}${JSON.stringify(message("lost-mid", "e2")).slice(40)}\n`;
			const unackedAfter = `${JSON.stringify(message("unacked-page2", "lost-mid"))}\n`;
			await appendFile(path, zeroLine + unackedAfter);

			const reopened = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				const loaded = await reopened.load("zero-mid");
				assert.deepEqual(loaded.entries, [e1, e2]);
				assert.equal(loaded.lastSeq, 2);

				const listed: string[] = [];
				for await (const summary of reopened.list({})) listed.push(summary.id);
				assert.deepEqual(listed, ["zero-mid"]);

				const listedLight: string[] = [];
				for await (const summary of reopened.list({ withoutSearchText: true })) listedLight.push(summary.id);
				assert.deepEqual(listedLight, ["zero-mid"]);

				const tail = await reopened.readTail("zero-mid", 1);
				assert.deepEqual(
					tail.entries.map((entry) => entry.id),
					["e1", "e2"],
				);
				assert.equal(existsSync(`${path}.idx`), false, "must not persist a sidecar over a torn crash tail");

				const resume = await reopened.readResume("zero-mid");
				assert.equal(resume.leafId, "e2");
				assert.equal(resume.lastSeq, 2);

				const range = await reopened.readEntryRange("zero-mid", { fromSeq: 1, toSeq: 10 });
				assert.equal(range.lastSeq, 2);
				assert.deepEqual(
					range.entries.map((item) => item.entry.id),
					["e1", "e2"],
				);

				// Next append removes both the zero-filled line and the unacknowledged line after it.
				const next = message("e3", "e2", "after recovery");
				assert.deepEqual(await reopened.append("zero-mid", [next], { expectSeq: 2 }), { lastSeq: 3 });
				assert.equal(await readFile(path, "utf8"), `${committed}${JSON.stringify(next)}\n`);
				assert.deepEqual((await reopened.load("zero-mid")).entries, [e1, e2, next]);
			} finally {
				await reopened.close();
			}

			// Foreign-append catch-up (forWrite) also recovers and truncates a mid-file NUL line left by another writer.
			const beforeForeign = await readFile(path, "utf8");
			await appendFile(path, `${"\0".repeat(256)}broken"}\n${JSON.stringify(message("unacked-2", "e3"))}\n`);
			const e4 = message("e4", "e3", "healed via forWrite");
			assert.deepEqual(await store.append("zero-mid", [e4], { expectSeq: 3 }), { lastSeq: 4 });
			assert.equal(await readFile(path, "utf8"), `${beforeForeign}${JSON.stringify(e4)}\n`);
		} finally {
			warnings.mockRestore();
			await store.close();
		}
	});

	it("syncs a session file before persisting its .idx sidecar and skips persisting if sync fails (#6717)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		await writer.create(header("idx-sync"), [message("a", null), message("b", "a")]);
		const path = (await writer.findFile("idx-sync"))!;
		await writer.close();

		const sidecarPath = `${path}.idx`;
		assert.equal(existsSync(sidecarPath), false);

		// First: if syncing the session file fails, the read still succeeds in memory but .idx is NOT written to disk.
		const failingReader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			await syncs(
				() => failingReader.readTail("idx-sync", 1),
				async (syncedPath, sync) => {
					if (syncedPath === path) throw Object.assign(new Error("EIO: fsync"), { code: "EIO" });
					await sync();
				},
			);
			assert.equal(existsSync(sidecarPath), false, ".idx must not be persisted when file sync fails");
		} finally {
			await failingReader.close();
		}

		// Second: on a normal cold index build, the session file is synced strictly before .idx exists on disk.
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			let sidecarExistedDuringSync = true;
			const { synced } = await syncs(
				() => reader.readTail("idx-sync", 1),
				async (syncedPath, sync) => {
					if (syncedPath === path) sidecarExistedDuringSync = existsSync(sidecarPath);
					await sync();
				},
			);
			assert.deepEqual(synced, [path]);
			assert.equal(sidecarExistedDuringSync, false, ".idx must not exist before session file sync finishes");
			assert.equal(existsSync(sidecarPath), true);
		} finally {
			await reader.close();
		}
	});

	for (const payloadBytes of [4096, 80_000]) {
		const label = payloadBytes <= 4096 ? "small (<= 256 KiB prefixHash)" : "large (> 256 KiB checkpoints)";
		it(`rejects a stale .idx sidecar when an earlier page is zeroed while size, mtime and tail witness still match (${label}) (#6717)`, async () => {
			const writer = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			const e1 = message("e1", null, "a".repeat(payloadBytes));
			const e2 = message("e2", "e1", "b".repeat(payloadBytes));
			const e3 = message("e3", "e2", "c".repeat(payloadBytes));
			const e4 = message("e4", "e3", "d".repeat(payloadBytes));
			await writer.create(header("stale-idx"), [e1, e2, e3, e4]);
			const path = (await writer.findFile("stale-idx"))!;
			await writer.readTail("stale-idx", 1);
			await writer.close();
			assert.equal(existsSync(`${path}.idx`), true);

			// Overwrite entry e2's page (after e1, well before the last 64-byte tail witness in e4) with raw NULs of the
			// exact same byte length, and restore atime/mtime so identity, size, mtimeNs, header and tail witness all match.
			const beforeStats = await stat(path);
			const raw = await readFile(path);
			const marker = Buffer.from('"id":"e2"');
			const markerAt = raw.indexOf(marker);
			assert.ok(markerAt > 0);
			const zeroed = Buffer.from(raw);
			zeroed.fill(0, markerAt, markerAt + 4096);
			await writeFile(path, zeroed);
			await utimes(path, beforeStats.atime, beforeStats.mtime);

			const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
			const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				const tail = await reader.readTail("stale-idx", 1);
				assert.deepEqual(
					tail.entries.map((entry) => entry.id),
					["e1"],
					"must reject the stale .idx and recover only the intact prefix before the zeroed page",
				);
				assert.equal(tail.lastSeq, 1);
				assert.equal((await reader.readResume("stale-idx")).leafId, "e1");
				assert.equal(existsSync(`${path}.idx`), false, "stale .idx must be removed once torn tail is detected");
			} finally {
				warnings.mockRestore();
				await reader.close();
			}
		});
	}

	it("rejects a legacy unsynced .idx sidecar when an earlier page was lost (#6717)", async () => {
		const writer = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		await writer.create(header("legacy-idx"), [
			message("e1", null, "a".repeat(4096)),
			message("e2", "e1", "b".repeat(4096)),
			message("e3", "e2", "c".repeat(4096)),
		]);
		const path = (await writer.findFile("legacy-idx"))!;
		await writer.readTail("legacy-idx", 1);
		await writer.close();

		// Rewrite .idx as an older build wrote it (no synced/prefixHash/checkpoints fields), then zero e2 keeping mtime.
		const sidecarPath = `${path}.idx`;
		const text = await readFile(sidecarPath, "utf8");
		const parsed = JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown>;
		delete parsed.synced;
		delete parsed.prefixHash;
		delete parsed.headWitness;
		delete parsed.checkpointStride;
		delete parsed.checkpoints;
		const body = JSON.stringify(parsed);
		await writeFile(sidecarPath, `${createHash("sha256").update(body).digest("hex")}\n${body}`);

		const beforeStats = await stat(path);
		const raw = await readFile(path);
		const markerAt = raw.indexOf(Buffer.from('"id":"e2"'));
		assert.ok(markerAt > 0);
		raw.fill(0, markerAt, markerAt + 512);
		await writeFile(path, raw);
		await utimes(path, beforeStats.atime, beforeStats.mtime);

		const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const reader = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
		try {
			const tail = await reader.readTail("legacy-idx", 1);
			assert.deepEqual(
				tail.entries.map((entry) => entry.id),
				["e1"],
			);
		} finally {
			warnings.mockRestore();
			await reader.close();
		}
	});

	it("resolves already-synced files in a multi-file group even when another file fails sync and rollback poisons the store (#6717)", async () => {
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			await store.create(header("alpha"), [message("a0")]);
			await store.create(header("beta"), [message("b0")]);
			const pathAlpha = (await store.findFile("alpha"))!;
			const pathBeta = (await store.findFile("beta"))!;
			const syncFault = Object.assign(new Error("EIO: fsync beta"), { code: "EIO" });
			const rollbackFault = Object.assign(new Error("EIO: truncate beta"), { code: "EIO" });

			let alphaSynced!: () => void;
			const alphaDone = new Promise<void>((resolve) => {
				alphaSynced = resolve;
			});
			const originalTruncate = fs.truncate;
			const truncateSpy = vi.spyOn(fs, "truncate").mockImplementation(async (target, len) => {
				if (String(target) === pathBeta) throw rollbackFault;
				return originalTruncate(target, len);
			});
			try {
				const { result } = await syncs(
					() =>
						Promise.allSettled([
							store.append("alpha", [message("a1", "a0")], { expectSeq: 1 }),
							store.append("beta", [message("b1", "b0")], { expectSeq: 1 }),
						]),
					async (syncedPath, sync) => {
						if (syncedPath === pathAlpha) {
							await sync();
							alphaSynced();
							return;
						}
						if (syncedPath === pathBeta) {
							await alphaDone;
							throw syncFault;
						}
						await sync();
					},
				);
				const [alphaOutcome, betaOutcome] = result;
				assert.equal(alphaOutcome?.status, "fulfilled", "already-synced file must resolve cleanly");
				assert.deepEqual(alphaOutcome.value, { lastSeq: 2 });
				assert.equal(betaOutcome?.status, "rejected", "failed file must reject with poisoned error");
				assert.ok(betaOutcome.reason instanceof JsonlStoragePoisonedError, String(betaOutcome.reason));
				assert.equal(betaOutcome.reason.location, pathBeta);
				assert.equal(betaOutcome.reason.cause, syncFault);
				assert.equal(betaOutcome.reason.rollbackCause, rollbackFault);
			} finally {
				truncateSpy.mockRestore();
			}

			// The store itself is now poisoned for all subsequent operations.
			await assert.rejects(store.load("alpha"), JsonlStoragePoisonedError);
			await assert.rejects(
				store.append("alpha", [message("a2", "a1")], { expectSeq: 2 }),
				JsonlStoragePoisonedError,
			);

			// A fresh store reads alpha's acknowledged append cleanly.
			const fresh = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				assert.deepEqual(
					(await fresh.load("alpha")).entries.map((entry) => entry.id),
					["a0", "a1"],
				);
			} finally {
				await fresh.close();
			}
		} finally {
			await store.close();
		}
	});

	it("syncs distinct files of a multi-session group in parallel without closing in-flight kept handles (#6717)", async () => {
		const SESSIONS = 20; // Exceeds KEPT_FILES (16) to exercise handle pinning during parallel sync.
		const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
		try {
			const ids = Array.from({ length: SESSIONS }, (_, index) => `par-${index}`);
			for (const id of ids) await store.create(header(id), [message(`init-${id}`)]);
			const targetPaths = new Set(await Promise.all(ids.map(async (id) => (await store.findFile(id))!)));

			// Barrier: only release once ALL 20 files have entered syncFile concurrently (proves parallel sync!).
			let entered = 0;
			let releaseBarrier!: () => void;
			const allEntered = new Promise<void>((resolve) => {
				releaseBarrier = resolve;
			});

			const { result, synced } = await syncs(
				() =>
					Promise.all(ids.map((id) => store.append(id, [message(`next-${id}`, `init-${id}`)], { expectSeq: 1 }))),
				async (syncedPath, sync) => {
					if (targetPaths.has(syncedPath)) {
						entered++;
						if (entered === SESSIONS) releaseBarrier();
						await allEntered;
					}
					await sync();
				},
			);
			assert.equal(entered, SESSIONS);
			assert.equal(synced.length, SESSIONS);
			for (const outcome of result) assert.deepEqual(outcome, { lastSeq: 2 });
			for (const id of ids) {
				assert.deepEqual(
					(await store.load(id)).entries.map((entry) => entry.id),
					[`init-${id}`, `next-${id}`],
				);
			}
		} finally {
			await store.close();
		}
	});
});
