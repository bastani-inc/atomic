/**
 * Takeovers of a dead holder's lock race each other across real processes (#5193): a takeover mutex left by a killed
 * process, takers paused between judging what is at a path and moving it, and a later taker acting while one is
 * paused. Whatever the interleaving, at most one process holds the settings lock or the session claim, and the one
 * that holds it still has it in place.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, test } from "vitest";

const MODULE = (name: string) => fileURLToPath(new URL(`../src/core/${name}`, import.meta.url));
/** How long another process may take to report how its attempt went, or that it paused. */
const CHILD_TIMEOUT_MS = 60_000;
/** How long a taker is given to pause or report before it is judged waiting for another to finish. */
const SETTLE_MS = 5_000;

let directory: string;
const children: ChildProcess[] = [];

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-takeover-os-lock-")));
});

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(directory, { recursive: true, force: true });
});

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What a taker reported: whether it holds what it tried to take, and what it holds. */
interface Outcome {
	readonly held: boolean;
	readonly pid: number;
	readonly lock?: string;
	readonly error?: string;
}

/** Another process, run until it pauses or reports. */
interface Taker {
	paused(): boolean;
	outcome(): Outcome | undefined;
	resume(): void;
}

/** Where a taker pauses: at its first move of `path`, or, with `mutex`, of its takeover mutex too. */
interface PauseAt {
	readonly path: string;
	readonly mutex: boolean;
}

/**
 * Starts another process that runs `body`, which sets `outcome`. With `pauseAt`, it is held at its first move or
 * removal of a path `pauseAt` matches, as a process paused between judging the path and moving it, until resumed.
 */
function startTaker(body: string, pauseAt?: PauseAt): Taker {
	const base = join(directory, `taker-${randomUUID()}`);
	// The modules under test import node:fs through this shim, which holds the process at its first matching move.
	const shim = `${base}.fs.mjs`;
	writeFileSync(
		shim,
		`
		import * as fs from "node:fs";
		export * from "node:fs";
		const pauseAt = ${JSON.stringify(pauseAt ?? null)};
		let paused = false;
		const pause = (path) => {
			const target = String(path);
			if (pauseAt === null || paused) return;
			if (target !== pauseAt.path && !(pauseAt.mutex && target.startsWith(pauseAt.path + ".takeover"))) return;
			paused = true;
			fs.writeFileSync(${JSON.stringify(`${base}.paused`)}, target);
			while (!fs.existsSync(${JSON.stringify(`${base}.go`)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		};
		const hooked = (name) => (path, ...rest) => { pause(path); return fs[name](path, ...rest); };
		export const renameSync = hooked("renameSync");
		export const rmSync = hooked("rmSync");
		export const rmdirSync = hooked("rmdirSync");
		export const unlinkSync = hooked("unlinkSync");
		export default { ...fs, renameSync, rmSync, rmdirSync, unlinkSync };
	`,
	);
	const script = `
		import { readFileSync, renameSync, writeFileSync } from "node:fs";
		Bun.plugin({
			setup(build) {
				build.onLoad({ filter: /[\\\\/]src[\\\\/]core[\\\\/][^\\\\/]+\\.ts$/ }, (args) => ({
					loader: "ts",
					contents: readFileSync(args.path, "utf8").replaceAll('from "node:fs"', ${JSON.stringify(`from ${JSON.stringify(pathToFileURL(shim).href)}`)}),
				}));
			},
		});
		let outcome;
		try {
			${body}
		} catch (error) {
			outcome = { held: false, pid: process.pid, error: error?.name === "Error" ? String(error.code ?? error.message) : error?.name };
		}
		// Whole or not at all: a report read while it is being written would read as empty or partial JSON.
		writeFileSync(${JSON.stringify(`${base}.json.tmp`)}, JSON.stringify(outcome));
		renameSync(${JSON.stringify(`${base}.json.tmp`)}, ${JSON.stringify(`${base}.json`)});
		if (outcome.held) setInterval(() => {}, 1000);
	`;
	children.push(spawn("bun", ["--eval", script], { stdio: "ignore" }));
	return {
		paused: () => existsSync(`${base}.paused`),
		outcome: () =>
			existsSync(`${base}.json`) ? (JSON.parse(readFileSync(`${base}.json`, "utf8")) as Outcome) : undefined,
		resume: () => writeFileSync(`${base}.go`, ""),
	};
}

