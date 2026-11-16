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
import { pathToFileURL } from "node:url";
import { afterEach, test, vi } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import * as worktreeGit from "../../packages/subagents/src/runs/shared/worktree.js";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		if (existsSync(join(root, ".git"))) chmodSync(join(root, ".git"), 0o755);
		rmSync(root, { recursive: true, force: true });
	}
});

function git(repo: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", repo, ...args], { env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}

function makeRepo(): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "named-worktree-errors-")));
	roots.push(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "commit", "-q", "--allow-empty", "-m", "init");
	return repo;
}

const modulePath = pathToFileURL(
	join(moduleDir(import.meta.url), "../../packages/subagents/src/runs/shared/named-worktree.ts"),
).href;
const REAL_GIT_PROCESS_BUDGET_MS = 60_000;

test("classified worktree commands use a stable locale while runGit preserves ambient locale (#5202)", async () => {
	const repo = makeRepo();
	vi.stubEnv("LANGUAGE", "de");
	vi.stubEnv("LANG", "de_DE.UTF-8");
	vi.stubEnv("LC_ALL", "de_DE.UTF-8");
	git(repo, "config", "alias.atomic-locale", '!printf \'%s/%s\' "$LC_ALL" "$LANGUAGE"');
	const ambient = worktreeGit.runGit(repo, ["atomic-locale"]);
	assert.equal(ambient.status, 0, ambient.stderr);
	assert.equal(ambient.stdout, "de_DE.UTF-8/de");
	const classified = worktreeGit.runGit(repo, ["atomic-locale"], { LC_ALL: "C", LANGUAGE: "C" });
	assert.equal(classified.status, 0, classified.stderr);
	assert.equal(classified.stdout, "C/C");
	const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
	const realRunGit = worktreeGit.runGit;
	vi.spyOn(worktreeGit, "runGit").mockImplementation((cwd, args, env) => {
		seen.push({ args, env });
		return realRunGit(cwd, args, env);
	});
	await ensureNamedWorktree(repo, { branch: "feat/classified-locale" });
	const listCall = seen.find(({ args }) => args[0] === "worktree" && args[1] === "list");
	assert.deepEqual(listCall?.env, { LC_ALL: "C", LANGUAGE: "C" });
});

test.skipIf(process.platform === "win32")(
	"named worktrees use writable metadata below a read-only common Git directory (#5202)",
	async () => {
		const repo = makeRepo();
		mkdirSync(join(repo, ".git", "worktrees"));
		chmodSync(join(repo, ".git"), 0o555);
		const result = await ensureNamedWorktree(repo, { branch: "feat/readonly" });
		assert.equal(git(result.path, "branch", "--show-current"), "feat/readonly");
	},
);

test(
	"a crash-left checkout lock has a bounded actionable refusal and leaves foreign metadata unchanged (#5202)",
	() => {
		const repo = makeRepo();
		const target = join(repo, "crashed");
		git(repo, "worktree", "add", "--no-checkout", "--lock", "--reason", "initializing", "-b", "crashed", target);
		const admin = join(repo, ".git", "worktrees", "crashed");
		const indexLock = join(admin, "index.lock");
		writeFileSync(indexLock, "unfinished checkout");
		const before = ["HEAD", "locked", "index.lock"].map((name) => readFileSync(join(admin, name), "utf8"));
		const result = spawnSyncCollect(
			[
				bunExecutable(),
				"-e",
				`const [modulePath, repo, target] = process.argv.slice(1);
const { ensureNamedWorktree, WorktreeBusyError } = await import(modulePath);
let now = 0;
Object.defineProperty(performance, "now", { value: () => now += 60_000 });
try {
	await ensureNamedWorktree(repo, { branch: "crashed", path: target });
	process.exit(1);
} catch (error) {
	if (!(error instanceof WorktreeBusyError)) throw error;
	console.log(error.message);
}
await ensureNamedWorktree(repo, { branch: "unrelated" });`,
				modulePath,
				repo,
				target,
			],
			{ env: createGitEnvironment(), timeout: REAL_GIT_PROCESS_BUDGET_MS },
		);
		assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout.toString(), /another git process seems to be running/);
		assert.ok(result.stdout.toString().includes(indexLock));
		assert.deepEqual(
			["HEAD", "locked", "index.lock"].map((name) => readFileSync(join(admin, name), "utf8")),
			before,
		);
		assert.ok(existsSync(join(repo, ".atomic", "worktrees", "unrelated")));
	},
	REAL_GIT_PROCESS_BUDGET_MS,
);

test("reftable reference contention is retried before creating a named worktree (#5202)", async () => {
	const repo = makeRepo();
	const realRunGit = worktreeGit.runGit;
	let attempts = 0;
	vi.spyOn(worktreeGit, "runGit").mockImplementation((cwd, args, env) => {
		if (args[0] === "worktree" && args[1] === "list" && ++attempts === 1)
			return { status: 1, stdout: "", stderr: "fatal: cannot lock references\n" };
		return realRunGit(cwd, args, env);
	});
	const result = await ensureNamedWorktree(repo, { branch: "feat/reftable" });
	assert.equal(attempts, 2);
	assert.equal(git(result.path, "branch", "--show-current"), "feat/reftable");
});

test("named-worktree reuse resolves each repository's common directory once and refreshes a missing cached directory (#5202)", async () => {
	const repo = makeRepo();
	const firstCommon = join(repo, ".git", "cached-common");
	mkdirSync(firstCommon);
	let common = firstCommon;
	let resolutions = 0;
	const realRunGit = worktreeGit.runGit;
	vi.spyOn(worktreeGit, "runGit").mockImplementation((cwd, args, env) => {
		if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
			resolutions++;
			return { status: 0, stdout: `${common}\n`, stderr: "" };
		}
		return realRunGit(cwd, args, env);
	});
	const request = { branch: "feat/common-cache" };
	const created = await ensureNamedWorktree(repo, request);
	assert.equal((await ensureNamedWorktree(repo, request)).baseCommit, created.baseCommit);
	assert.equal((await ensureNamedWorktree(repo, request)).path, created.path);
	assert.equal(resolutions, 1, "reuse has no extra common-directory Git process");
	rmSync(firstCommon, { recursive: true });
	common = join(repo, ".git");
	assert.equal((await ensureNamedWorktree(repo, request)).path, created.path);
	assert.equal(resolutions, 2, "a missing cached path is resolved again");
});

test("an occupied path copying another worktree's gitfile is refused without waiting for that worktree's index lock (#5202)", async () => {
	const repo = makeRepo();
	const sibling = await ensureNamedWorktree(repo, { branch: "feat/sibling" });
	const occupied = join(repo, "occupied");
	mkdirSync(occupied);
	writeFileSync(join(occupied, ".git"), readFileSync(join(sibling.path, ".git")));
	writeFileSync(join(repo, ".git", "worktrees", "feat+sibling", "index.lock"), "foreign checkout");
	let now = performance.now();
	vi.spyOn(performance, "now").mockImplementation(() => (now += 60_000));
	await assert.rejects(
		ensureNamedWorktree(repo, { branch: "feat/refused-copy", path: occupied }),
		/already exists and is not the worktree of branch "feat\/refused-copy"/,
	);
});
