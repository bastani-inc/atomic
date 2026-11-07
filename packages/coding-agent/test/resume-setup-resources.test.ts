import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { isResumeSetupHookError } from "../src/core/resume/errors.ts";
import { ensureResumeSetup, RESUME_SETUP_HOOK_FILE } from "../src/core/resume/setup-hook.ts";
import { cliResumeTrust } from "../src/main-session.ts";
import { getShellConfig, type ShellConfig } from "../src/utils/shell.ts";
import { nodeCommand, SLEEPING_COMMAND, SUCCEEDING_COMMAND } from "./helpers/hook-commands.ts";

useTemporaryAgentDir();

const opened = vi.hoisted(() => ({ handles: [] as FileHandle[] }));
const killed = vi.hoisted(() => ({ pids: [] as number[] }));
const shellOverride = vi.hoisted(() => ({ config: undefined as ShellConfig | undefined }));

vi.mock("../src/utils/shell.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/shell.ts")>();
	return {
		...actual,
		getShellConfig: () => shellOverride.config ?? actual.getShellConfig(),
		killProcessTree: (pid: number) => {
			killed.pids.push(pid);
			actual.killProcessTree(pid);
		},
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			opened.handles.push(handle);
			return handle;
		},
	};
});

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-setup-resources-"));
	opened.handles = [];
	killed.pids = [];
	shellOverride.config = undefined;
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

let worktrees = 0;
function worktree(): string {
	const path = join(root, "store", "worktrees", `wt-${worktrees++}`);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "package-lock.json"), "{}\n");
	return path;
}

const run = (command: string, timeoutMs = 20_000, signal?: AbortSignal) =>
	ensureResumeSetup({
		entryPoint: "cli",
		worktree: worktree(),
		envHash: "e".repeat(64),
		storeDir: join(root, "store"),
		config: { command, trusted: () => false, timeoutMs },
		signal,
	});

test("the hook's log file is closed whether the hook succeeds, fails, times out or is cancelled (#4329)", async () => {
	await run(SUCCEEDING_COMMAND);
	await assert.rejects(run(nodeCommand("process.exit(4)")));
	await assert.rejects(run(SLEEPING_COMMAND, 100));
	const controller = new AbortController();
	const cancelled = run(SLEEPING_COMMAND, 20_000, controller.signal);
	setTimeout(() => controller.abort(new Error("stop")), 50);
	await assert.rejects(cancelled, /stop/);
	const logs = opened.handles.filter((handle) => handle.fd !== undefined);
	assert.equal(logs.length, 4);
	for (const handle of logs) assert.equal(handle.fd, -1);
});

test("a hook that times out or is cancelled is stopped with its whole process tree, and a finished one is not (#4329)", async () => {
	await run(SUCCEEDING_COMMAND);
	assert.deepEqual(killed.pids, []);
	await assert.rejects(run(SLEEPING_COMMAND, 100));
	assert.equal(killed.pids.length, 1);
	const controller = new AbortController();
	const cancelled = run(SLEEPING_COMMAND, 20_000, controller.signal);
	setTimeout(() => controller.abort(new Error("stop")), 50);
	await assert.rejects(cancelled, /stop/);
	assert.equal(killed.pids.length, 2);
	assert.ok(killed.pids.every((pid) => Number.isInteger(pid) && pid > 0));
});

/** Runs the trusted repository hook of a fresh worktree, which writes `ran` into `hook-ran` there and logs a line. */
async function runRepositoryHook() {
	const path = worktree();
	mkdirSync(join(path, ".atomic"));
	writeFileSync(join(path, RESUME_SETUP_HOOK_FILE), "#!/bin/sh\nprintf ran > hook-ran\necho hook-output\n", {
		mode: 0o755,
	});
	const outcome = await ensureResumeSetup({
		entryPoint: "cli",
		worktree: path,
		envHash: "e".repeat(64),
		storeDir: join(root, "store"),
		config: { trusted: () => true },
	});
	return { outcome, ran: existsSync(join(path, "hook-ran")) ? readFileSync(join(path, "hook-ran"), "utf8") : null };
}

test("a configured shell that takes its command on stdin runs the repository's hook (#4329)", async () => {
	shellOverride.config = { shell: getShellConfig().shell, args: ["-s"], commandTransport: "stdin" };
	const { outcome, ran } = await runRepositoryHook();
	assert.equal(outcome.status, "ran");
	assert.equal(ran, "ran");
	assert.equal(outcome.status === "ran" && readFileSync(outcome.logPath, "utf8"), "hook-output\n");
});

test("a configured shell that cannot start fails as a typed setup failure caused by the spawn error (#4329)", async () => {
	shellOverride.config = { shell: join(root, "no-such-shell"), args: ["-c"] };
	await assert.rejects(runRepositoryHook(), (error: unknown) => {
		assert.ok(isResumeSetupHookError(error));
		assert.equal(error.code, "setup-hook-failed");
		assert.equal(error.hook, RESUME_SETUP_HOOK_FILE);
		assert.equal(error.exitStatus, null);
		assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOENT");
		return true;
	});
});

test("CLI trust for a restored worktree: the command-line override, then the saved decision, then the default (#4329)", () => {
	const store = { get: (path: string) => (path === "/saved-yes" ? true : path === "/saved-no" ? false : null) };
	assert.equal(cliResumeTrust(false, store, "always")("/saved-yes"), false);
	assert.equal(cliResumeTrust(true, store, "never")("/saved-no"), true);
	assert.equal(cliResumeTrust(undefined, store, "never")("/saved-yes"), true);
	assert.equal(cliResumeTrust(undefined, store, "always")("/saved-no"), false);
	assert.equal(cliResumeTrust(undefined, store, "always")("/unknown"), true);
	assert.equal(cliResumeTrust(undefined, store, "ask")("/unknown"), false);
});
