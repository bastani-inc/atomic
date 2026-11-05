import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, test, vi } from "vitest";
import { ATOMIC_AI_AGENT } from "../../packages/coding-agent/src/utils/agent-attribution.js";
import { GIT_LOCAL_ENV_VARS } from "../../packages/coding-agent/src/utils/git-env.js";
import { GitUnavailableError } from "../../packages/coding-agent/src/utils/git-errors.js";

const fixture = vi.hoisted(() => ({
	resolve:
		vi.fn<
			(options?: {
				signal?: AbortSignal;
			}) => Promise<{ path: string; env: Record<string, string>; source: "provisioned" }>
		>(),
	spawns: [] as { command: string; env: NodeJS.ProcessEnv }[],
}));

vi.mock("../../packages/coding-agent/src/utils/tools-manager.js", () => ({ resolveGit: fixture.resolve }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: readonly string[], options: Parameters<typeof actual.spawn>[2]) => {
			fixture.spawns.push({ command, env: options?.env ?? {} });
			return actual.spawn("git", args, options);
		},
	};
});

import { runGit } from "../../packages/coding-agent/src/core/worktree-snapshot/git.js";

afterEach(() => {
	fixture.resolve.mockReset();
	fixture.spawns.length = 0;
});

test("snapshot commands use the provisioned Git path and environment (#4245)", async () => {
	fixture.resolve.mockResolvedValue({
		path: "provisioned-git",
		env: { SNAPSHOT_GIT_RUNTIME: "portable" },
		source: "provisioned",
	});
	const result = await runGit(["--version"], { cwd: tmpdir() });
	assert.equal(result.exitCode, 0);
	assert.equal(fixture.resolve.mock.calls.length, 1);
	assert.equal(fixture.spawns.length, 1);
	assert.equal(fixture.spawns[0]?.command, "provisioned-git");
	assert.equal(fixture.spawns[0]?.env.SNAPSHOT_GIT_RUNTIME, "portable");
});

test("unavailable Git propagates the provisioning error before any snapshot child starts (#4245)", async () => {
	const error = new GitUnavailableError({
		code: "offline",
		platform: "linux",
		arch: "x64",
		offlineVariable: "ATOMIC_OFFLINE",
		installCommand: "sudo apt-get install git",
	});
	fixture.resolve.mockRejectedValue(error);
	await assert.rejects(runGit(["status"], { cwd: tmpdir() }), (caught) => {
		assert.ok(caught instanceof GitUnavailableError);
		assert.equal(caught, error);
		assert.equal(caught.code, "offline");
		assert.equal(caught.fields.installCommand, "sudo apt-get install git");
		assert.match(caught.hint, /sudo apt-get install git/);
		return true;
	});
	assert.equal(fixture.resolve.mock.calls.length, 1);
	assert.equal(fixture.spawns.length, 0);
});

test("cancelled snapshot commands never provision Git (#4245)", async () => {
	const reason = new Error("cancel snapshot");
	await assert.rejects(
		runGit(["status"], { cwd: tmpdir(), signal: AbortSignal.abort(reason) }),
		(error) => error === reason,
	);
	assert.equal(fixture.resolve.mock.calls.length, 0);
	assert.equal(fixture.spawns.length, 0);
});

test("snapshot cancellation reaches Git provisioning without starting a child (#4245)", async () => {
	const controller = new AbortController();
	const reason = new Error("cancel provisioning");
	fixture.resolve.mockImplementation(async (options) => {
		assert.equal(options?.signal, controller.signal);
		controller.abort(reason);
		options?.signal?.throwIfAborted();
		return { path: "provisioned-git", env: {}, source: "provisioned" };
	});
	await assert.rejects(runGit(["status"], { cwd: tmpdir(), signal: controller.signal }), (error) => error === reason);
	assert.equal(fixture.resolve.mock.calls.length, 1);
	assert.equal(fixture.spawns.length, 0);
});

test("resolved Git cannot reintroduce ambient repository targeting or interactive defaults (#4245)", async () => {
	fixture.resolve.mockResolvedValue({
		path: "provisioned-git",
		env: {
			...Object.fromEntries(GIT_LOCAL_ENV_VARS.map((key) => [key, "ambient"])),
			GIT_CONFIG_COUNT: "0",
			GIT_TERMINAL_PROMPT: "1",
			GIT_OPTIONAL_LOCKS: "1",
			GCM_INTERACTIVE: "always",
			AI_AGENT: "other-agent",
		},
		source: "provisioned",
	});
	await runGit(["--version"], { cwd: tmpdir(), env: { GIT_INDEX_FILE: "private-index" } });
	const env = fixture.spawns[0]!.env;
	for (const key of GIT_LOCAL_ENV_VARS) assert.equal(env[key], key === "GIT_INDEX_FILE" ? "private-index" : undefined);
	assert.equal(env.GIT_TERMINAL_PROMPT, "0");
	assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
	assert.equal(env.GCM_INTERACTIVE, "never");
	assert.equal(env.AI_AGENT, ATOMIC_AI_AGENT);
});
