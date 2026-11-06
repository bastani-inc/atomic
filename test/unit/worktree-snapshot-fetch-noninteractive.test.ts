import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SpawnRequest } from "../helpers/worktree-snapshot-faults.js";

/** Every process the code under test starts, and whether each `git fetch` fails the way an unreachable remote does. */
const recorded = vi.hoisted(() => ({ spawns: [] as SpawnRequest[], unreachable: false }));

vi.mock("node:child_process", async (importOriginal) => {
	const { failingCommand, gitCommand, withSpawnFaults } = await import("../helpers/worktree-snapshot-faults.js");
	return withSpawnFaults(await importOriginal(), (request) => {
		recorded.spawns.push(request);
		return recorded.unreachable && gitCommand(request.args)[0] === "fetch"
			? failingCommand(128, "fatal: Could not read from remote repository.\n")
			: undefined;
	});
});

import {
	NON_INTERACTIVE_SSH_CONNECT_TIMEOUT_SECONDS,
	runGit,
} from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import {
	captureWorktreeSnapshot,
	isWorkspaceGitError,
	isWorkspaceRestoreError,
	MemorySnapshotBlobStore,
	restoreWorktree,
	setWorktreeSnapshotGit,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox, gitConfigPath } from "../helpers/worktree-snapshot.js";

const REMOTE = "ssh://fake-host.invalid/team/repo.git";
const MISSING_HEAD = "a".repeat(40);

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
	recorded.spawns.length = 0;
	recorded.unreachable = false;
});
afterEach(() => {
	vi.unstubAllEnvs();
	sandbox.dispose();
});

/**
 * A directory with an executable named `ssh` (so Git knows its variant without probing it) that logs how it was
 * started and fails the way an unreachable host does.
 */
function fakeSsh(directory = "default", log = "ssh.log"): { bin: string; command: string; log: string } {
	const bin = sandbox.path(`bin-${directory}`);
	mkdirSync(bin, { recursive: true });
	const logPath = sandbox.path(log);
	const script = join(bin, "ssh");
	writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> '${logPath}'\nexit 255\n`);
	chmodSync(script, 0o755);
	return { bin, command: script, log: logPath };
}

function useGit(extraEnv: Record<string, string> = {}, pathDirs: readonly string[] = []): void {
	const executable = sandbox.executable;
	setWorktreeSnapshotGit(async () => ({
		path: "git",
		env: { ...executable.env, PATH: `${[...pathDirs, process.env.PATH].join(":")}`, ...extraEnv },
	}));
}

async function unreachableSnapshot(): Promise<{ snapshot: WorktreeSnapshot; blobs: MemorySnapshotBlobStore }> {
	const { clone } = await sandbox.remoteWithClone();
	const blobs = new MemorySnapshotBlobStore();
	const result = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("capture failed");
	return { snapshot: { ...result.snapshot, head: MISSING_HEAD, remotes: [REMOTE] }, blobs };
}

async function restoreFails(snapshot: WorktreeSnapshot, blobs: MemorySnapshotBlobStore): Promise<Error> {
	try {
		await restoreWorktree(snapshot, { blobs, storeDir: sandbox.path("host") });
	} catch (error) {
		return error as Error;
	}
	return assert.fail("the restore of an unreachable remote succeeded");
}

const configLookups = () =>
	recorded.spawns.filter(({ args }) => args.includes("--get") && args.includes("core.sshCommand"));
const fetches = () => recorded.spawns.filter(({ args }) => args.includes("fetch"));

describe("a restore fetch over ssh never waits for a person (#4245)", () => {
	beforeEach(() => {
		recorded.unreachable = true;
	});

	test("ssh runs in batch mode with a bounded connect time, and the failure is the typed not-fetched chain", async () => {
		useGit();
		const { snapshot, blobs } = await unreachableSnapshot();
		const error = await restoreFails(snapshot, blobs);
		const commands = fetches().map(({ env }) => env.GIT_SSH_COMMAND ?? "");
		assert.equal(commands.length, 1);
		assert.ok(commands[0]!.includes("-o BatchMode=yes"), commands[0]);
		assert.ok(commands[0]!.includes(`-o ConnectTimeout=${NON_INTERACTIVE_SSH_CONNECT_TIMEOUT_SECONDS}`), commands[0]);
		assert.ok(isWorkspaceRestoreError(error));
		assert.equal(error.code, "commits-unavailable");
		assert.equal(error.reason, "not-fetched");
		assert.ok(isWorkspaceGitError(error.cause));
		assert.equal(error.cause.code, "git-failed");
		assert.equal(error.cause.operation, "fetch");
		assert.match(error.hint, new RegExp(`^Check access with \`git ls-remote ${REMOTE.replaceAll(".", "\\.")}\``));
		assert.equal(NON_INTERACTIVE_SSH_CONNECT_TIMEOUT_SECONDS, 15);
	});

	test("a core.sshCommand the user configured is the command that runs, untouched", async () => {
		appendFileSync(
			sandbox.globalConfig,
			`[core]\n\tsshCommand = ${gitConfigPath(sandbox.path("bin-mine", "ssh"))} -q\n`,
		);
		useGit();
		const { snapshot, blobs } = await unreachableSnapshot();
		await restoreFails(snapshot, blobs);
		assert.equal(configLookups().length, 1);
		const [fetch] = fetches();
		assert.equal(fetches().length, 1);
		assert.equal(fetch!.env.GIT_SSH_COMMAND, undefined, "no ssh command takes the place of the user's");
		assert.equal(fetch!.env.GIT_SSH, undefined);
		assert.equal(
			fetch!.args.some((argument) => argument.toLowerCase().startsWith("core.sshcommand=")),
			false,
			"the user's setting is not overridden on the command line",
		);
	});

	test.each([
		["GIT_SSH_COMMAND in the snapshot Git's environment", "snapshot-env"],
		["GIT_SSH_COMMAND in the process environment", "process-env"],
		["GIT_SSH in the process environment", "git-ssh"],
	])("%s is used as is, and Atomic looks no further", async (_name, where) => {
		const mine = sandbox.path("bin-mine", "ssh");
		const command = `${mine} -q`;
		if (where === "snapshot-env") useGit({ GIT_SSH_COMMAND: command });
		else {
			useGit();
			vi.stubEnv(where === "process-env" ? "GIT_SSH_COMMAND" : "GIT_SSH", where === "process-env" ? command : mine);
		}
		const { snapshot, blobs } = await unreachableSnapshot();
		await restoreFails(snapshot, blobs);
		const [fetch] = fetches();
		assert.equal(fetches().length, 1);
		assert.equal(fetch!.env.GIT_SSH_COMMAND, where === "git-ssh" ? undefined : command);
		assert.equal(fetch!.env.GIT_SSH, where === "git-ssh" ? mine : undefined);
		assert.equal(configLookups().length, 0, "an explicit ssh command needs no configuration lookup");
	});
});

