/**
 * Concurrent takeovers of a dead session claim (#5179): without the native advisory lock (#5193), takeovers take turns
 * under the owner-checked directory takeover mutex,
 * and a dead claim is moved aside and removed only when the moved record is still the dead one, so at most one process
 * ever holds a session. Real child processes claim the session while this process is held at a check-then-act point.
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
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

/**
 * Hooks that run once just before this process removes or moves a session claim, or removes or moves a takeover
 * mutex, as another process would act in between (#5179).
 */
const race = vi.hoisted(() => ({
	claimFile: undefined as string | undefined,
	beforeClaimRemoval: undefined as (() => void) | undefined,
	beforeMutexRemoval: undefined as (() => void) | undefined,
	/** What a hook threw: the code it runs inside treats a failed removal as a lost race and goes on. */
	hookError: undefined as unknown,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const run = (hook: (() => void) | undefined) => {
		try {
			hook?.();
		} catch (error) {
			race.hookError ??= error;
			throw error;
		}
	};
	const before = (path: unknown) => {
		const target = String(path);
		if (race.claimFile === undefined) return;
		if (target === race.claimFile) {
			const hook = race.beforeClaimRemoval;
			race.beforeClaimRemoval = undefined;
			run(hook);
		} else if (target === `${race.claimFile}.takeover`) {
			const hook = race.beforeMutexRemoval;
			race.beforeMutexRemoval = undefined;
			run(hook);
		}
	};
	const renameSync: typeof actual.renameSync = (from, to) => {
		before(from);
		actual.renameSync(from, to);
	};
	const rmSync: typeof actual.rmSync = (path, options) => {
		before(path);
		actual.rmSync(path, options);
	};
	const rmdirSync: typeof actual.rmdirSync = (path, options) => {
		before(path);
		actual.rmdirSync(path, options);
	};
	return {
		...actual,
		default: { ...actual, renameSync, rmSync, rmdirSync },
		renameSync,
		rmSync,
		rmdirSync,
	};
});

const { claimSession } = await import("../src/core/session-claims.js");
const { setNativeLocksForTesting } = await import("../src/core/lock-takeover.js");
const { SessionAlreadyOpenError } = await import("../src/core/session-manager-errors.ts");

const SESSION_CLAIMS_MODULE = fileURLToPath(new URL("../src/core/session-claims.ts", import.meta.url));
const LOCK_TAKEOVER_MODULE = fileURLToPath(new URL("../src/core/lock-takeover.ts", import.meta.url));
const PROCESS_START_TOKEN_MODULE = fileURLToPath(new URL("../src/core/process-start-token.ts", import.meta.url));
/** Whether this process and the others it starts take over through the native advisory lock (#5193). */
let native = false;
/** How long another process may take to report how its claim went. */
const CHILD_TIMEOUT_MS = 60_000;

let agentDir: string;
let sessionId: string;
let claimFile: string;
const releases: (() => void)[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
	agentDir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-claim-takeover-race-")));
	sessionId = `race-${randomUUID()}`;
	claimFile = join(agentDir, "session-claims", `${sessionId}.json`);
	race.claimFile = claimFile;
	native = false;
	setNativeLocksForTesting(null);
	race.beforeClaimRemoval = undefined;
	race.beforeMutexRemoval = undefined;
	race.hookError = undefined;
	mkdirSync(join(agentDir, "session-claims"), { recursive: true });
	writeFileSync(claimFile, JSON.stringify({ token: "dead", ...exitedProcess(), host: hostname() }));
});

afterEach(() => {
	race.claimFile = undefined;
	setNativeLocksForTesting(undefined);
	while (releases.length > 0) releases.pop()?.();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	rmSync(agentDir, { recursive: true, force: true });
});

/**
 * A process that exited, named as a claim names its holder: by its pid and, where that can be read, when it started,
 * which it reads itself while it runs. Windows soon gives an exited process's pid to another process, and only the
 * start tells that process from the one that exited; a claim naming the pid alone would be that process's.
 */