/** Waits until `taker` pauses or reports; for at most `ms`, after which it is judged waiting on another taker. */
function settle(taker: Taker, ms: number = SETTLE_MS): void {
	const deadline = Date.now() + ms;
	while (!taker.paused() && taker.outcome() === undefined && Date.now() < deadline) sleep(20);
}

function reported(taker: Taker): Outcome {
	const deadline = Date.now() + CHILD_TIMEOUT_MS;
	for (;;) {
		const outcome = taker.outcome();
		if (outcome !== undefined) return outcome;
		assert.ok(Date.now() < deadline, "another process never reported how its attempt went");
		sleep(20);
	}
}

/**
 * A takeover mutex left by a killed process: another process runs `body`, a takeover, and is killed while it holds
 * the mutex, paused just before it moves `target`.
 */
async function killedMidTakeover(body: string, target: string): Promise<void> {
	const taker = startTaker(body, { path: target, mutex: false });
	settle(taker, CHILD_TIMEOUT_MS);
	assert.equal(
		taker.paused(),
		true,
		`the process to be killed is paused mid-takeover: ${JSON.stringify(taker.outcome())}`,
	);
	const child = children.at(-1)!;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGKILL");
	// Reaped, it is gone: what it held is released, and its pid names no running process.
	await exited;
}

/** A process paused for seconds sees every takeover directory of `prefix` as that much older. */
function secondsPass(prefix: string): void {
	const old = new Date(Date.now() - 11_000);
	for (const name of readdirSync(dirname(prefix))) {
		const path = join(dirname(prefix), name);
		if (path.startsWith(`${prefix}.takeover`) && statSync(path).isDirectory()) utimesSync(path, old, old);
	}
}

/**
 * A claim left by a process that exited, naming it as a claim names its holder: by its pid and, where that can be read,
 * when it started, which it reads itself while it runs. Windows soon gives an exited process's pid to another process,
 * and only the start tells that process from the holder; a claim naming the pid alone would be that process's.
 */
