import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { bunExecutable, moduleDir, readStreamText, sleep, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const SLOW_CHECKOUT_PROCESS_TIMEOUT_MS = 120_000;
const CONCURRENT_GIT_PROCESS_TIMEOUT_MS = 60_000;
const CHILD_HANG_GUARD_TIMEOUT_MS = 15_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function git(cwd: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString("utf8").trim();
}

function makeSlowRepo(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-nw-concurrency-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	writeFileSync(join(repo, ".gitattributes"), "slow.txt filter=slow\n");
	writeFileSync(join(repo, "slow.txt"), "payload\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	return repo;
}

const namedWorktreeModuleUrl = pathToFileURL(
	join(moduleDir(import.meta.url), "../../packages/subagents/src/runs/shared/named-worktree.ts"),
).href;

const CHILD_LAUNCH_SCRIPT = `const [moduleUrl, repo, rawRequest, startAt] = process.argv.slice(1);
const fs = require("node:fs");
const path = require("node:path");
const { ensureNamedWorktree } = await import(moduleUrl);
const targetStart = Number(startAt);
await new Promise(resolve => setTimeout(resolve, Math.max(0, targetStart - Date.now())));
const started = performance.now();
try {
	const result = await ensureNamedWorktree(repo, JSON.parse(rawRequest));
	const slowFile = path.join(result.path, "slow.txt");
	const slow = fs.existsSync(slowFile) ? fs.readFileSync(slowFile, "utf8") : null;
	console.log(JSON.stringify({ ok: true, ms: Math.round(performance.now() - started), path: result.path, branch: result.branch, baseCommit: result.baseCommit, slow }));
} catch (error) {
	console.log(JSON.stringify({ ok: false, ms: Math.round(performance.now() - started), message: error instanceof Error ? error.message : String(error) }));
}`;

interface ChildLaunchOutcome {
	readonly ok: boolean;
	readonly ms: number;
	readonly path?: string;
	readonly branch?: string;
	readonly baseCommit?: string;
	readonly slow?: string | null;
	readonly message?: string;
}

function spawnWorktreeChild(
	repo: string,
	request: { branch: string; base?: string; path?: string },
	options: { env?: Record<string, string | undefined>; startAt?: number; timeout?: number } = {},
): Promise<ChildLaunchOutcome> {
	const child = spawnProcess(
		[
			bunExecutable(),
			"-e",
			CHILD_LAUNCH_SCRIPT,
			namedWorktreeModuleUrl,
			repo,
			JSON.stringify(request),
			String(options.startAt ?? 0),
		],
		{
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: createGitEnvironment(options.env),
			timeout: options.timeout,
		},
	);
	return Promise.all([readStreamText(child.stdout), readStreamText(child.stderr), child.exited]).then(
		([stdout, stderr, exitCode]) => {
			assert.equal(exitCode, 0, `child exited ${exitCode}: ${stdout}\n${stderr}`);
			const line = stdout.trim().split(/\r?\n/).at(-1);
			assert.ok(line, `missing child output: ${stderr}`);
			return JSON.parse(line) as ChildLaunchOutcome;
		},
	);
}

async function waitForPath(target: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(target)) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${target}`);
		await sleep(50);
	}
}

test(
	"cross-process launches with a 35-second smudge filter succeed on distinct branches, wait and reuse on the same target, and promptly reuse a user-locked worktree (#5202)",
	async () => {
		const repo = makeSlowRepo();
		const keptPath = join(repo, ".atomic", "worktrees", "feat+kept");
		git(repo, "worktree", "add", "-q", "-b", "feat/kept", keptPath);
		git(repo, "worktree", "lock", "--reason", "on a removable drive", keptPath);
		git(repo, "config", "filter.slow.smudge", "sleep 35; cat");

		const firstA = spawnWorktreeChild(repo, { branch: "feat/a" });
		await waitForPath(join(repo, ".git", "worktrees", "feat+a", "index.lock"));
		await sleep(200);

		const distinctB = spawnWorktreeChild(repo, { branch: "feat/b" });
		const sameTargetWaiter = spawnWorktreeChild(repo, { branch: "feat/a" });
		const lockedReuse = await spawnWorktreeChild(repo, { branch: "feat/kept" });

		const [outcomeFirstA, outcomeDistinctB, outcomeWaiterA] = await Promise.all([
			firstA,
			distinctB,
			sameTargetWaiter,
		]);

		assert.equal(lockedReuse.ok, true, lockedReuse.message);
		assert.equal(lockedReuse.path, keptPath);
		assert.equal(lockedReuse.slow, "payload\n");
		assert.ok(lockedReuse.ms < 15_000, `expected prompt user-locked reuse, took ${lockedReuse.ms}ms`);

		const expectedA = join(repo, ".atomic", "worktrees", "feat+a");
		const expectedB = join(repo, ".atomic", "worktrees", "feat+b");
		assert.equal(outcomeFirstA.ok, true, outcomeFirstA.message);
		assert.equal(outcomeFirstA.path, expectedA);
		assert.equal(outcomeFirstA.slow, "payload\n");

		assert.equal(outcomeDistinctB.ok, true, outcomeDistinctB.message);
		assert.equal(outcomeDistinctB.path, expectedB);
		assert.equal(outcomeDistinctB.slow, "payload\n");

		assert.equal(outcomeWaiterA.ok, true, outcomeWaiterA.message);
		assert.equal(outcomeWaiterA.path, expectedA);
		assert.equal(outcomeWaiterA.slow, "payload\n");
		assert.ok(
			outcomeWaiterA.ms >= 20_000,
			`expected same-target waiter to wait for checkout, took ${outcomeWaiterA.ms}ms`,
		);
	},
	SLOW_CHECKOUT_PROCESS_TIMEOUT_MS,
);

test(
	"a --no-checkout --lock worktree with reason initializing is reused promptly and never delays occupied-path refusal or unrelated creation (#5202)",
	async () => {
		const repo = makeSlowRepo();
		const noCheckoutInitPath = join(repo, ".atomic", "worktrees", "feat+no-checkout-init");
		const noCheckoutDefaultPath = join(repo, ".atomic", "worktrees", "feat+no-checkout-default");
		git(
			repo,
			"worktree",
			"add",
			"-q",
			"--no-checkout",
			"--lock",
			"--reason",
			"initializing",
			"-b",
			"feat/no-checkout-init",
			noCheckoutInitPath,
		);
		git(
			repo,
			"worktree",
			"add",
			"-q",
			"--no-checkout",
			"--lock",
			"-b",
			"feat/no-checkout-default",
			noCheckoutDefaultPath,
		);
		const occupied = join(repo, "..", "occupied-path");
		mkdirSync(occupied);
		writeFileSync(join(occupied, "file.txt"), "occupied\n");

		const [reuseInit, reuseDefault, refuseOccupied, createUnrelated] = await Promise.all([
			spawnWorktreeChild(repo, { branch: "feat/no-checkout-init" }, { timeout: CHILD_HANG_GUARD_TIMEOUT_MS }),
			spawnWorktreeChild(repo, { branch: "feat/no-checkout-default" }, { timeout: CHILD_HANG_GUARD_TIMEOUT_MS }),
			spawnWorktreeChild(
				repo,
				{ branch: "feat/refused-occupied", path: occupied },
				{ timeout: CHILD_HANG_GUARD_TIMEOUT_MS },
			),
			spawnWorktreeChild(repo, { branch: "feat/unrelated" }, { timeout: CHILD_HANG_GUARD_TIMEOUT_MS }),
		]);

		assert.equal(reuseInit.ok, true, reuseInit.message);
		assert.equal(reuseInit.path, noCheckoutInitPath);
		assert.ok(reuseInit.ms < 10_000, `reuseInit took ${reuseInit.ms}ms`);

		assert.equal(reuseDefault.ok, true, reuseDefault.message);
		assert.equal(reuseDefault.path, noCheckoutDefaultPath);
		assert.ok(reuseDefault.ms < 10_000, `reuseDefault took ${reuseDefault.ms}ms`);

		assert.equal(refuseOccupied.ok, false);
		assert.match(
			refuseOccupied.message ?? "",
			/already exists and is not the worktree of branch "feat\/refused-occupied"/,
		);
		assert.ok(refuseOccupied.ms < 10_000, `refuseOccupied took ${refuseOccupied.ms}ms`);

		assert.equal(createUnrelated.ok, true, createUnrelated.message);
		assert.equal(createUnrelated.path, join(repo, ".atomic", "worktrees", "feat+unrelated"));
		assert.ok(createUnrelated.ms < 10_000, `createUnrelated took ${createUnrelated.ms}ms`);
	},
	CONCURRENT_GIT_PROCESS_TIMEOUT_MS,
);

test(
	"concurrent launches for the same branch at different paths create only one worktree and refuse the other (#5202)",
	async () => {
		const repo = makeSlowRepo();
		git(repo, "branch", "feat/shared-existing");
		git(repo, "config", "filter.slow.smudge", "sleep 2; cat");

		const newOne = join(repo, "..", "shared-new-one");
		const newTwo = join(repo, "..", "shared-new-two");
		const existingOne = join(repo, "..", "shared-existing-one");
		const existingTwo = join(repo, "..", "shared-existing-two");
		const startAt = Date.now() + 800;

		const [newResults, existingResults] = await Promise.all([
			Promise.all([
				spawnWorktreeChild(repo, { branch: "feat/shared-new", path: newOne }, { startAt }),
				spawnWorktreeChild(repo, { branch: "feat/shared-new", path: newTwo }, { startAt }),
			]),
			Promise.all([
				spawnWorktreeChild(repo, { branch: "feat/shared-existing", path: existingOne }, { startAt }),
				spawnWorktreeChild(repo, { branch: "feat/shared-existing", path: existingTwo }, { startAt }),
			]),
		]);

		for (const [branch, allowedPaths, outcomes] of [
			["feat/shared-new", [newOne, newTwo], newResults],
			["feat/shared-existing", [existingOne, existingTwo], existingResults],
		] as const) {
			const winners = outcomes.filter((outcome) => outcome.ok);
			const losers = outcomes.filter((outcome) => !outcome.ok);
			assert.equal(winners.length, 1, `${branch}: ${JSON.stringify(outcomes)}`);
			assert.equal(losers.length, 1, `${branch}: ${JSON.stringify(outcomes)}`);
			assert.ok(allowedPaths.includes(winners[0]!.path!), `${branch}: ${winners[0]!.path}`);
			assert.equal(winners[0]!.slow, "payload\n");
			assert.match(
				losers[0]!.message ?? "",
				new RegExp(`^worktree: .*branch "${branch.replace("/", "\\/")}" is already checked out at `),
			);
		}
	},
	CONCURRENT_GIT_PROCESS_TIMEOUT_MS,
);

test(
	"a launch under a non-English locale waits for an external slow git worktree add or checkout on its target and reuses the completed checkout (#5202)",
	async () => {
		const repo = makeSlowRepo();
		const resetTarget = join(repo, ".atomic", "worktrees", "feat+foreign-reset");
		git(repo, "worktree", "add", "-q", "--no-checkout", "-b", "feat/foreign-reset", resetTarget);
		git(repo, "config", "filter.slow.smudge", "sleep 4; cat");

		const addTarget = join(repo, ".atomic", "worktrees", "feat+foreign-add");
		const germanEnv = {
			LANG: "de_DE.UTF-8",
			LC_ALL: "de_DE.UTF-8",
			LC_MESSAGES: "de_DE.UTF-8",
			LANGUAGE: "de",
		};

		const externalAdd = spawnProcess(["git", "-C", repo, "worktree", "add", "-b", "feat/foreign-add", addTarget], {
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: createGitEnvironment(germanEnv),
		});
		const externalReset = spawnProcess(["git", "-C", resetTarget, "reset", "--hard", "HEAD"], {
			cwd: resetTarget,
			stdout: "pipe",
			stderr: "pipe",
			env: createGitEnvironment(germanEnv),
		});

		await Promise.all([
			waitForPath(join(repo, ".git", "worktrees", "feat+foreign-add", "index.lock")),
			waitForPath(join(repo, ".git", "worktrees", "feat+foreign-reset", "index.lock")),
		]);

		const [addOutcome, resetOutcome, addExit, resetExit] = await Promise.all([
			spawnWorktreeChild(repo, { branch: "feat/foreign-add" }, { env: germanEnv }),
			spawnWorktreeChild(repo, { branch: "feat/foreign-reset" }, { env: germanEnv }),
			externalAdd.exited,
			externalReset.exited,
		]);

		assert.equal(addExit, 0);
		assert.equal(resetExit, 0);
		assert.equal(addOutcome.ok, true, addOutcome.message);
		assert.equal(addOutcome.path, addTarget);
		assert.equal(addOutcome.slow, "payload\n");
		assert.equal(resetOutcome.ok, true, resetOutcome.message);
		assert.equal(resetOutcome.path, resetTarget);
		assert.equal(resetOutcome.slow, "payload\n");
	},
	CONCURRENT_GIT_PROCESS_TIMEOUT_MS,
);
