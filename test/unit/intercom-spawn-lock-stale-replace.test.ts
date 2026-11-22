import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsModule, { readdirSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, test } from "vitest";
import {
	acquireSpawnLock,
	acquireSpawnLockAsync,
	releaseSpawnLock,
	releaseSpawnLockAsync,
	replaceStaleSpawnLock,
	replaceStaleSpawnLockAsync,
} from "../../packages/intercom/broker/spawn.js";
import {
	isAbandoned,
	PARKED_FILE_MAX_AGE_MS,
	processStart,
	removeFileIfUnchanged,
	takeOverStaleLock as takeOverWith,
} from "../../packages/intercom/broker/stale-lock-file.js";
import {
	fileExistsSync,
	makeTempDirectory,
	moduleDir,
	readStreamText,
	readTextSync,
	removeTempDirectory,
	sleep,
	spawnProcess,
	writeTextSync,
} from "../helpers/runtime.js";

const tempDir = makeTempDirectory("ic5132-");
afterAll(() => removeTempDirectory(tempDir));

let lockCount = 0;

/** A spawn lock whose spawner is long gone: no live process has a pid this large. */
function staleLock(): { readonly path: string; readonly content: string } {
	const path = join(tempDir, `broker.spawn.lock-${lockCount++}`);
	const content = `2147483646\n${Date.now()}\n`;
	writeTextSync(path, content);
	return { path, content };
}

/** Sixteen spawner processes, all started before any of them may touch the lock. */
const STRESS_SPAWNERS = 16;

/** Each spawner is a real node process loading spawn.ts through jiti, which is slow on a loaded Windows runner. */
const STRESS_TEST_TIMEOUT_MS = 120_000;

/** A process that is always running: init on POSIX, the System process on Windows. */
const UNSIGNALLABLE_PID = process.platform === "win32" ? 4 : 1;

/** How often the spawners and the test poll the gate directory. */
const START_POLL_MS = 2;

describe("stale spawn lock replacement (#5132)", () => {
	test("two spawners that both saw one stale lock never both take it (#5132)", () => {
		const { path, content } = staleLock();
		// Both spawners read the same stale lock before either replaces it.
		const seenByA = readTextSync(path, "utf8");
		const seenByB = readTextSync(path, "utf8");
		assert.equal(seenByA, content);
		assert.equal(seenByB, content);

		replaceStaleSpawnLock(seenByA, path);
		const ownerA = acquireSpawnLock(path);
		assert.ok(ownerA !== undefined, "the first spawner takes the replaced lock");

		// The second spawner acts on the stale lock it saw, which is gone: it must not remove the first spawner's lock.
		replaceStaleSpawnLock(seenByB, path);
		assert.equal(acquireSpawnLock(path), undefined, "the second spawner finds the lock held");
		assert.ok(readTextSync(path, "utf8").startsWith(ownerA));

		releaseSpawnLock(ownerA, path);
		assert.equal(fileExistsSync(path), false);
	});

	test("a stale lock is replaced while it is still the one inspected (#5132)", async () => {
		const { path, content } = staleLock();
		replaceStaleSpawnLock(content, path);
		assert.equal(fileExistsSync(path), false);

		const owner = acquireSpawnLock(path);
		assert.ok(owner !== undefined);
		releaseSpawnLock(owner, path);

		const asyncStale = staleLock();
		await replaceStaleSpawnLockAsync(asyncStale.content, asyncStale.path);
		assert.equal(fileExistsSync(asyncStale.path), false);
		const asyncOwner = await acquireSpawnLockAsync(asyncStale.path);
		assert.ok(asyncOwner !== undefined);
		assert.equal(await acquireSpawnLockAsync(asyncStale.path), undefined);
		await releaseSpawnLockAsync(asyncOwner, asyncStale.path);
		assert.equal(fileExistsSync(asyncStale.path), false);
	});

	test(
		`exactly one of ${STRESS_SPAWNERS} concurrent spawners takes a stale lock (#5132)`,
		async () => {
			const { path } = staleLock();
			const gate = makeTempDirectory("ic5132-gate-");
			const start = join(gate, "start");
			const spawnModule = pathToFileURL(
				join(moduleDir(import.meta.url), "../../packages/intercom/broker/spawn.ts"),
			).href;
			const jiti = pathToFileURL(createRequire(import.meta.url).resolve("jiti")).href;
			const script = `
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const gate = ${JSON.stringify(gate)};
const count = (prefix) => readdirSync(gate).filter((name) => name.startsWith(prefix)).length;
const until = async (done) => { while (!done()) await new Promise((resolve) => setTimeout(resolve, ${START_POLL_MS})); };
const { createJiti } = await import(${JSON.stringify(jiti)});
const { acquireSpawnLock } = await createJiti(import.meta.url).import(${JSON.stringify(spawnModule)});
writeFileSync(join(gate, "ready-" + process.pid), "");
await until(() => existsSync(${JSON.stringify(start)}));
const owner = acquireSpawnLock(${JSON.stringify(path)}) !== undefined;
writeFileSync(join(gate, "decided-" + process.pid), "");
// An owner holds the lock until every spawner has decided, as one starting a broker would; its exit leaves it stale.
if (owner) await until(() => count("decided-") === ${STRESS_SPAWNERS});
process.stdout.write(owner ? "owner" : "waiter");
`;
			const spawners = Array.from({ length: STRESS_SPAWNERS }, () =>
				spawnProcess([process.execPath, "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" }),
			);
			const outputs = spawners.map(async (spawner) => {
				const [stdout, stderr] = await Promise.all([
					readStreamText(spawner.stdout),
					readStreamText(spawner.stderr),
				]);
				assert.equal(await spawner.exited, 0, stderr);
				return stdout;
			});
			// Every spawner has loaded spawn.ts before any may act, so they all race on the lock together.
			while (readdirSync(gate).filter((name) => name.startsWith("ready-")).length < STRESS_SPAWNERS) {
				await sleep(START_POLL_MS);
			}
			writeTextSync(start, "");
			const results = await Promise.all(outputs);
			removeTempDirectory(gate);

			assert.equal(results.filter((result) => result === "owner").length, 1, results.join(","));
			assert.equal(results.filter((result) => result === "waiter").length, STRESS_SPAWNERS - 1);
		},
		STRESS_TEST_TIMEOUT_MS,
	);
});

