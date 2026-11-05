import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { bunExecutable, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

// Starting a Bun child under a pseudo-terminal and loading the snapshot modules is a structural cost, not a slow test.
const PTY_RESTORE_TIMEOUT_MS = 90_000;

/** The restore runs in a child whose terminal is a real pty, which is where an ssh prompt would block a person. */
const CHILD = `
import { readFileSync, writeFileSync } from "node:fs";
import { MemorySnapshotBlobStore, restoreWorktreeSnapshot, setWorktreeSnapshotGit } from "__ROOT__/packages/coding-agent/src/core/worktree-snapshot/index.ts";
const data = JSON.parse(readFileSync(process.env.TEST_MANIFEST, "utf8"));
setWorktreeSnapshotGit(async () => ({ path: "git", env: { GIT_CONFIG_GLOBAL: process.env.TEST_CONFIG, GIT_CONFIG_NOSYSTEM: "1", HOME: process.env.TEST_HOME, PATH: process.env.TEST_PATH, ...(process.env.TEST_SSH_COMMAND ? { GIT_SSH_COMMAND: process.env.TEST_SSH_COMMAND } : {}) } }));
const blobs = new MemorySnapshotBlobStore();
let outcome;
try {
  await restoreWorktreeSnapshot(data.snapshot, { blobs, storeDir: process.env.TEST_STORE });
  outcome = { restored: true };
} catch (error) {
  outcome = { name: error.name, code: error.code, reason: error.reason, causeName: error.cause?.name, causeCode: error.cause?.code };
}
writeFileSync(process.env.TEST_RESULT, JSON.stringify(outcome));
`;

const hasScript = process.platform === "linux" && spawnSyncCollect(["script", "--version"]).exitCode === 0;

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

/** An `ssh` that records whether it can open the controlling terminal, then fails as an unreachable host does. */
function terminalProbingSsh(): { bin: string; log: string } {
	const bin = sandbox.path("bin-probe");
	mkdirSync(bin, { recursive: true });
	const log = sandbox.path("probe.log");
	const script = join(bin, "ssh");
	writeFileSync(
		script,
		`#!/bin/sh\nif ( : </dev/tty ) 2>/dev/null; then echo terminal-reachable >> '${log}'; else echo no-terminal >> '${log}'; fi\nexit 255\n`,
	);
	chmodSync(script, 0o755);
	return { bin, log };
}

async function restoreUnderPty(sshCommand?: string): Promise<{ outcome: Record<string, unknown>; log: string[] }> {
	const probe = terminalProbingSsh();
	const { clone } = await sandbox.remoteWithClone();
	const result = await captureWorktreeSnapshot(clone, { blobs: new MemorySnapshotBlobStore() });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("capture failed");
	const manifest = sandbox.path("manifest.json");
	writeFileSync(
		manifest,
		JSON.stringify({
			snapshot: { ...result.snapshot, head: "a".repeat(40), remotes: ["ssh://fake-host.invalid/r.git"] },
		}),
	);
	const resultFile = sandbox.path("result.json");
	const script = sandbox.path("child.ts");
	writeFileSync(script, CHILD.replace("__ROOT__", process.cwd()));
	const command = `${bunExecutable()} run ${script}`;
	const child = spawnProcess(["script", "-qec", command, "/dev/null"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			TEST_MANIFEST: manifest,
			TEST_CONFIG: sandbox.globalConfig,
			TEST_HOME: sandbox.root,
			TEST_STORE: sandbox.path("host"),
			TEST_RESULT: resultFile,
			TEST_PATH: `${probe.bin}:${process.env.PATH}`,
			TEST_SSH_COMMAND: sshCommand,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	const timedOut = Symbol("timed out");
	const finished = await Promise.race([
		child.exited,
		new Promise<symbol>((resolve) => setTimeout(() => resolve(timedOut), PTY_RESTORE_TIMEOUT_MS)),
	]);
	if (finished === timedOut) {
		child.kill();
		assert.fail(`the restore was still running after ${PTY_RESTORE_TIMEOUT_MS} ms: it is waiting for a terminal`);
	}
	assert.ok(existsSync(resultFile), "the restore child wrote no result");
	return {
		outcome: JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>,
		log: readFileSync(probe.log, "utf8").trim().split("\n"),
	};
}

describe.skipIf(!hasScript)("a restore started from a terminal (#4245)", () => {
	test(
		"fetches over ssh without a controlling terminal and fails as not-fetched instead of waiting",
		async () => {
			const { outcome, log } = await restoreUnderPty();
			assert.deepEqual(log, ["no-terminal"]);
			assert.deepEqual(outcome, {
				name: "WorkspaceRestoreError",
				code: "commits-unavailable",
				reason: "not-fetched",
				causeName: "WorkspaceGitError",
				causeCode: "git-failed",
			});
		},
		PTY_RESTORE_TIMEOUT_MS + 30_000,
	);

	test(
		"keeps a user's own ssh command but still takes the terminal away from it",
		async () => {
			const { outcome, log } = await restoreUnderPty(`${sandbox.path("bin-probe", "ssh")} -q`);
			assert.deepEqual(log, ["no-terminal"]);
			assert.equal(outcome.code, "commits-unavailable");
		},
		PTY_RESTORE_TIMEOUT_MS + 30_000,
	);
});
