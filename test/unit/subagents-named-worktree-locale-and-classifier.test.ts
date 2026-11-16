import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import * as namedWorktreeGit from "../../packages/subagents/src/runs/shared/named-worktree-git.js";
import {
	cleanupWorktrees,
	createWorktrees,
	recreateWorktree,
	runGit,
} from "../../packages/subagents/src/runs/shared/worktree.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

const CONCURRENT_ADD_WAIT_MS = 30_000;
const SINGLE_ATTEMPT_BUDGET_MS = CONCURRENT_ADD_WAIT_MS / 3;
const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function posixPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function git(repo: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", repo, ...args], { env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}

function makeRepo(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "named-worktree-locale-")));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", "README.md");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

test("post-checkout hooks inherit caller LC_ALL and LANG on named worktrees and worktree: true checkouts (#5202)", async () => {
	const repo = makeRepo();
	vi.stubEnv("LANG", "en_US.UTF-8");
	vi.stubEnv("LC_ALL", "en_US.UTF-8");
	delete process.env.LANGUAGE;

	const hookLog = join(repo, "..", "hook-locales.jsonl");
	const hookHelper = join(repo, "..", "record-locale.mjs");
	writeFileSync(
		hookHelper,
		`import { appendFileSync } from "node:fs";
const [logPath, cwd] = process.argv.slice(2);
appendFileSync(
	logPath,
	JSON.stringify({
		cwd,
		LANG: process.env.LANG ?? null,
		LC_ALL: process.env.LC_ALL ?? null,
	}) + "\\n",
);
`,
	);
	const hooksDir = join(repo, ".git", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const postCheckout = join(hooksDir, "post-checkout");
	writeFileSync(
		postCheckout,
		`#!/bin/sh\nexec "${posixPath(process.execPath)}" "${posixPath(hookHelper)}" "${posixPath(hookLog)}" "$PWD"\n`,
	);
	chmodSync(postCheckout, 0o755);

	const named = await ensureNamedWorktree(repo, { branch: "feat/locale-named" });
	assert.ok(existsSync(named.path));

	delete process.env.LC_ALL;
	const namedLangOnly = await ensureNamedWorktree(repo, { branch: "feat/locale-lang-only" });
	assert.ok(existsSync(namedLangOnly.path));
	vi.stubEnv("LC_ALL", "en_US.UTF-8");

	const setup = createWorktrees(repo, "locale-isolated", 1, { agents: ["worker"] });
	try {
		const isolatedPath = setup.worktrees[0]!.path;
		git(repo, "worktree", "remove", "--force", isolatedPath);
		recreateWorktree(setup, setup.worktrees[0]!, "locale-isolated", { agent: "worker" });
	} finally {
		cleanupWorktrees(setup);
	}

	const entries = readFileSync(hookLog, "utf8")
		.trim()
		.split(/\r?\n/)
		.map((line) => JSON.parse(line) as { cwd: string; LANG: string | null; LC_ALL: string | null });
	assert.equal(entries.length, 4, "hook ran for named adds, worktree: true create, and worktree: true recreate");
	assert.deepEqual(
		entries.map(({ LANG, LC_ALL }) => ({ LANG, LC_ALL })),
		[
			{ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
			{ LANG: "en_US.UTF-8", LC_ALL: null },
			{ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
			{ LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
		],
	);
});

test("invalid base or path operands containing retry-classifier text fail once without retrying for 30s (#5202)", async () => {
	const repo = makeRepo();
	const realAdd = namedWorktreeGit.addNamedWorktree;
	const realRunGit = runGit;
	let addCalls = 0;
	let verifyBaseCalls = 0;
	vi.spyOn(namedWorktreeGit, "addNamedWorktree").mockImplementation((cwd, args, env, signal) => {
		addCalls++;
		return realAdd(cwd, args, env, signal);
	});
	vi.spyOn(await import("../../packages/subagents/src/runs/shared/worktree.js"), "runGit").mockImplementation(
		(cwd, args, env) => {
			if (args[0] === "rev-parse" && args[1] === "--verify" && args.includes("--end-of-options")) {
				verifyBaseCalls++;
			}
			return realRunGit(cwd, args, env);
		},
	);

	const startedBase = performance.now();
	await assert.rejects(
		ensureNamedWorktree(repo, {
			branch: "feat/echo-base",
			base: "no such another git process",
		}),
		/worktree: could not check out branch "feat\/echo-base"/,
	);
	const baseElapsedMs = performance.now() - startedBase;
	assert.equal(verifyBaseCalls, 1, "invalid base is verified once before worktree add");
	assert.equal(addCalls, 0, "invalid base never runs git worktree add");
	assert.ok(
		baseElapsedMs < SINGLE_ATTEMPT_BUDGET_MS,
		`expected fast failure for invalid base, took ${Math.round(baseElapsedMs)}ms`,
	);

	const badPathParent = join(repo, "..", "another git process cannot lock references");
	writeFileSync(badPathParent, "not a directory\n");
	const startedPath = performance.now();
	await assert.rejects(
		ensureNamedWorktree(repo, {
			branch: "feat/echo-path",
			path: join(badPathParent, "worktree"),
		}),
		/worktree: could not check out branch "feat\/echo-path"/,
	);
	const pathElapsedMs = performance.now() - startedPath;
	assert.equal(addCalls, 1, "permanent worktree add failure with echoed path fails after one add");
	assert.ok(
		pathElapsedMs < SINGLE_ATTEMPT_BUDGET_MS,
		`expected fast failure for echoed path, took ${Math.round(pathElapsedMs)}ms`,
	);
});