describe("stale lock file removal (#5132)", () => {
	test("a lock written after the stale one was inspected is kept (#5132)", () => {
		const { path, content } = staleLock();
		writeTextSync(path, `${process.pid}\n${Date.now()}\n`);
		const live = readTextSync(path, "utf8");

		assert.equal(removeFileIfUnchanged(path, content), false);
		assert.equal(readTextSync(path, "utf8"), live);
		assert.deepEqual(leftovers(path), []);
	});

	test("an inspected stale lock is removed without leaving its parked copy (#5132)", () => {
		const { path, content } = staleLock();
		assert.equal(removeFileIfUnchanged(path, content), true);
		assert.equal(fileExistsSync(path), false);
		assert.deepEqual(leftovers(path), []);
	});

	test("a lock already gone is not reported removed (#5132)", () => {
		assert.equal(removeFileIfUnchanged(join(tempDir, "absent-lock"), undefined), false);
	});

	test("a lock that replaced the inspected one is never removed: put back, or else left parked (#5220)", () => {
		const { path, content } = staleLock();
		const live = `${process.pid}\n${Date.now()}\n`;
		writeTextSync(path, live);
		const third = `${process.pid}\nthird\n`;
		const renameSync = fsModule.renameSync;
		let moved = false;
		fsModule.renameSync = ((from: string, to: string) => {
			renameSync(from, to);
			if (!moved && from === path) {
				moved = true;
				writeTextSync(path, third);
			}
		}) as typeof fsModule.renameSync;
		syncBuiltinESMExports();
		try {
			assert.equal(removeFileIfUnchanged(path, content), false);
		} finally {
			fsModule.renameSync = renameSync;
			syncBuiltinESMExports();
		}
		assert.equal(readTextSync(path, "utf8"), third);
		const left = leftovers(path);
		assert.equal(left.length, 1, "the live lock is left parked");
		assert.equal(readTextSync(join(dirname(path), left[0] as string), "utf8"), live);
	});

	test("the next takeover removes files a crashed process left parked, and keeps one naming a live holder however old (#5220)", () => {
		const { path, content } = staleLock();
		const parked = (owner: string, parkedAt: number, of = path) => {
			const file = `${of}.${parkedAt}.${randomUUID()}.stale`;
			writeTextSync(file, owner);
			return file;
		};
		const dead = "2147483646\n";
		const live = `${process.pid}\n`;
		parked(dead, Date.now());
		parked(dead, Date.now(), `${path}.takeover`);
		parked("", Date.now() - PARKED_FILE_MAX_AGE_MS - 1);
		const oldLive = parked(live, Date.now() - PARKED_FILE_MAX_AGE_MS - 1);
		const justParked = parked(live, Date.now());
		// A parked file that names no holder is kept until it is old.
		const unreadable = parked("", Date.now());
		const unrelated = `${path}.notes`;
		writeTextSync(unrelated, dead);

		takeOverWith(
			path,
			content,
			() => true,
			() => ({ owned: () => true, release: () => {} }),
		);
		assert.equal(fileExistsSync(path), false);
		assert.deepEqual(
			leftovers(path).sort(),
			[basename(oldLive), basename(justParked), basename(unreadable), basename(unrelated)].sort(),
		);
	});

	test("a lock naming a running pid is its holder's unless that pid is known to have started at another time (#5220)", () => {
		const { path } = staleLock();
		const ownStart = processStart(process.pid);
		assert.equal(isAbandoned(path, `${process.pid}\n${ownStart ?? ""}\n`), false);
		assert.equal(isAbandoned(path, `${UNSIGNALLABLE_PID}\n`), false, "a live process this user may not signal");
		assert.equal(isAbandoned(path, "2147483646\n"), true);
		// A start in the form this platform records, of another process: on Windows and macOS a count, one before this
		// process's own (a start in another form proves nothing there).
		const anotherStart =
			ownStart !== undefined && /^\d+$/u.test(ownStart) ? String(BigInt(ownStart) - 1n) : "another start";
		assert.equal(isAbandoned(path, `${process.pid}\n${anotherStart}\n`), ownStart !== undefined);
	});
});

/** Files other than the lock itself that a removal left beside it. */
function leftovers(path: string): string[] {
	const name = basename(path);
	return readdirSync(dirname(path)).filter((entry) => entry.startsWith(`${name}.`));
}
