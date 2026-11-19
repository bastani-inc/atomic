import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAdvisoryLock } from "@bastani/atomic-natives";
import { afterEach, test, vi } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree, WorktreeReentryError } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import { namedWorktreeLockDir } from "../helpers/named-worktree-locks.js";
import { sleep, spawnSyncCollect } from "../helpers/runtime.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", repo, ...args], { env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}

function makeRepo(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "named-worktree-wait-")));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

function locks(repo: string, branch: string): { dir: string; pathLock: string; branchLock: string; target: string } {
	const dir = namedWorktreeLockDir(repo);
	mkdirSync(dir, { recursive: true });
	const target = join(repo, ".atomic", "worktrees", branch.replaceAll("/", "+"));
	const comparable = process.platform === "win32" ? target.toLowerCase() : target;
	const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
	return {
		dir,
		target,
		pathLock: join(dir, `path-${hash(comparable)}.lock`),
		branchLock: join(dir, `branch-${hash(branch)}.lock`),
	};
}

test("a queued named-worktree launch reports progress and aborts without retaining its path lock (#5202)", async () => {
	const repo = makeRepo();
	const { target, branchLock, pathLock } = locks(repo, "feat/cancel");
	const holder = tryAdvisoryLock(branchLock, 0);
	assert.ok(holder);
	const abort = new AbortController();
	const progress: Array<string | undefined> = [];
	const launch = ensureNamedWorktree(
		repo,
		{ branch: "feat/cancel" },
		{
			signal: abort.signal,
			onWaiting: (message) => {
				progress.push(message);
				if (message) abort.abort(new Error("cancelled checkout preparation"));
			},
		},
	).then(
		() => "created",
		(error: Error) => error.message,
	);
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	try {
		const expired = new Promise<string>((resolve) => {
			watchdog = setTimeout(() => resolve("no cancellation"), 8_000);
		});
		const outcome = await Promise.race([launch, expired]);
		assert.match(outcome, /cancelled checkout preparation/);
		assert.ok(progress[0]?.includes(target));
		assert.equal(progress.at(-1), undefined);
		assert.equal(existsSync(target), false);
		const released = tryAdvisoryLock(pathLock, 0);
		assert.ok(released, "aborting while queued for a branch releases the earlier path lock");
		released.release();
	} finally {
		clearTimeout(watchdog);
		abort.abort();
		holder.release();
		await launch;
	}
});

test("named-worktree ownership files survive Git maintenance without appearing as worktrees and stay private (#5202)", async () => {
	const repo = makeRepo();
	if (process.platform !== "win32") chmodSync(join(repo, ".git", "objects", "info"), 0o755);
	const { path: target } = await ensureNamedWorktree(repo, { branch: "feat/pruned" });
	const dir = namedWorktreeLockDir(repo);
	const before = readdirSync(dir).sort();
	assert.equal(before.length, 2);
	const identities = (): Array<{ ino: number; mtimeMs: number; size: number }> =>
		before.map((file) => {
			const { ino, mtimeMs, size } = statSync(join(dir, file));
			return { ino, mtimeMs, size };
		});
	const original = identities();
	git(repo, "worktree", "remove", target);
	for (const args of [
		["worktree", "prune", "--expire", "now"],
		["gc", "--prune=now", "--aggressive"],
		["repack", "-a", "-d"],
		["prune"],
		["maintenance", "run", "--task=gc", "--task=loose-objects", "--task=incremental-repack"],
	]) {
		git(repo, ...args);
		assert.deepEqual(readdirSync(dir).sort(), before);
		assert.deepEqual(identities(), original, args.join(" "));
		assert.doesNotMatch(git(repo, "worktree", "list", "--porcelain"), /atomic-named-worktree-locks/);
	}
	if (process.platform !== "win32") {
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		for (const file of before) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
	}
	await ensureNamedWorktree(repo, { branch: "feat/pruned" });
	assert.equal(git(target, "branch", "--show-current"), "feat/pruned");
});

test("a checkout hook's nested launch has a typed refusal naming the requested path (#5202)", async () => {
	const repo = makeRepo();
	const { pathLock, target } = locks(repo, "feat/nested");
	const holder = tryAdvisoryLock(pathLock, 0);
	assert.ok(holder);
	try {
		vi.stubEnv("ATOMIC_NAMED_WORKTREE_LOCKS", JSON.stringify([pathLock]));
		await assert.rejects(ensureNamedWorktree(repo, { branch: "feat/nested" }), (error: Error) => {
			assert.ok(error instanceof WorktreeReentryError);
			assert.ok(error.message.includes(target));
			assert.match(error.message, /retry outside the hook/);
			return true;
		});
		assert.equal(existsSync(target), false);
	} finally {
		holder.release();
	}
});

const CHECKOUT_CANCELLATION_PROCESS_TIMEOUT_MS = 60_000;
test(
	"aborting a running named-worktree checkout keeps the event loop responsive and releases ownership after cleanup (#5202)",
	async () => {
		const repo = makeRepo();
		const started = join(repo, "hook-started");
		const finished = join(repo, "hook-finished");
		const hook = join(repo, ".git", "hooks", "post-checkout");
		const shellPath = (value: string): string => value.replaceAll("\\", "/");
		writeFileSync(
			hook,
			`#!/bin/sh\necho ready > "${shellPath(started)}"\nsleep 30\necho late > "${shellPath(finished)}"\n`,
		);
		chmodSync(hook, 0o755);
		const abort = new AbortController();
		const launch = ensureNamedWorktree(repo, { branch: "feat/abort-add" }, { signal: abort.signal }).then(
			() => "created",
			(error: Error) => error.message,
		);
		try {
			const deadline = Date.now() + 15_000;
			while (!existsSync(started)) {
				assert.ok(Date.now() < deadline, "Git reached its checkout hook");
				await sleep(50);
			}
			assert.equal(existsSync(finished), false, "the event loop ran while Git was still in its hook");
			abort.abort(new Error("cancelled running checkout"));
			assert.match(await launch, /cancelled running checkout/);
			assert.equal(existsSync(finished), false, "the cancelled hook never finished");
			const ready = await ensureNamedWorktree(repo, { branch: "feat/abort-add" });
			assert.equal(ready.branch, "feat/abort-add");
		} finally {
			abort.abort();
			await launch;
		}
	},
	CHECKOUT_CANCELLATION_PROCESS_TIMEOUT_MS,
);
