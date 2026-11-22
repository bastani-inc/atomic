import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { FileAuthStorageBackend } from "../src/core/auth-storage-backends.js";
import {
	lockHolder,
	lockHolderPath,
	prepareTakeoverMutex,
	setNativeLocksForTesting,
	takeoverMutexPath,
	takeTakeoverMutex,
} from "../src/core/lock-takeover.js";
import { waitForLock } from "../src/core/lock-wait.js";
import {
	processStartToken,
	processStartTokenForSynchronousTakeover,
	readProcessStartToken,
	setNativeProcessCreationTimeForTesting,
	setProcessCreationTimeQueryForTesting,
} from "../src/core/process-start-token.js";
import { FileSettingsStorage } from "../src/core/settings-storage.js";
import { ProjectTrustStore } from "../src/core/trust-manager.js";

const CREATION_TIME = "132000000000000000";
const CACHE_EXPIRY_MS = 6_000;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let directory: string;
const children: ChildProcess[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "atomic-start-preparation-"));
	Object.defineProperty(process, "platform", { value: "win32" });
	if (platform.value !== "win32") vi.stubEnv("SystemRoot", tmpdir());
	setNativeProcessCreationTimeForTesting(null);
	setNativeLocksForTesting(null);
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: () => ["-e", `console.log("${CREATION_TIME}")`],
	});
});

afterEach(async () => {
	setProcessCreationTimeQueryForTesting(undefined);
	setNativeProcessCreationTimeForTesting(undefined);
	setNativeLocksForTesting(undefined);
	Object.defineProperty(process, "platform", platform);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const child of children.splice(0)) {
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
			await exited;
		}
	}
	rmSync(directory, { recursive: true, force: true });
});

async function reusedPidMutex(lockPath: string): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	await new Promise<void>((resolve, reject) => child.once("spawn", resolve).once("error", reject));
	mkdirSync(lockPath, { recursive: true });
	const stale = new Date(Date.now() - 60_000);
	utimesSync(lockPath, stale, stale);
	const mutexPath = takeoverMutexPath(lockPath);
	mkdirSync(mutexPath);
	writeFileSync(
		join(mutexPath, "owner"),
		JSON.stringify({ host: hostname(), pid: child.pid, started: "abcdefabcdef", id: "old-owner" }),
	);
	return child.pid!;
}

test("an older background answer cannot replace a synchronous takeover's newer start read (#5315)", async () => {
	let queries = 0;
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: () => ["-e", `console.log("${queries++ === 0 ? "132000000000000001" : CREATION_TIME}")`],
	});
	const pid = 2 ** 22 + 8;
	const background = readProcessStartToken(pid);
	const latest = processStartTokenForSynchronousTakeover(pid);
	assert.match(latest ?? "", /^[0-9a-f]{12}$/);
	assert.equal(await background, latest);
	assert.equal(processStartToken(pid), latest);
	assert.equal(queries, 2);
});

test("an expired pid's re-read keeps its answer when another pid finishes first (#5315)", async () => {
	const pid = 2 ** 22 + 8;
	const release = join(directory, "release-query");
	let reads = 0;
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: (readingPid) => {
			if (readingPid !== pid || ++reads === 1) return ["-e", `console.log("${CREATION_TIME}")`];
			return [
				"-e",
				'const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); console.log("132000000000000001"); } }, 10);',
				release,
			];
		},
	});
	const original = await readProcessStartToken(pid);
	assert.match(original ?? "", /^[0-9a-f]{12}$/);
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + CACHE_EXPIRY_MS);
	const first = readProcessStartToken(pid);
	const second = readProcessStartToken(pid);
	try {
		assert.match((await readProcessStartToken(pid + 4)) ?? "", /^[0-9a-f]{12}$/);
	} finally {
		writeFileSync(release, "");
	}
	const refreshed = await first;
	assert.match(refreshed ?? "", /^[0-9a-f]{12}$/);
	assert.notEqual(refreshed, original);
	assert.equal(await second, refreshed);
	assert.equal(processStartToken(pid), refreshed);
	assert.equal(await readProcessStartToken(pid), refreshed);
	assert.equal(reads, 2);
});

test("an older background answer stays discarded after the newer start expires and is evicted (#5315)", async () => {
	const pid = 2 ** 22 + 8;
	const release = join(directory, "release-query");
	let reads = 0;
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: (readingPid) => {
			if (readingPid !== pid || ++reads > 1) return ["-e", `console.log("${CREATION_TIME}")`];
			return [
				"-e",
				'const fs = require("node:fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); console.log("132000000000000001"); } }, 10);',
				release,
			];
		},
	});
	const background = readProcessStartToken(pid);
	const latest = processStartTokenForSynchronousTakeover(pid);
	assert.match(latest ?? "", /^[0-9a-f]{12}$/);
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + CACHE_EXPIRY_MS);
	try {
		assert.match((await readProcessStartToken(pid + 4)) ?? "", /^[0-9a-f]{12}$/);
	} finally {
		writeFileSync(release, "");
	}
	assert.equal(await background, undefined);
	assert.equal(processStartToken(pid), undefined);
	assert.equal(await readProcessStartToken(pid), latest);
	assert.equal(reads, 3);
});

