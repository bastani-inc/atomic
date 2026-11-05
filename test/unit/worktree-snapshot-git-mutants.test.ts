import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, test, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const { EventEmitter } = await import("node:events");
	const { PassThrough } = await import("node:stream");
	return {
		...actual,
		spawn: (command: string, args: readonly string[], options: object) => {
			if (command !== "atomic-test-emfile-git") {
				return (actual.spawn as (...parameters: unknown[]) => unknown)(command, args, options);
			}
			// A process table that is full: Node reports the spawn failure as an `error` event, then `close`.
			const child = Object.assign(new EventEmitter(), {
				stdin: new PassThrough(),
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: () => true,
			});
			process.nextTick(() => {
				child.emit(
					"error",
					Object.assign(new Error(`spawn ${command} EMFILE`), { code: "EMFILE", syscall: "spawn" }),
				);
				child.emit("close", -24, null);
			});
			return child;
		},
	};
});

import {
	isGitUnavailableError,
	isWorkspaceGitError,
	type WorkspaceGitError,
} from "../../packages/coding-agent/src/core/worktree-snapshot/errors.ts";
import { gitText, runGit, setWorktreeSnapshotGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	vi.unstubAllEnvs();
	sandbox.dispose();
});

async function gitFailure(args: readonly string[]): Promise<WorkspaceGitError> {
	try {
		await runGit(args, { cwd: sandbox.root });
	} catch (error) {
		assert.ok(isWorkspaceGitError(error), `expected a WorkspaceGitError, got ${String(error)}`);
		return error;
	}
	assert.fail(`git ${args.join(" ")} succeeded`);
}

describe("naming a failed Git command", () => {
	test("the operation is the subcommand, past -c pairs and global options", async () => {
		const missing = "f".repeat(40);
		const afterConfig = await gitFailure(["-c", "core.quotePath=false", "cat-file", "-t", missing]);
		assert.equal(afterConfig.operation, "cat-file");
		assert.equal(afterConfig.exitCode, 128);
		const afterOption = await gitFailure(["--literal-pathspecs", "cat-file", "-t", missing]);
		assert.equal(afterOption.operation, "cat-file");
	});

	test("a command made only of options has no operation name", async () => {
		const failure = await gitFailure(["--no-such-option"]);
		assert.equal(failure.operation, "");
		assert.equal(failure.exitCode, 129);
	});

	test("the detail is the first non-blank line of the error output, capped at 300 characters", async () => {
		const long = "x".repeat(400);
		const failure = await gitFailure([
			"-c",
			`alias.boom=!f() { printf '\\n   fatal: ${long}\\nsecond line\\n' >&2; exit 3; }; f`,
			"boom",
		]);
		assert.equal(failure.operation, "boom");
		assert.equal(failure.exitCode, 3);
		assert.equal(failure.detail, `fatal: ${"x".repeat(293)}`);
		assert.equal(failure.detail.length, 300);
	});

	test("a working directory that is a regular file is a Git failure, not a thrown spawn error", async () => {
		const file = sandbox.path("not-a-directory");
		writeFileSync(file, "x\n");
		await assert.rejects(runGit(["status"], { cwd: file }), (error: unknown) => {
			assert.equal(isGitUnavailableError(error), false);
			assert.ok(isWorkspaceGitError(error));
			assert.equal(error.operation, "status");
			assert.equal(error.cwd, file);
			assert.equal(error.exitCode, null);
			assert.equal((error.cause as NodeJS.ErrnoException).code, process.platform === "win32" ? "ENOENT" : "ENOTDIR");
			return true;
		});
	});

	test("a spawn failure other than a missing executable is a Git failure, not an install problem", async () => {
		setWorktreeSnapshotGit(async () => ({ path: "atomic-test-emfile-git", env: {} }));
		await assert.rejects(runGit(["status"], { cwd: sandbox.root }), (error: unknown) => {
			assert.equal(isGitUnavailableError(error), false);
			assert.ok(isWorkspaceGitError(error));
			assert.equal(error.code, "git-failed");
			assert.equal(error.operation, "status");
			assert.equal(error.exitCode, null);
			assert.equal(error.detail, "spawn atomic-test-emfile-git EMFILE");
			assert.equal((error.cause as NodeJS.ErrnoException).code, "EMFILE");
			return true;
		});
	});
});

describe("the environment and input of a Git command", () => {
	test("Git never prompts and takes no optional locks, whatever the ambient environment says", async () => {
		vi.stubEnv("GIT_TERMINAL_PROMPT", "1");
		vi.stubEnv("GIT_OPTIONAL_LOCKS", "1");
		vi.stubEnv("GCM_INTERACTIVE", "always");
		const seen = await gitText(
			[
				"-c",
				`alias.showenv=!printf '%s|%s|%s' "$GIT_TERMINAL_PROMPT" "$GIT_OPTIONAL_LOCKS" "$GCM_INTERACTIVE"`,
				"showenv",
			],
			{ cwd: sandbox.root },
		);
		assert.equal(seen, "0|0|never");
	});

	test("a command that exits without reading its input still resolves, with no stray pipe error", async () => {
		const uncaught: unknown[] = [];
		const record = (error: unknown) => uncaught.push(error);
		process.on("uncaughtException", record);
		try {
			const result = await runGit(["--version"], { cwd: sandbox.root, input: new Uint8Array(8 * 1024 * 1024) });
			assert.equal(result.exitCode, 0);
			assert.match(result.stdout.toString("utf8"), /^git version /);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(uncaught, []);
		} finally {
			process.off("uncaughtException", record);
		}
	});
});

describe("Git on Windows", () => {
	let windowsGit: typeof import("../../packages/coding-agent/src/core/worktree-snapshot/git.ts");
	beforeAll(async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		vi.resetModules();
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		try {
			windowsGit = await import("../../packages/coding-agent/src/core/worktree-snapshot/git.ts");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});

	test("disables hooks through its NUL device", async () => {
		const executable = sandbox.executable;
		windowsGit.setWorktreeSnapshotGit(async () => executable);
		assert.equal(await windowsGit.gitText(["config", "--get", "core.hooksPath"], { cwd: sandbox.root }), "NUL");
	});
});

describe("cancelling a Git command", () => {
	test("an abort while the executable is being resolved stops the command before it starts", async () => {
		const controller = new AbortController();
		const reason = new Error("stop before spawning");
		const executable = sandbox.executable;
		setWorktreeSnapshotGit(async () => {
			controller.abort(reason);
			return executable;
		});
		const created = sandbox.path("created-by-git");
		await assert.rejects(
			runGit(["init", "-q", created], { cwd: sandbox.root, signal: controller.signal }),
			(error: unknown) => error === reason,
		);
		assert.equal(existsSync(created), false);
	});

	test("commands leave no abort listener behind on a long-lived signal", async () => {
		const controller = new AbortController();
		await runGit(["--version"], { cwd: sandbox.root, signal: controller.signal });
		await assert.rejects(runGit(["--no-such-option"], { cwd: sandbox.root, signal: controller.signal }));
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});
});
