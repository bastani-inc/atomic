import assert from "node:assert/strict";
// `readdirSync` has no equivalent in test/helpers/runtime.ts: the spawners report readiness as files in one directory.
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, test } from "vitest";
import { acquireSpawnLock, releaseSpawnLock, replaceStaleSpawnLock } from "../../packages/intercom/broker/spawn.js";
import { removeFileIfUnchanged, takeOverStaleLock } from "../../packages/intercom/broker/stale-lock-file.js";
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

	test("a stale lock is replaced while it is still the one inspected (#5132)", () => {
		const { path, content } = staleLock();
		replaceStaleSpawnLock(content, path);
		assert.equal(fileExistsSync(path), false);

		const owner = acquireSpawnLock(path);
		assert.ok(owner !== undefined);
		releaseSpawnLock(owner, path);
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

	test("a takeover token held by a live process blocks the takeover and is left alone (#5132)", () => {
		const { path, content } = staleLock();
		const token = `${path}.takeover`;
		writeTextSync(token, `${process.pid}\n`);

		takeOverStaleLock(path, content, token);
		assert.equal(readTextSync(path, "utf8"), content);
		assert.equal(readTextSync(token, "utf8"), `${process.pid}\n`);
	});

	test("a takeover token left by a dead process is removed, so the next attempt replaces the lock (#5132)", () => {
		const { path, content } = staleLock();
		const token = `${path}.takeover`;
		writeTextSync(token, "2147483646\n");

		takeOverStaleLock(path, content, token);
		assert.equal(fileExistsSync(token), false);
		assert.equal(readTextSync(path, "utf8"), content);

		takeOverStaleLock(path, content, token);
		assert.equal(fileExistsSync(path), false);
		assert.equal(fileExistsSync(token), false);
	});
});

/** Files other than the lock itself that a removal left beside it. */
function leftovers(path: string): string[] {
	const name = basename(path);
	return readdirSync(dirname(path)).filter((entry) => entry.startsWith(`${name}.`));
}