function exitedProcess(): { readonly pid: number; readonly started?: string } {
	const exited = spawnSync(
		"bun",
		[
			"--eval",
			`const { processStartToken } = await import(${JSON.stringify(PROCESS_START_TOKEN_MODULE)});
			process.stdout.write(JSON.stringify({ pid: process.pid, started: processStartToken(process.pid) }));`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(exited.status, 0, exited.stderr);
	return JSON.parse(exited.stdout) as { pid: number; started?: string };
}

function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How a claim of the session went: held by the process with `pid`, or refused with an error named `error`. */
type Outcome = { readonly held: true; readonly pid: number } | { readonly held: false; readonly error: string };

/**
 * Starts another process that claims the session and reports how it went to a file; one that took the claim keeps
 * running, holding it, until the test ends.
 */
function anotherProcessClaims(): () => Outcome | undefined {
	const report = join(agentDir, `outcome-${randomUUID()}.json`);
	const script = `
		import { renameSync, writeFileSync } from "node:fs";
		import { claimSession } from ${JSON.stringify(SESSION_CLAIMS_MODULE)};
		import { setNativeLocksForTesting } from ${JSON.stringify(LOCK_TAKEOVER_MODULE)};
		if (!${native}) setNativeLocksForTesting(null);
		let outcome;
		try {
			claimSession(${JSON.stringify(sessionId)}, { agentDir: ${JSON.stringify(agentDir)} });
			outcome = { held: true, pid: process.pid };
		} catch (error) {
			outcome = { held: false, error: error?.name === "Error" ? String(error.code ?? error.message) : error?.name };
		}
		// Whole or not at all: a report read while it is being written would read as no report.
		writeFileSync(${JSON.stringify(`${report}.tmp`)}, JSON.stringify(outcome));
		renameSync(${JSON.stringify(`${report}.tmp`)}, ${JSON.stringify(report)});
		if (outcome.held) setInterval(() => {}, 1000);
	`;
	children.push(spawn("bun", ["--eval", script], { stdio: "ignore" }));
	return () => (existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as Outcome) : undefined);
}

/** Waits, holding this process still, until every other process reported how its claim went. */
function outcomesOf(reports: readonly (() => Outcome | undefined)[]): Outcome[] {
	const deadline = Date.now() + CHILD_TIMEOUT_MS;
	for (;;) {
		const outcomes = reports.map((report) => report());
		if (outcomes.every((outcome) => outcome !== undefined)) return outcomes as Outcome[];
		assert.ok(Date.now() < deadline, "another process never reported how its claim went");
		sleep(20);
	}
}

/** How this process's claim of the session went. Rethrows what a hook it ran into threw. */
function thisProcessClaims(): Outcome {
	let outcome: Outcome;
	try {
		releases.push(claimSession(sessionId, { agentDir }));
		outcome = { held: true, pid: process.pid };
	} catch (error) {
		if (error instanceof SessionAlreadyOpenError) outcome = { held: false, error: error.name };
		else outcome = { held: false, error: String((error as NodeJS.ErrnoException).code ?? error) };
	}
	if (race.hookError !== undefined) throw race.hookError;
	return outcome;
}

function claimHolderPid(): number | undefined {
	if (!existsSync(claimFile)) return undefined;
	return (JSON.parse(readFileSync(claimFile, "utf8")) as { pid: number }).pid;
}

/** Ages `path` as a process paused for longer than a takeover lock's stale age would see it. */
function age(path: string): void {
	const old = new Date(Date.now() - 11_000);
	utimesSync(path, old, old);
}

describe("concurrent takeovers of a dead session claim (#5179)", () => {
	test(
		"three processes taking over a dead claim, one paused mid-takeover, leave exactly one holder (#5179)",
		() => {
			const mutex = `${claimFile}.takeover`;
			// A takeover killed earlier left its lock behind, naming no owner.
			mkdirSync(mutex);
			age(mutex);
			let others: Outcome[] = [];
			race.beforeClaimRemoval = () => {
				// This process is paused between finding the claim dead and removing it, for longer than the stale age.
				if (existsSync(mutex)) age(mutex);
				others = outcomesOf([anotherProcessClaims(), anotherProcessClaims()]);
			};
			const outcomes = [thisProcessClaims(), ...others];
			assert.equal(others.length, 2, "the other processes claimed while this one was paused");
			const holders = outcomes.filter((outcome) => outcome.held);
			assert.equal(holders.length, 1, `exactly one process holds the session: ${JSON.stringify(outcomes)}`);
			for (const outcome of outcomes) {
				if (!outcome.held) assert.equal(outcome.error, "SessionAlreadyOpenError", JSON.stringify(outcomes));
			}
			assert.equal(claimHolderPid(), holders[0]!.held ? holders[0]!.pid : undefined, "the claim names its holder");
		},
		CHILD_TIMEOUT_MS * 2,
	);

	test(
		"a takeover lock another process took after this one judged the stale lock is left to it (#5179)",
		() => {
			const mutex = `${claimFile}.takeover`;
			mkdirSync(mutex);
			age(mutex);
			let other: Outcome[] = [];
			race.beforeMutexRemoval = () => {
				// Another process breaks the stale lock and takes the claim over first.
				rmSync(mutex, { recursive: true });
				other = outcomesOf([anotherProcessClaims()]);
			};
			const mine = thisProcessClaims();
			assert.deepEqual(other.length, 1);
			assert.deepEqual([mine, ...other].filter((outcome) => outcome.held).length, 1, JSON.stringify([mine, other]));
			assert.deepEqual(mine, { held: false, error: "SessionAlreadyOpenError" });
			assert.equal(claimHolderPid(), (other[0] as { pid: number }).pid);
		},
		CHILD_TIMEOUT_MS * 2,
	);

	test("a takeover lock whose owner is a live process is never broken, however old (#5179)", () => {
		const mutex = `${claimFile}.takeover`;
		mkdirSync(mutex);
		writeFileSync(join(mutex, "owner"), JSON.stringify({ host: hostname(), pid: process.pid, id: "live" }));
		age(mutex);
		const before = readFileSync(claimFile, "utf8");
		assert.deepEqual(thisProcessClaims(), { held: false, error: "SessionAlreadyOpenError" });
		assert.equal(readFileSync(claimFile, "utf8"), before, "the dead claim is left to the live takeover");
		assert.equal(existsSync(join(mutex, "owner")), true, "the live takeover keeps its lock");
	});

	test("a takeover lock whose owner is dead is broken at once, and the claim taken over (#5179)", () => {
		const mutex = `${claimFile}.takeover`;
		mkdirSync(mutex);
		writeFileSync(join(mutex, "owner"), JSON.stringify({ host: hostname(), ...exitedProcess(), id: "dead" }));
		assert.deepEqual(thisProcessClaims(), { held: true, pid: process.pid });
		assert.equal(claimHolderPid(), process.pid);
		assert.equal(existsSync(mutex), false);
	});

	test("a claim moved aside that is not the dead one is linked back while no claim is in its place (#5193)", () => {
		native = true;
		setNativeLocksForTesting(undefined);
		let live: Outcome[] = [];
		race.beforeClaimRemoval = () => {
			// Only a remover outside the takeover lock could swap the claim this late: another process claims it.
			rmSync(claimFile);
			live = outcomesOf([anotherProcessClaims()]);
		};
		assert.deepEqual(thisProcessClaims(), { held: false, error: "SessionAlreadyOpenError" });
		assert.equal(live.length, 1);
		assert.ok(live[0]!.held);
		const asides = readdirSync(join(agentDir, "session-claims")).filter((name) => name.endsWith(".dead"));
		assert.deepEqual(asides, [], "the claim that was moved is not left aside");
		assert.equal(claimHolderPid(), live[0]!.pid, "the live claim is back in place");
	});
});