test("a failed start query's output is refused until a successful retry after cache expiry (#5315)", async () => {
	let queries = 0;
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: () => ["-e", `console.log("${CREATION_TIME}"); process.exitCode = ${queries++ === 0 ? 1 : 0};`],
	});
	const pid = 2 ** 22 + 8;
	assert.equal(await readProcessStartToken(pid), undefined);
	assert.equal(processStartToken(pid), undefined);
	assert.equal(await readProcessStartToken(pid), undefined);
	assert.equal(queries, 1);
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + CACHE_EXPIRY_MS);
	assert.match((await readProcessStartToken(pid)) ?? "", /^[0-9a-f]{12}$/);
	assert.equal(queries, 2);
});

test("a timed-out start read is remembered before another query is allowed (#5315)", async () => {
	let queries = 0;
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: () => {
			queries++;
			return ["-e", queries === 1 ? "setInterval(() => {}, 1000)" : `console.log("${CREATION_TIME}")`];
		},
	});
	const pid = 2 ** 22 + 8;
	assert.equal(await readProcessStartToken(pid), undefined);
	assert.equal(processStartToken(pid), undefined);
	assert.equal(await readProcessStartToken(pid), undefined);
	assert.equal(queries, 1);
	const realNow = Date.now.bind(Date);
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + CACHE_EXPIRY_MS);
	assert.match((await readProcessStartToken(pid)) ?? "", /^[0-9a-f]{12}$/);
	assert.equal(queries, 2);
});

test("a fresh start read bypasses stale negative and positive cache and supersedes an older in-flight query (#5315)", async () => {
	const pid = 2 ** 22 + 8;
	const releaseOld = join(directory, "release-old-query");
	let call = 0;
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: () => {
			call++;
			if (call === 1) return ["-e", "process.exitCode = 1"];
			if (call === 2) return ["-e", 'console.log("132000000000000001")'];
			if (call === 3) return ["-e", 'console.log("132000000000000002")'];
			if (call === 4)
				return [
					"-e",
					'const fs = require("node:fs"); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(t); console.log("132000000000000003"); } }, 10);',
					releaseOld,
				];
			return ["-e", 'console.log("132000000000000004")'];
		},
	});
	// 1) Stale negative cache (failed/dead query) is bypassed by a fresh read.
	assert.equal(await readProcessStartToken(pid), undefined);
	const first = await readProcessStartToken(pid, { fresh: true });
	assert.match(first ?? "", /^[0-9a-f]{12}$/);
	// 2) Stale positive cache (previous process with same PID) is bypassed by a fresh read.
	const second = await readProcessStartToken(pid, { fresh: true });
	assert.match(second ?? "", /^[0-9a-f]{12}$/);
	assert.notEqual(second, first);
	// 3) An older in-flight query is superseded by a fresh read and cannot overwrite the cache.
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now + CACHE_EXPIRY_MS);
	const older = readProcessStartToken(pid);
	const newer = await readProcessStartToken(pid, { fresh: true });
	assert.match(newer ?? "", /^[0-9a-f]{12}$/);
	assert.notEqual(newer, second);
	writeFileSync(releaseOld, "");
	assert.equal(await older, newer);
	assert.equal(processStartToken(pid), newer);
	assert.equal(await readProcessStartToken(pid), newer);
	assert.equal(call, 5);
});

test("uncontended auth saves and provider refreshes never wait for a fallback start read (#5315)", async () => {
	let queries = 0;
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: () => {
			queries++;
			return ["-e", "setInterval(() => {}, 1000)"];
		},
	});
	const backend = new FileAuthStorageBackend(join(directory, "auth.json"));
	for (let save = 0; save < 2; save++) {
		await backend.withLockAsync(async () => ({ result: undefined, next: "{}" }));
		await backend.modifyProviderAsync("example", async () => undefined);
	}
	assert.equal(queries, 0);
});