describe.skipIf(process.platform === "win32")(
	"a restore fetch has no controlling terminal (POSIX sessions, which Windows does not have) (#4245)",
	() => {
		test("one configuration lookup per fetch, and only the fetches run without a controlling terminal", async () => {
			useGit({}, [fakeSsh().bin]);
			const { snapshot, blobs } = await unreachableSnapshot();
			await restoreFails(snapshot, blobs);
			assert.equal(fetches().length, 1);
			assert.equal(configLookups().length, 1);
			assert.deepEqual(
				fetches().map(({ detached }) => detached),
				[true],
			);
			const others = recorded.spawns.filter(({ args }) => !args.includes("fetch"));
			assert.ok(others.length > 0);
			assert.deepEqual(
				others.filter(({ detached }) => detached === true),
				[],
				"no other Git command is detached",
			);
		});

		test("a restore of a reachable local remote still fetches, detached, without any ssh involvement", async () => {
			const { clone, remote } = await sandbox.remoteWithClone();
			sandbox.write(join(clone, "b.txt"), "b\n");
			const head = await sandbox.commitAll(clone, "b");
			await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
			const blobs = new MemorySnapshotBlobStore();
			const result = await captureWorktreeSnapshot(clone, { blobs });
			assert.equal(result.status, "captured");
			if (result.status !== "captured") return;
			const restored = await restoreWorktree(
				{ ...result.snapshot, remotes: [remote] },
				{ blobs, storeDir: sandbox.path("host") },
			);
			assert.equal(await sandbox.git(restored.path, "rev-parse", "HEAD"), head);
			assert.deepEqual(
				fetches().map(({ detached }) => detached),
				[true],
			);
		});
	},
);

describe.skipIf(process.platform === "win32")(
	"cancelling a command that has no terminal (POSIX process groups and SIGTERM, which Windows does not have) (#4245)",
	() => {
		test("an abort kills the Git process and the helpers it started, even ones that ignore SIGTERM, and rejects with the signal's reason", async () => {
			const helperPid = sandbox.path("helper.pid");
			const fakeGit = sandbox.path("slow-git");
			writeFileSync(
				fakeGit,
				`#!/bin/sh\ncase "$*" in *core.sshCommand*) exit 1 ;; esac\ntrap '' TERM\nsleep 300 &\necho $! > '${helperPid}'\nwait\n`,
			);
			chmodSync(fakeGit, 0o755);
			setWorktreeSnapshotGit(async () => ({ path: fakeGit, env: {} }));
			const controller = new AbortController();
			const reason = new Error("stop waiting for the remote");
			const running = runGit(["fetch"], { cwd: sandbox.root, nonInteractive: true, signal: controller.signal });
			for (let attempts = 0; attempts < 400 && !existsSync(helperPid); attempts++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.ok(existsSync(helperPid), "the fake Git never started its helper");
			const helper = Number(readFileSync(helperPid, "utf8").trim());
			controller.abort(reason);
			await assert.rejects(running, (error: unknown) => error === reason);
			for (let attempts = 0; attempts < 400 && processExists(helper); attempts++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert.equal(processExists(helper), false, "the helper outlived the aborted command");
		});
	},
);

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
