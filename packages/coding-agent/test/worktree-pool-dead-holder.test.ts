import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { spawnProcess } from "../../../test/helpers/runtime.js";
import { lockHolderPath } from "../src/core/lock-holder.js";
import { readProcessStartToken } from "../src/core/process-start-token.js";
import {
	admitPooledWorktree,
	discardPooledWorktree,
	holdRestoredWorktree,
	releaseRestoredWorktree,
	repositoryIdOf,
} from "../src/core/worktree-snapshot/pool.js";
import { withWorktreeLockProgress } from "../src/core/worktree-snapshot/shared-lock.js";

const remotes = ["https://example.com/acme/repo.git"];
const owner = { kind: "session" as const, id: "session-owner" };
const lastState = { snapshotId: null, head: "a".repeat(40), tree: "b".repeat(40) };
// Leave room for a loaded runner, but fail well before the legacy 30-second stale window.
const TAKEOVER_BUDGET_MS = 5_000;
let storeDir: string;

beforeEach(async () => {
	storeDir = await mkdtemp(join(tmpdir(), "atomic-pool-holder-"));
});

afterEach(async () => {
	await rm(storeDir, { recursive: true, force: true });
});

async function nameLockHolder(lockPath: string, pid: number, started: string | undefined, mtime?: Date): Promise<void> {
	await mkdir(lockPath, { recursive: true });
	// Setting an mtime earlier than creation can also change the birth time on macOS.
	if (mtime !== undefined) await utimes(lockPath, mtime, mtime);
	const { dev, ino, birthtimeNs } = await stat(lockPath, { bigint: true });
	const lockId = `${dev}:${ino}:${birthtimeNs}`;
	await writeFile(lockHolderPath(lockPath), JSON.stringify({ host: hostname(), pid, started, lock: lockId, lockId }));
}

test.each(["admission", "existing slot"] as const)("a dead %s holder does not delay resume (#6803)", async (target) => {
	const admission = { storeDir, remotes, lastState, envHash: "env" };
	const repositoryPath = join(storeDir, "pool", repositoryIdOf(remotes));
	const existing = target === "existing slot" ? await admitPooledWorktree(admission, owner) : undefined;
	if (existing !== undefined) await releaseRestoredWorktree(existing);
	const lockPath = existing === undefined ? `${repositoryPath}.lock` : join(repositoryPath, "0.json.lock");
	const child = spawnProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
	try {
		assert.ok(child.pid);
		await nameLockHolder(lockPath, child.pid, await readProcessStartToken(child.pid));
	} finally {
		child.kill("SIGKILL");
		await child.exited;
	}

	const signal = AbortSignal.timeout(TAKEOVER_BUDGET_MS);
	const lease =
		existing === undefined
			? await admitPooledWorktree({ ...admission, signal }, owner)
			: await holdRestoredWorktree(storeDir, existing.path, owner, signal);
	assert.ok(lease);
	assert.equal(lease.slot, 0);
	await discardPooledWorktree(lease);
});

test("a live pool holder blocks and shows a wait notice even after its heartbeat expires (#6803)", async () => {
	const repository = join(storeDir, "pool", repositoryIdOf(remotes));
	const lockPath = `${repository}.lock`;
	const child = spawnProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
	const deadline = new AbortController();
	try {
		assert.ok(child.pid);
		const stale = new Date(Date.now() - 60_000);
		await nameLockHolder(lockPath, child.pid, await readProcessStartToken(child.pid), stale);
		const messages: string[] = [];
		const signal = AbortSignal.any([deadline.signal, AbortSignal.timeout(TAKEOVER_BUDGET_MS)]);
		const admission = { storeDir, remotes, lastState, envHash: "env", signal };

		await assert.rejects(
			withWorktreeLockProgress(
				(message) => {
					messages.push(message);
					deadline.abort();
				},
				() => admitPooledWorktree(admission, owner),
			),
			{ name: "AbortError" },
		);
		assert.deepEqual(messages, [
			`Waiting for another Atomic process to finish updating the worktree pool (${repository})`,
		]);
		assert.ok((await stat(lockPath)).isDirectory());
	} finally {
		child.kill("SIGKILL");
		await child.exited;
	}
});

test("concurrent admissions can reuse a slot-record lock with a recycled PID without sharing a slot (#6803)", async () => {
	const repository = join(storeDir, "pool", repositoryIdOf(remotes));
	const started = await readProcessStartToken(process.pid);
	assert.ok(started, "the process start token must be readable on the test host");
	const previousStart = started === "000000000000" ? "111111111111" : "000000000000";
	await nameLockHolder(`${repository}.lock`, process.pid, previousStart);
	await nameLockHolder(join(repository, "0.json.lock"), process.pid, previousStart);
	const admission = { storeDir, remotes, lastState, envHash: "env", signal: AbortSignal.timeout(TAKEOVER_BUDGET_MS) };

	const leases = await Promise.all(
		["one", "two", "three"].map((id) => admitPooledWorktree(admission, { kind: "session", id })),
	);
	try {
		assert.deepEqual(leases.map((lease) => lease.slot).sort(), [0, 1, 2]);
	} finally {
		await Promise.all(leases.map(discardPooledWorktree));
	}
});