function deadClaim(): string {
	const exited = spawnSync(
		"bun",
		[
			"--eval",
			`const { processStartToken } = await import(${JSON.stringify(MODULE("process-start-token.ts"))});
			process.stdout.write(JSON.stringify({ pid: process.pid, started: processStartToken(process.pid) }));`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(exited.status, 0, exited.stderr);
	const { pid, started } = JSON.parse(exited.stdout) as { pid: number; started?: string };
	return JSON.stringify({ token: "dead", pid, host: hostname(), ...(started === undefined ? {} : { started }) });
}

describe("takeovers under an OS advisory lock (#5193)", () => {
	test(
		"a dead-owner mutex, two takers paused between judging and moving, and a third never admit two holders of the settings lock (#5193)",
		async () => {
			const lockPath = join(directory, "settings.json.lock");
			// The dead holder took the lock and named itself, then exited.
			const deadHolder = spawnSync(
				"bun",
				[
					"--eval",
					`const { mkdirSync } = await import("node:fs");
					const { recordLockHolder } = await import(${JSON.stringify(MODULE("lock-holder.ts"))});
					mkdirSync(${JSON.stringify(lockPath)});
					recordLockHolder(${JSON.stringify(lockPath)});`,
				],
				{ encoding: "utf8" },
			);
			assert.equal(deadHolder.status, 0, deadHolder.stderr);
			assert.ok(existsSync(`${lockPath}.holder`));
			// Each taker takes over a dead holder, then takes the lock as proper-lockfile does and names itself.
			const body = `
				const { mkdirSync, statSync } = await import("node:fs");
				const { takeOverDeadHolder, recordLockHolder } = await import(${JSON.stringify(MODULE("lock-holder.ts"))});
				const lockPath = ${JSON.stringify(lockPath)};
				takeOverDeadHolder(lockPath);
				try {
					mkdirSync(lockPath);
					recordLockHolder(lockPath);
					const stats = statSync(lockPath);
					outcome = { held: true, pid: process.pid, lock: String(stats.ino) };
				} catch (error) {
					outcome = { held: false, pid: process.pid, error: error.code };
				}
			`;
			await killedMidTakeover(body, lockPath);
			const first = startTaker(body, { path: lockPath, mutex: true });
			settle(first);
			const second = startTaker(body, { path: lockPath, mutex: false });
			settle(second);
			first.resume();
			reported(first);
			const third = startTaker(body);
			settle(third);
			second.resume();
			const outcomes = [reported(first), reported(second), reported(third)];
			const holders = outcomes.filter((outcome) => outcome.held);
			assert.ok(holders.length <= 1, `at most one process holds the settings lock: ${JSON.stringify(outcomes)}`);
			for (const holder of holders) {
				assert.equal(
					existsSync(lockPath) ? String(statSync(lockPath).ino) : undefined,
					holder.lock,
					"the holder's lock is still in place",
				);
			}
		},
		CHILD_TIMEOUT_MS * 3,
	);

	test(
		"a dead-owner mutex, two takers paused between judging and moving, and a third never admit two holders of a session claim nor lose a live one (#5193)",
		async () => {
			const agentDir = join(directory, "agent");
			const sessionId = `race-${randomUUID()}`;
			const claimFile = join(agentDir, "session-claims", `${sessionId}.json`);
			mkdirSync(dirname(claimFile), { recursive: true });
			writeFileSync(claimFile, deadClaim());
			const body = `
				const { claimSession } = await import(${JSON.stringify(MODULE("session-claims.ts"))});
				claimSession(${JSON.stringify(sessionId)}, { agentDir: ${JSON.stringify(agentDir)} });
				outcome = { held: true, pid: process.pid };
			`;
			await killedMidTakeover(body, claimFile);
			secondsPass(claimFile);
			const first = startTaker(body, { path: claimFile, mutex: true });
			settle(first);
			secondsPass(claimFile);
			const second = startTaker(body, { path: claimFile, mutex: false });
			settle(second);
			secondsPass(claimFile);
			first.resume();
			reported(first);
			const third = startTaker(body);
			settle(third);
			second.resume();
			const outcomes = [reported(first), reported(second), reported(third)];
			// One more process claims once all are done: a lost live claim would let it in too.
			outcomes.push(reported(startTaker(body)));
			const holders = outcomes.filter((outcome) => outcome.held);
			assert.equal(holders.length, 1, `exactly one process holds the session: ${JSON.stringify(outcomes)}`);
			for (const outcome of outcomes) {
				if (!outcome.held) assert.equal(outcome.error, "SessionAlreadyOpenError", JSON.stringify(outcomes));
			}
			const claim = JSON.parse(readFileSync(claimFile, "utf8")) as { pid: number };
			assert.equal(claim.pid, holders[0]!.pid, "the live claim names its holder");
		},
		CHILD_TIMEOUT_MS * 4,
	);

	test(
		"a takeover on the directory-mutex fallback and a native takeover exclude each other: one holder of the settings lock (#5193)",
		() => {
			const lockPath = join(directory, "settings.json.lock");
			const deadHolder = spawnSync(
				"bun",
				[
					"--eval",
					`const { mkdirSync } = await import("node:fs");
					const { recordLockHolder } = await import(${JSON.stringify(MODULE("lock-holder.ts"))});
					mkdirSync(${JSON.stringify(lockPath)});
					recordLockHolder(${JSON.stringify(lockPath)});`,
				],
				{ encoding: "utf8" },
			);
			assert.equal(deadHolder.status, 0, deadHolder.stderr);
			const body = (fallback: boolean) => `
				const { mkdirSync, statSync } = await import("node:fs");
				const { setNativeLocksForTesting } = await import(${JSON.stringify(MODULE("lock-takeover.ts"))});
				if (${fallback}) setNativeLocksForTesting(null);
				const { takeOverDeadHolder, recordLockHolder } = await import(${JSON.stringify(MODULE("lock-holder.ts"))});
				const lockPath = ${JSON.stringify(lockPath)};
				takeOverDeadHolder(lockPath);
				try {
					mkdirSync(lockPath);
					recordLockHolder(lockPath);
					outcome = { held: true, pid: process.pid, lock: String(statSync(lockPath).ino) };
				} catch (error) {
					outcome = { held: false, pid: process.pid, error: error.code };
				}
			`;
			// A process whose native module has no advisory lock is paused inside its takeover, before its move.
			const fallback = startTaker(body(true), { path: lockPath, mutex: false });
			settle(fallback, CHILD_TIMEOUT_MS);
			assert.equal(fallback.paused(), true, `the fallback taker is paused: ${JSON.stringify(fallback.outcome())}`);
			const native = startTaker(body(false));
			settle(native);
			fallback.resume();
			const outcomes = [reported(fallback), reported(native)];
			const holders = outcomes.filter((outcome) => outcome.held);
			assert.equal(holders.length, 1, `exactly one process holds the settings lock: ${JSON.stringify(outcomes)}`);
			assert.equal(existsSync(lockPath) ? String(statSync(lockPath).ino) : undefined, holders[0]!.lock);
			assert.deepEqual(
				readdirSync(directory).filter((name) => name.endsWith(".dead")),
				[],
				"no live lock is left aside",
			);
		},
		CHILD_TIMEOUT_MS * 2,
	);

	test("a live claim moved aside by a takeover is linked back while no claim is in its place (#5193)", () => {
		const agentDir = join(directory, "agent");
		const sessionId = `race-${randomUUID()}`;
		const claimFile = join(agentDir, "session-claims", `${sessionId}.json`);
		mkdirSync(dirname(claimFile), { recursive: true });
		writeFileSync(claimFile, deadClaim());
		const taker = startTaker(
			`
				const { claimSession } = await import(${JSON.stringify(MODULE("session-claims.ts"))});
				claimSession(${JSON.stringify(sessionId)}, { agentDir: ${JSON.stringify(agentDir)} });
				outcome = { held: true, pid: process.pid };
			`,
			{ path: claimFile, mutex: false },
		);
		settle(taker, CHILD_TIMEOUT_MS);
		assert.equal(taker.paused(), true, "the taker is paused inside its takeover");
		// Only a process outside the takeover mutex could swap the claim this late: a live process claims the session.
		const live = JSON.stringify({ token: "live", pid: process.pid, host: hostname() });
		rmSync(claimFile);
		writeFileSync(claimFile, live);
		taker.resume();
		assert.deepEqual(reported(taker), { held: false, pid: reported(taker).pid, error: "SessionAlreadyOpenError" });
		assert.equal(readFileSync(claimFile, "utf8"), live, "the live claim is back in place");
		assert.deepEqual(
			readdirSync(dirname(claimFile)).filter((name) => name.endsWith(".dead")),
			[],
		);
	});

	test(
		"processes killed at random while they take and give up the advisory mutex never let two in at once (#5193)",
		async () => {
			const lockPath = join(directory, "stress.lock");
			const owner = join(directory, "owner");
			const violations = join(directory, "violations");
			const entries = join(directory, "entries");
			const worker = `
				const { appendFileSync, readFileSync, writeFileSync } = await import("node:fs");
				const { takeTakeoverMutex } = await import(${JSON.stringify(MODULE("lock-takeover.ts"))});
				const me = String(process.pid);
				for (;;) {
					const mutex = takeTakeoverMutex(${JSON.stringify(lockPath)}, 1000);
					if (mutex === undefined) continue;
					writeFileSync(${JSON.stringify(owner)}, me);
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
					if (readFileSync(${JSON.stringify(owner)}, "utf8") !== me) appendFileSync(${JSON.stringify(violations)}, me + "\\n");
					appendFileSync(${JSON.stringify(entries)}, ".");
					mutex.release();
				}
			`;
			const start = () => {
				const child = spawn("bun", ["--eval", worker], { stdio: "ignore" });
				const exited = new Promise((resolve) => child.once("exit", resolve));
				return { child, exited };
			};
			let workers = Array.from({ length: 4 }, start);
			const deadline = Date.now() + 6_000;
			let kills = 0;
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 150)));
				const index = Math.floor(Math.random() * workers.length);
				const victim = workers[index]!;
				victim.child.kill("SIGKILL");
				await victim.exited;
				kills++;
				workers = [...workers.slice(0, index), ...workers.slice(index + 1), start()];
			}
			for (const { child, exited } of workers) {
				child.kill("SIGKILL");
				await exited;
			}
			assert.equal(existsSync(violations) ? readFileSync(violations, "utf8") : "", "", "never two holders at once");
			const entered = existsSync(entries) ? readFileSync(entries, "utf8").length : 0;
			assert.ok(entered >= 20, `the mutex changed hands ${entered} times across ${kills} kills`);
			const { takeTakeoverMutex } = await import("../src/core/lock-takeover.js");
			const mutex = takeTakeoverMutex(lockPath, 5_000);
			assert.ok(mutex, "no killed holder keeps the mutex");
			mutex.release();
		},
		CHILD_TIMEOUT_MS,
	);
});
