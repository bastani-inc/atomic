import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.js";
import {
	SessionConflictError,
	StorageUnavailableError,
} from "../../packages/coding-agent/src/core/storage/session/errors.js";
import {
	LOCK_BACKOFF_MS,
	loadNativeSessionLocks,
	type NativeSessionLocks,
	nativeLockPath,
	sessionLockStripe,
	setNativeSessionLocksForTesting,
} from "../../packages/coding-agent/src/core/storage/session/jsonl-session-lock.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { JsonlSessionStore as LegacyJsonlSessionStore } from "../fixtures/jsonl-session-store-pre-6718/jsonl-session-store.js";
import { bunExecutable, readStreamText, type SpawnedProcess, sleep, spawnProcess } from "../helpers/runtime.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const CREATED_AT = "2026-11-26T00:00:00.000Z";
const header = (id: string, createdAt = CREATED_AT) => ({
	id,
	version: 4 as const,
	createdAt,
	cwd: "/project",
});

function message(id: string, parentId: string | null = null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: CREATED_AT,
		message: { role: "user", content: `body of ${id}`, timestamp: 1 },
	} as SessionEntry;
}

const NEW_STORE_MODULE = new URL(
	"../../packages/coding-agent/src/core/storage/session/jsonl-session-store.ts",
	import.meta.url,
).href;
const LEGACY_STORE_MODULE = new URL("../fixtures/jsonl-session-store-pre-6718/jsonl-session-store.ts", import.meta.url)
	.href;
const ERRORS_MODULE = new URL("../../packages/coding-agent/src/core/storage/session/errors.ts", import.meta.url).href;

type WriteFn = (
	this: fsPromises.FileHandle,
	...args: Parameters<fsPromises.FileHandle["write"]>
) => ReturnType<fsPromises.FileHandle["write"]>;

const openedPaths = new WeakMap<object, string>();

/**
 * Intercepts `FileHandle.prototype.write` on handles opened while `work` runs, allowing a test to pause a writer
 * mid-append (after acquiring its locks and before syncing/releasing) across Linux, macOS, and Windows.
 */
async function withWriteGate<T>(
	work: () => Promise<T>,
	onWrite: (
		path: string,
		proceed: () => ReturnType<fsPromises.FileHandle["write"]>,
	) => ReturnType<fsPromises.FileHandle["write"]>,
): Promise<T> {
	const probe = await fsPromises.open(fileURLToPath(import.meta.url), "r");
	const prototype = Object.getPrototypeOf(probe) as { write: WriteFn };
	await probe.close();
	const originalOpen = fsPromises.open;
	const opened = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
		const handle = await originalOpen(...args);
		openedPaths.set(handle, String(args[0]));
		return handle;
	});
	const originalWrite = prototype.write;
	prototype.write = function (this: fsPromises.FileHandle, ...args) {
		const path = openedPaths.get(this) ?? "";
		return onWrite(path, () => originalWrite.apply(this, args));
	};
	try {
		return await work();
	} finally {
		prototype.write = originalWrite;
		opened.mockRestore();
	}
}

/** Finds two session IDs whose file basenames map to distinct lock stripes. */
function distinctStripeIds(store: JsonlSessionStore, count: number): string[] {
	const usedStripes = new Set<number>();
	const ids: string[] = [];
	for (let candidate = 0; ids.length < count; candidate++) {
		const id = `session-stripe-${candidate}`;
		const stripe = sessionLockStripe(basename(store.locationFor(header(id))));
		if (!usedStripes.has(stripe)) {
			usedStripes.add(stripe);
			ids.push(id);
		}
	}
	return ids;
}

const pendingStdout = new WeakMap<SpawnedProcess, string>();