test("a cancelled lock waiter does not wait for an unanswered start read (#5315)", async () => {
	let preparing!: () => void;
	let finishPreparation!: () => void;
	const preparationStarted = new Promise<void>((resolve) => {
		preparing = resolve;
	});
	const preparation = new Promise<void>((resolve) => {
		finishPreparation = resolve;
	});
	const takeover = await import("../src/core/lock-takeover.js");
	vi.spyOn(takeover, "prepareTakeoverMutex").mockImplementation(() => {
		preparing();
		return preparation;
	});
	const controller = new AbortController();
	const reason = new Error("cancelled while reading a start");
	let cancelled = false;
	const waiting = waitForLock(
		async () => {
			throw Object.assign(new Error("busy"), { code: "ELOCKED" });
		},
		{
			lockPath: join(directory, "provider.lock"),
			staleMs: 10_000,
			holderWaitMs: 10_000,
			pollMinMs: 10,
			pollMaxMs: 50,
			retryable: () => true,
			stuck: () => new Error("stuck"),
			contended: () => new Error("contended"),
		},
		controller.signal,
	).catch((error: Error) => {
		assert.equal(error, reason);
		cancelled = true;
	});
	try {
		await preparationStarted;
		controller.abort(reason);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(cancelled, true);
	} finally {
		finishPreparation();
		await waiting;
	}
});

test("a dead holder's expired start is refreshed after a peer read times out and delays the save (#5315)", async () => {
	const path = join(directory, "settings.json");
	const lockPath = `${path}.lock`;
	const holderPid = await reusedPidMutex(lockPath);
	rmSync(takeoverMutexPath(lockPath), { recursive: true });
	writeFileSync(path, "{}");
	writeFileSync(
		lockHolderPath(lockPath),
		JSON.stringify({ host: hostname(), pid: holderPid, started: "abcdefabcdef", lock: lockHolder(lockPath) }),
	);
	const reads = new Map<number, number>();
	setProcessCreationTimeQueryForTesting({
		file: process.execPath,
		args: (pid) => {
			reads.set(pid, (reads.get(pid) ?? 0) + 1);
			return ["-e", pid === process.pid ? "setInterval(() => {}, 1000)" : `console.log("${CREATION_TIME}")`];
		},
	});
	const realNow = Date.now.bind(Date);
	const timeoutAt = realNow() + 4_900;
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + (realNow() >= timeoutAt ? CACHE_EXPIRY_MS : 0));
	const storage = new FileSettingsStorage(directory, directory);
	await storage.prepareWriteLock("global");
	const fresh = new Date(Date.now());
	utimesSync(lockPath, fresh, fresh);
	storage.withPrimaryWriteLock("global", () => JSON.stringify({ theme: "dark" }));
	assert.equal((JSON.parse(readFileSync(path, "utf8")) as { theme?: string }).theme, "dark");
	assert.equal(reads.get(process.pid), 1);
	assert.equal(reads.get(holderPid), 2);
});

for (const target of ["trust", "auth"] as const) {
	test(`a cold synchronous ${target} save recovers a stale mutex whose owner's pid was reused (#5315)`, async () => {
		const path = join(directory, `${target}.json`);
		writeFileSync(path, "{}");
		const lockPath = `${path}.lock`;
		await reusedPidMutex(lockPath);
		if (target === "trust") {
			const store = new ProjectTrustStore(directory);
			store.set(directory, true);
			assert.equal(store.get(directory), true);
		} else {
			const backend = new FileAuthStorageBackend(path);
			backend.withLock(() => ({ result: undefined, next: JSON.stringify({ saved: true }) }));
			assert.equal((JSON.parse(backend.read() ?? "{}") as { saved?: boolean }).saved, true);
		}
	});

	test(`a synchronous ${target} save uses an answered start read even after the query took longer than its cache window (#5315)`, async () => {
		const path = join(directory, `${target}.json`);
		writeFileSync(path, "{}");
		const lockPath = `${path}.lock`;
		await reusedPidMutex(lockPath);
		const realNow = Date.now.bind(Date);
		let offset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
		const preparing = prepareTakeoverMutex(lockPath);
		offset = CACHE_EXPIRY_MS;
		await preparing;
		if (target === "trust") {
			const store = new ProjectTrustStore(directory);
			store.set(directory, true);
			assert.equal(store.get(directory), true);
		} else {
			const backend = new FileAuthStorageBackend(path);
			backend.withLock(() => ({
				result: undefined,
				next: JSON.stringify({ example: { type: "api_key", key: "test" } }),
			}));
			assert.match(backend.read() ?? "", /example/);
		}
		const mutex = takeTakeoverMutex(lockPath);
		assert.ok(mutex);
		try {
			const owner = JSON.parse(readFileSync(join(takeoverMutexPath(lockPath), "owner"), "utf8")) as {
				started?: string;
			};
			assert.equal(owner.started, await readProcessStartToken(process.pid));
			assert.match(owner.started ?? "", /^[0-9a-f]{12}$/);
		} finally {
			mutex.release();
		}
	});
}
