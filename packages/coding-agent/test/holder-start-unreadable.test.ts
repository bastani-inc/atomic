import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { SessionOpenElsewhereError } from "../src/core/session-manager-errors.js";
import { assertSessionNotOpenElsewhere } from "../src/core/session-open-markers.js";
import {
	admitPooledWorktree,
	evictIdleWorktrees,
	pooledWorktreeHolder,
	releaseRestoredWorktree,
	repositoryIdOf,
	UNSTARTED_LEASE_LIMIT_MS,
} from "../src/core/worktree-snapshot/pool.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";

// No process's start can be read now, as when Windows' PowerShell fallback times out under load (#5141).
vi.mock("../src/core/process-start-token.ts", () => ({ processStartToken: () => undefined }));

/** A start as a record names it, written when its holder's start could be read. */
const RECORDED_START = "abcdefabcdef";
const DAY_AND_AN_HOUR_MS = UNSTARTED_LEASE_LIMIT_MS + 60 * 60_000;

let dir: string;
let holder: ChildProcess | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "atomic-holder-start-unreadable-"));
});

afterEach(async () => {
	if (holder !== undefined && holder.exitCode === null) {
		const exited = new Promise((resolve) => holder!.once("exit", resolve));
		holder.kill("SIGKILL");
		await exited;
	}
	holder = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** A process of this host that runs until the test ends: the holder whose start cannot be read right now. */
async function liveHolder(): Promise<number> {
	holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await new Promise((resolve, reject) => holder!.once("spawn", resolve).once("error", reject));
	return holder.pid!;
}

function age(path: string, ms: number): void {
	const at = new Date(Date.now() - ms);
	utimesSync(path, at, at);
}

describe("a running holder whose start cannot be read now (#5141)", () => {
	test("keeps its pooled worktree however long its lease was not refreshed (#5141)", async () => {
		const storeDir = join(dir, "host");
		const remotes = ["https://example.com/unreadable.git"];
		const repository = repositoryIdOf(remotes);
		const owner = { kind: "session" as const, id: "session-x" };
		const lease = await admitPooledWorktree(
			{
				storeDir,
				remotes,
				lastState: { snapshotId: "a1", head: "1".repeat(40), tree: "2".repeat(40) },
				envHash: "env",
			},
			owner,
		);
		await releaseRestoredWorktree(lease);
		const pid = await liveHolder();
		const host = createHash("sha256").update(hostname()).digest("hex").slice(0, 12);
		const lock = join(storeDir, "pool", repository, `0.json.${host}-${pid}-0badcafe-${RECORDED_START}.lease.lock`);
		mkdirSync(lock);
		age(lock, DAY_AND_AN_HOUR_MS);

		assert.deepEqual(await pooledWorktreeHolder(storeDir, lease.path), { owner, held: true });
		const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
		assert.deepEqual(await evictIdleWorktrees(storeDir, repository, { maxIdle: 0, settings }), []);
		assert.equal(existsSync(lock), true);
	});

	test("keeps its session marked open however long its mark was not refreshed (#5141)", async () => {
		const agentDir = join(dir, "agent");
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const pid = await liveHolder();
		const markers = join(agentDir, "open-sessions", sessionId);
		mkdirSync(markers, { recursive: true });
		const mark = join(markers, `${pid}-${"0".repeat(16)}-${RECORDED_START}.json`);
		writeFileSync(mark, JSON.stringify({ pid, host: hostname() }));
		age(mark, DAY_AND_AN_HOUR_MS);

		await assert.rejects(assertSessionNotOpenElsewhere(sessionId, { agentDir }), SessionOpenElsewhereError);
		assert.equal(existsSync(mark), true);
	});
});