async function readStdoutLine(child: SpawnedProcess): Promise<string> {
	assert.ok(child.stdout);
	let buffered = pendingStdout.get(child) ?? "";
	const reader = child.stdout.getReader();
	try {
		while (!buffered.includes("\n")) {
			const next = await reader.read();
			if (next.done) {
				const stderr = await readStreamText(child.stderr);
				assert.fail(`child exited before line: ${stderr}`);
			}
			buffered += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const newline = buffered.indexOf("\n");
	pendingStdout.set(child, buffered.slice(newline + 1));
	return buffered.slice(0, newline).trim();
}

describe("JSONL session store advisory & striped locks (#6718)", () => {
	const originalPlatform = process.platform;
	const setPlatform = (platform: NodeJS.Platform) =>
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "jsonl-advisory-locks-"));
	});

	afterEach(async () => {
		setPlatform(originalPlatform);
		setNativeSessionLocksForTesting(undefined);
		await rm(directory, { recursive: true, force: true, maxRetries: 5 });
	});

	describe("mixed-version compatibility with the bundled pre-#6718 store", () => {
		it("excludes new writers while a legacy store holds .session.lock and hands off once released (#6718)", async () => {
			const legacy = await LegacyJsonlSessionStore.open(directory, { exactDirectory: true });
			const current = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				await legacy.create(header("shared"), []);
				const path = (await legacy.findFile("shared"))!;
				let releaseLegacy!: () => void;
				const holdLegacy = new Promise<void>((resolve) => {
					releaseLegacy = resolve;
				});
				let legacyEntered!: () => void;
				const legacyInWrite = new Promise<void>((resolve) => {
					legacyEntered = resolve;
				});
				let paused = false;

				await withWriteGate(
					async () => {
						const legacyAppend = legacy.append("shared", [message("from-legacy")], { expectSeq: 0 });
						await legacyInWrite;
						assert.equal(existsSync(join(directory, ".session.lock")), true);

						let newFinished = false;
						const newAppend = current.append("shared", [message("from-new")], { expectSeq: 1 }).then((result) => {
							newFinished = true;
							return result;
						});

						await sleep(120);
						assert.equal(newFinished, false, "new writer entered while legacy writer held .session.lock");

						releaseLegacy();
						assert.deepEqual(await legacyAppend, { lastSeq: 1 });
						assert.deepEqual(await newAppend, { lastSeq: 2 });
						assert.equal(newFinished, true);
					},
					async (writePath, proceed) => {
						if (writePath === path && !paused) {
							paused = true;
							legacyEntered();
							await holdLegacy;
						}
						return proceed();
					},
				);

				assert.equal(existsSync(join(directory, ".session.lock")), false);
				assert.deepEqual(
					(await current.load("shared")).entries.map((entry) => entry.id),
					["from-legacy", "from-new"],
				);
			} finally {
				await legacy.close();
				await current.close();
			}
		});

		it("keeps .session.lock held across overlapping new group members and blocks legacy writers until all leave (#6718)", async () => {
			const new1 = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const new2 = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const legacy = await LegacyJsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				const [idA, idB] = distinctStripeIds(new1, 2);
				await new1.create(header(idA), []);
				await new1.create(header(idB), []);
				const pathA = (await new1.findFile(idA))!;
				const pathB = (await new1.findFile(idB))!;

				let releaseA!: () => void;
				const holdA = new Promise<void>((resolve) => {
					releaseA = resolve;
				});
				let enteredA!: () => void;
				const inA = new Promise<void>((resolve) => {
					enteredA = resolve;
				});
				let releaseB!: () => void;
				const holdB = new Promise<void>((resolve) => {
					releaseB = resolve;
				});
				let enteredB!: () => void;
				const inB = new Promise<void>((resolve) => {
					enteredB = resolve;
				});

				await withWriteGate(
					async () => {
						const appendA = new1.append(idA, [message("a1")], { expectSeq: 0 });
						await inA;
						// Second new writer joins the active group on a different stripe while A is still in progress.
						const appendB = new2.append(idB, [message("b1")], { expectSeq: 0 });
						await inB;
						assert.equal(existsSync(join(directory, ".session.lock")), true);

						// Legacy writer attempts to write while both new writers hold the group lock.
						let legacyDone = false;
						const legacyCreate = legacy.create(header("legacy-after-group"), []).then((result) => {
							legacyDone = true;
							return result;
						});

						// First member leaves while second member stays active: `.session.lock` MUST stay on disk!
						releaseA();
						await appendA;
						await sleep(120);
						assert.equal(
							existsSync(join(directory, ".session.lock")),
							true,
							"first member removed group lock early",
						);
						assert.equal(legacyDone, false, "legacy writer entered while second new member was still active");

						// Second (last) member leaves: `.session.lock` is removed and legacy writer proceeds!
						releaseB();
						await appendB;
						await legacyCreate;
						assert.equal(legacyDone, true);
					},
					async (writePath, proceed) => {
						if (writePath === pathA) {
							enteredA();
							await holdA;
						} else if (writePath === pathB) {
							enteredB();
							await holdB;
						}
						return proceed();
					},
				);

				assert.equal(existsSync(join(directory, ".session.lock")), false);
				assert.equal((await new1.load(idA)).lastSeq, 1);
				assert.equal((await new1.load(idB)).lastSeq, 1);
				assert.equal((await new1.load("legacy-after-group")).lastSeq, 0);
			} finally {
				await new1.close();
				await new2.close();
				await legacy.close();
			}
		});

		it("never deletes a live legacy .session.lock when a stale .group record remains (ABA safety) (#6718)", async () => {
			const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				await store.create(header("aba"), []);
				const lockPath = join(directory, ".session.lock");
				const groupPath = `${lockPath}.group`;
				assert.equal(existsSync(lockPath), false);

				// Simulate a legacy process freshly creating `.session.lock` while a stale `.group` record is on disk.
				mkdirSync(lockPath);
				const stats = await stat(lockPath, { bigint: true });
				// Record a mismatched backdated timestamp (as a prior group would have left).
				await writeFile(
					groupPath,
					JSON.stringify({
						generation: `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`,
						mtimeNs: String(stats.mtimeNs - 2_000_000_000n),
					}),
				);

				let finished = false;
				const pending = store.append("aba", [message("after-legacy")], { expectSeq: 0 }).then((result) => {
					finished = true;
					return result;
				});

				await sleep(250);
				assert.equal(finished, false, "new writer stole live legacy .session.lock");
				assert.equal(existsSync(lockPath), true, "new writer deleted live legacy .session.lock");

				rmdirSync(lockPath);
				assert.deepEqual(await pending, { lastSeq: 1 });
				assert.equal(existsSync(lockPath), false);
			} finally {
				await store.close();
			}
		});

		it("serializes racing legacy and new processes on creates and appends without losing entries (#6718)", async () => {
			const spawnMixed = (
				role: "legacy" | "new",
				workerId: string,
				mode: "create" | "append",
			): { child: SpawnedProcess; stderr: () => Promise<string> } => {
				const moduleUrl = role === "legacy" ? LEGACY_STORE_MODULE : NEW_STORE_MODULE;
				const script = `
import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
import { SessionConflictError, SessionExistsError } from ${JSON.stringify(ERRORS_MODULE)};
const store = await JsonlSessionStore.open(${JSON.stringify(directory)}, { exactDirectory: true });
console.log("READY");
await new Promise((resolve) => process.stdin.once("data", resolve));
try {
	if (${JSON.stringify(mode)} === "create") {
		try {
			await store.create({ id: "mixed-race", version: 4, cwd: "/project", createdAt: ${JSON.stringify(CREATED_AT)} }, []);
			console.log("committed");
		} catch (error) {
			if (error instanceof SessionExistsError) console.log("exists");
			else throw error;
		}
	} else {
		let next = (await store.load("mixed-race")).lastSeq;
		const ack = [];
		for (let i = 0; i < 6; i++) {
			const entry = {
				type: "message",
				id: ${JSON.stringify(workerId)} + "-" + i,
				parentId: null,
				timestamp: ${JSON.stringify(CREATED_AT)},
				message: { role: "user", content: "hi", timestamp: i + 1 },
			};
			for (;;) {
				try {
					const res = await store.append("mixed-race", [entry], { expectSeq: next });
					ack.push([entry.id, res.lastSeq]);
					next = res.lastSeq;
					break;
				} catch (error) {
					if (error instanceof SessionConflictError) {
						next = error.actualSeq;
						continue;
					}
					throw error;
				}
			}
		}
		console.log(JSON.stringify(ack));
	}
} finally {
	await store.close();
}
`;
				const child = spawnProcess([bunExecutable(), "-e", script], {
					stdin: "pipe",
					stdout: "pipe",
					stderr: "pipe",
				});
				return { child, stderr: () => readStreamText(child.stderr) };
			};

			const runWave = async (mode: "create" | "append") => {
				const workers = [
					spawnMixed("legacy", "L1", mode),
					spawnMixed("legacy", "L2", mode),
					spawnMixed("new", "N1", mode),
					spawnMixed("new", "N2", mode),
				];
				try {
					await Promise.all(workers.map(async ({ child }) => assert.equal(await readStdoutLine(child), "READY")));
					for (const { child } of workers) {
						child.stdin?.write("go\n");
						child.stdin?.end();
					}
					const results = await Promise.all(workers.map(async ({ child }) => readStdoutLine(child)));
					for (const { child, stderr } of workers) {
						assert.equal(await child.exited, 0, await stderr());
					}
					return results;
				} finally {
					for (const { child } of workers) {
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					}
					await Promise.all(workers.map(({ child }) => child.exited));
				}
			};

			const createResults = (await runWave("create")).sort();
			assert.deepEqual(createResults, ["committed", "exists", "exists", "exists"]);

			const appendResults = (await runWave("append")).flatMap((line) => JSON.parse(line) as [string, number][]);
			assert.equal(appendResults.length, 24);
			assert.equal(existsSync(join(directory, ".session.lock")), false);

			const verifier = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				const { entries, lastSeq } = await verifier.load("mixed-race");
				assert.equal(lastSeq, 24);
				assert.equal(new Set(entries.map((entry) => entry.id)).size, 24);
				for (const [id, seq] of appendResults) assert.equal(entries[seq - 1]?.id, id);
			} finally {
				await verifier.close();
			}
		});
	});

	describe("killed-holder immediate release", () => {
		it("recovers immediately after a new writer holding the lock is SIGKILLed without waiting 10 s (#6718)", async () => {
			const seed = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				await seed.create(header("kill-fast"), []);
			} finally {
				await seed.close();
			}

			// Spawn a child using the real group lock + stripe lock, hold both, confirm `.session.lock` exists, then SIGKILL!
			const lockModule = new URL(
				"../../packages/coding-agent/src/core/storage/session/jsonl-session-lock.ts",
				import.meta.url,
			).href;
			const child = spawnProcess(
				[
					bunExecutable(),
					"-e",
					`
import { acquireFineSessionLocks, acquireSessionGroupLock, loadNativeSessionLocks } from ${JSON.stringify(lockModule)};
const native = loadNativeSessionLocks();
if (!native) throw new Error("native advisory locks unavailable");
const group = await acquireSessionGroupLock(native, ${JSON.stringify(directory)}, { onCompromised: () => {} });
const fine = await acquireFineSessionLocks(native, group.lockPath, { kind: "full" });
console.log("HELD");
await new Promise(() => {});
`,
				],
				{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			try {
				assert.equal(await readStdoutLine(child), "HELD");
				assert.equal(existsSync(join(directory, ".session.lock")), true);

				child.kill("SIGKILL");
				await child.exited;
				// `.session.lock` is still on disk after SIGKILL (the kernel only released the advisory locks).
				assert.equal(existsSync(join(directory, ".session.lock")), true);

				const started = performance.now();
				const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
				try {
					const result = await store.append("kill-fast", [message("recovered-fast")], { expectSeq: 0 });
					const elapsedMs = performance.now() - started;
					assert.deepEqual(result, { lastSeq: 1 });
					assert.ok(
						elapsedMs < 2_500,
						`expected immediate recovery well below the 10 s stale window, took ${Math.round(elapsedMs)} ms`,
					);
					assert.equal(existsSync(join(directory, ".session.lock")), false);
				} finally {
					await store.close();
				}
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await child.exited;
			}
		});

		it("cleans up a leftover .session.lock.staging directory left by a crashed writer immediately (#6718)", async () => {
			const seed = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				await seed.create(header("staging-crash"), []);
			} finally {
				await seed.close();
			}

			// Simulate a crash between `mkdir(.session.lock.staging)` / writing `.group` and `renameNoReplace`.
			const stagingPath = join(directory, ".session.lock.staging");
			const groupPath = join(directory, ".session.lock.group");
			mkdirSync(stagingPath);
			const stats = await stat(stagingPath, { bigint: true });
			await writeFile(
				groupPath,
				JSON.stringify({
					generation: `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`,
					mtimeNs: String(stats.mtimeNs),
				}),
			);

			const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				const started = performance.now();
				assert.deepEqual(await store.append("staging-crash", [message("after-staging")], { expectSeq: 0 }), {
					lastSeq: 1,
				});
				assert.ok(performance.now() - started < 2_000);
				assert.equal(existsSync(stagingPath), false);
				assert.equal(existsSync(join(directory, ".session.lock")), false);
			} finally {
				await store.close();
			}
		});

		it("keeps .session.lock held for a surviving member when another member process is SIGKILLed (#6718)", async () => {
			const lockModule = new URL(
				"../../packages/coding-agent/src/core/storage/session/jsonl-session-lock.ts",
				import.meta.url,
			).href;
			const holdScript = `
import { acquireSessionGroupLock, loadNativeSessionLocks } from ${JSON.stringify(lockModule)};
const native = loadNativeSessionLocks();
const group = await acquireSessionGroupLock(native, ${JSON.stringify(directory)}, { onCompromised: () => {} });
console.log("HELD");
await new Promise((resolve) => process.stdin.once("data", resolve));
await group.release();
console.log("RELEASED");
`;
			const child1 = spawnProcess([bunExecutable(), "-e", holdScript], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const child2 = spawnProcess([bunExecutable(), "-e", holdScript], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			try {
				assert.equal(await readStdoutLine(child1), "HELD");
				assert.equal(await readStdoutLine(child2), "HELD");
				assert.equal(existsSync(join(directory, ".session.lock")), true);

				// Kill member 1 abruptly: member 2 still holds `.members` shared so `.session.lock` stays intact!
				child1.kill("SIGKILL");
				await child1.exited;
				assert.equal(existsSync(join(directory, ".session.lock")), true);

				// A legacy writer must still be blocked while surviving member 2 holds the group.
				const legacy = await LegacyJsonlSessionStore.open(directory, { exactDirectory: true });
				try {
					let legacyDone = false;
					const pending = legacy.create(header("after-survivor"), []).then(() => {
						legacyDone = true;
					});
					await sleep(120);
					assert.equal(legacyDone, false, "legacy writer entered while surviving member held the group");

					// Now surviving member 2 leaves cleanly: `.session.lock` is removed and legacy proceeds!
					child2.stdin?.write("go\n");
					child2.stdin?.end();
					assert.equal(await readStdoutLine(child2), "RELEASED");
					await child2.exited;
					await pending;
					assert.equal(legacyDone, true);
					assert.equal(existsSync(join(directory, ".session.lock")), false);
				} finally {
					await legacy.close();
				}
			} finally {
				for (const child of [child1, child2]) {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}
				await Promise.all([child1.exited, child2.exited]);
			}
		});
	});

	describe("per-session-file striped locks & deadlock freedom", () => {
		it("commits appends to sessions on distinct stripes concurrently while keeping .session.lock present (#6718)", async () => {
			const storeA = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const storeB = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				const [idA, idB] = distinctStripeIds(storeA, 2);
				await storeA.create(header(idA), []);
				await storeA.create(header(idB), []);
				const pathA = (await storeA.findFile(idA))!;

				let releaseA!: () => void;
				const holdA = new Promise<void>((resolve) => {
					releaseA = resolve;
				});
				let enteredA!: () => void;
				const inA = new Promise<void>((resolve) => {
					enteredA = resolve;
				});

				await withWriteGate(
					async () => {
						const appendA = storeA.append(idA, [message("a1")], { expectSeq: 0 });
						await inA;
						assert.equal(existsSync(join(directory, ".session.lock")), true);

						// While storeA is blocked mid-write on stripe(A), storeB appends to stripe(B) and finishes!
						const resultB = await storeB.append(idB, [message("b1")], { expectSeq: 0 });
						assert.deepEqual(resultB, { lastSeq: 1 });
						// `.session.lock` MUST still be present because storeA is still active!
						assert.equal(existsSync(join(directory, ".session.lock")), true);

						releaseA();
						assert.deepEqual(await appendA, { lastSeq: 1 });
					},
					async (writePath, proceed) => {
						if (writePath === pathA) {
							enteredA();
							await holdA;
						}
						return proceed();
					},
				);

				assert.equal(existsSync(join(directory, ".session.lock")), false);
				assert.deepEqual(
					(await storeA.load(idA)).entries.map((entry) => entry.id),
					["a1"],
				);
				assert.deepEqual(
					(await storeB.load(idB)).entries.map((entry) => entry.id),
					["b1"],
				);
			} finally {
				await storeA.close();
				await storeB.close();
			}
		});

		it("serializes concurrent appends to the same session file across independent stores (#6718)", async () => {
			const store1 = await JsonlSessionStore.open(directory, { exactDirectory: true });
			const store2 = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				await store1.create(header("same-file"), []);
				const path = (await store1.findFile("same-file"))!;
				let release1!: () => void;
				const hold1 = new Promise<void>((resolve) => {
					release1 = resolve;
				});
				let entered1!: () => void;
				const in1 = new Promise<void>((resolve) => {
					entered1 = resolve;
				});
				let paused = false;

				await withWriteGate(
					async () => {
						const append1 = store1.append("same-file", [message("first")], { expectSeq: 0 });
						await in1;

						let secondSettled = false;
						const append2 = store2.append("same-file", [message("second")], { expectSeq: 0 }).finally(() => {
							secondSettled = true;
						});

						await sleep(120);
						assert.equal(secondSettled, false, "second writer modified the same session file concurrently");

						release1();
						assert.deepEqual(await append1, { lastSeq: 1 });
						await assert.rejects(append2, (error: unknown) => {
							assert.ok(error instanceof SessionConflictError);
							assert.equal(error.actualSeq, 1);
							return true;
						});
					},
					async (writePath, proceed) => {
						if (writePath === path && !paused) {
							paused = true;
							entered1();
							await hold1;
						}
						return proceed();
					},
				);
			} finally {
				await store1.close();
				await store2.close();
			}
		});

		it("completes overlapping multi-session append groups in cyclic order without deadlock (#6718)", async () => {
			const stores = await Promise.all(
				Array.from({ length: 4 }, () => JsonlSessionStore.open(directory, { exactDirectory: true })),
			);
			try {
				const ids = distinctStripeIds(stores[0]!, 4);
				for (const id of ids) await stores[0]!.create(header(id), []);

				// Each store appends to a cyclic pair (ids[i], ids[(i+1)%4]) across several rounds.
				const rounds = 6;
				const expectedCount = new Map<string, number>(ids.map((id) => [id, 0]));
				const runStore = async (worker: number) => {
					const store = stores[worker]!;
					const pair = [ids[worker]!, ids[(worker + 1) % 4]!];
					const seqs = new Map<string, number>(pair.map((id) => [id, 0]));
					for (let round = 0; round < rounds; round++) {
						const pending = pair.map((id) => ({
							id,
							entry: message(`w${worker}-r${round}-${id}`),
						}));
						while (pending.length > 0) {
							const batch = pending.splice(0, pending.length);
							const results = await Promise.allSettled(
								batch.map(({ id, entry }) => store.append(id, [entry], { expectSeq: seqs.get(id)! })),
							);
							for (const [index, outcome] of results.entries()) {
								const item = batch[index]!;
								if (outcome.status === "fulfilled") {
									seqs.set(item.id, outcome.value.lastSeq);
								} else if (outcome.reason instanceof SessionConflictError) {
									seqs.set(item.id, outcome.reason.actualSeq);
									pending.push(item);
								} else {
									throw outcome.reason;
								}
							}
						}
					}
				};

				await Promise.all(stores.map((_store, index) => runStore(index)));
				for (const id of ids) expectedCount.set(id, rounds * 2);

				for (const id of ids) {
					const snapshot = await stores[0]!.load(id);
					assert.equal(snapshot.lastSeq, expectedCount.get(id));
					assert.equal(new Set(snapshot.entries.map((entry) => entry.id)).size, expectedCount.get(id));
				}
				assert.equal(existsSync(join(directory, ".session.lock")), false);
			} finally {
				await Promise.all(stores.map((store) => store.close()));
			}
		});

		it("relocks safely when a cached session file is renamed onto a different stripe (#6718)", async () => {
			const store = await JsonlSessionStore.open(directory, { exactDirectory: true });
			try {
				await store.create(header("moved-stripe"), [message("initial")]);
				const oldPath = (await store.findFile("moved-stripe"))!;
				const oldStripe = sessionLockStripe(basename(oldPath));

				let newName = "renamed-0.jsonl";
				for (let index = 0; ; index++) {
					const candidate = `renamed-${index}.jsonl`;
					if (sessionLockStripe(candidate) !== oldStripe) {
						newName = candidate;
						break;
					}
				}
				await rename(oldPath, join(directory, newName));

				assert.deepEqual(await store.append("moved-stripe", [message("after-rename")], { expectSeq: 1 }), {
					lastSeq: 2,
				});
				assert.deepEqual(
					(await store.load("moved-stripe")).entries.map((entry) => entry.id),
					["initial", "after-rename"],
				);
			} finally {
				await store.close();
			}
		});
	});

	describe("Windows EPERM backoff and native fallback", () => {
		function realNative(): NativeSessionLocks {
			setNativeSessionLocksForTesting(undefined);
			const native = loadNativeSessionLocks();
			assert.ok(native, "expected native advisory lock bindings");
			return native;
		}

		it("retries transient Windows os error 5 on tryAdvisoryLockAsync, trySharedAdvisoryLockAsync, and renameNoReplaceAsync (#6718)", async () => {
			setPlatform("win32");
			const real = realNative();
			let exFails = 2;
			let shFails = 2;
			let renameFails = 2;
			let exCalls = 0;
			let shCalls = 0;
			let renameCalls = 0;

			setNativeSessionLocksForTesting({
				tryAdvisoryLockAsync: async (path, waitMs) => {
					if (path.endsWith(".gate") && exFails > 0) {
						exCalls++;
						exFails--;
						throw new Error("Access is denied. (os error 5)");
					}
					if (path.endsWith(".gate")) exCalls++;
					return real.tryAdvisoryLockAsync(path, waitMs);
				},
				trySharedAdvisoryLockAsync: async (path, waitMs) => {
					shCalls++;
					if (shFails > 0) {
						shFails--;
						throw new Error("Access is denied. (os error 5)");
					}
					return real.trySharedAdvisoryLockAsync(path, waitMs);
				},
				renameNoReplaceAsync: async (from, to) => {
					renameCalls++;
					if (renameFails > 0) {
						renameFails--;
						throw new Error("Access is denied. (os error 5)");
					}
					return real.renameNoReplaceAsync(from, to);
				},
			});

			const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				await store.create(header("win-retry"), []);
				assert.ok(exCalls >= 3, `expected retried exclusive advisory lock, got ${exCalls}`);
				assert.equal(shCalls, 3);
				assert.equal(renameCalls, 3);
				assert.equal(existsSync(join(directory, ".session.lock")), false);
			} finally {
				await store.close();
			}
		});

		it("reports persistent Windows os error 5 on advisory lock after bounded attempts (#6718)", async () => {
			setPlatform("win32");
			const real = realNative();
			let attempts = 0;
			setNativeSessionLocksForTesting({
				...real,
				tryAdvisoryLockAsync: async () => {
					attempts++;
					throw new Error("Access is denied. (os error 5)");
				},
			});

			const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				await assert.rejects(store.create(header("win-exhaust"), []), (error: unknown) => {
					assert.ok(error instanceof StorageUnavailableError);
					assert.match(error.cause.message, /os error 5/);
					return true;
				});
				assert.equal(attempts, LOCK_BACKOFF_MS.length + 1);
			} finally {
				await store.close();
			}
		});

		it("does not retry EPERM on advisory locks off Windows and does not retry EACCES on Windows (#6718)", async () => {
			const real = realNative();
			let linuxAttempts = 0;
			setPlatform("linux");
			setNativeSessionLocksForTesting({
				...real,
				tryAdvisoryLockAsync: async () => {
					linuxAttempts++;
					throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
				},
			});
			const linuxStore = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				await assert.rejects(linuxStore.create(header("linux-no-retry"), []), StorageUnavailableError);
				assert.equal(linuxAttempts, 1);
			} finally {
				await linuxStore.close();
			}

			let winEaccesAttempts = 0;
			setPlatform("win32");
			setNativeSessionLocksForTesting({
				...real,
				tryAdvisoryLockAsync: async () => {
					winEaccesAttempts++;
					throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
				},
			});
			const winStore = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				await assert.rejects(winStore.create(header("win-eacces"), []), StorageUnavailableError);
				assert.equal(winEaccesAttempts, 1);
			} finally {
				await winStore.close();
			}
		});

		it("propagates AbortSignal cancellation during Windows advisory lock backoff (#6718)", async () => {
			setPlatform("win32");
			const real = realNative();
			const controller = new AbortController();
			const reason = new Error("cancelled during advisory backoff");
			let attempts = 0;
			setNativeSessionLocksForTesting({
				...real,
				tryAdvisoryLockAsync: async () => {
					attempts++;
					controller.abort(reason);
					throw new Error("Access is denied. (os error 5)");
				},
			});

			const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				await assert.rejects(
					(async () => {
						for await (const _summary of store.list({ signal: controller.signal })) {
							assert.fail("listing ran without the lock");
						}
					})(),
					(error: unknown) => error === reason,
				);
				assert.equal(attempts, 1);
			} finally {
				await store.close();
			}
		});

		it("uses extended-length Windows paths for native lock and rename calls past MAX_PATH (#6718)", () => {
			const shortWin = "C:\\work\\sessions\\.session.lock.gate";
			assert.equal(nativeLockPath(shortWin, "win32"), shortWin);

			const deepSegments = Array.from({ length: 16 }, (_, index) => `level-${index}-segment`).join("\\");
			const longWin = `C:\\w\\0\\_temp\\${deepSegments}\\.session.lock.members`;
			assert.ok(longWin.length > 240);
			assert.equal(nativeLockPath(longWin, "win32"), `\\\\?\\${longWin}`);

			const longUnc = `\\\\server\\share\\${deepSegments}\\.session.lock.gate`;
			assert.equal(
				nativeLockPath(longUnc, "win32"),
				`\\\\?\\UNC\\server\\share\\${deepSegments}\\.session.lock.gate`,
			);

			const longPosix = `/${Array.from({ length: 16 }, (_, index) => `level-${index}-segment`).join("/")}/.session.lock.gate`;
			assert.equal(nativeLockPath(longPosix, "linux"), longPosix);
			assert.equal(nativeLockPath(longPosix, "darwin"), longPosix);
		});

		it("falls back cleanly to proper-lockfile when native advisory locks are unavailable (#6718)", async () => {
			setNativeSessionLocksForTesting(null);
			const store = await JsonlSessionStore.open(directory, { exactDirectory: true, scanExisting: false });
			try {
				await store.create(header("fallback"), [message("m1")]);
				assert.deepEqual(await store.append("fallback", [message("m2")], { expectSeq: 1 }), { lastSeq: 2 });
				assert.equal((await store.load("fallback")).lastSeq, 2);
				assert.equal(existsSync(join(directory, ".session.lock")), false);
			} finally {
				await store.close();
			}
		});
	});
});
