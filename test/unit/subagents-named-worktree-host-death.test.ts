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
import { afterEach, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import { bunExecutable, moduleDir, readStreamText, sleep, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const HOST_DEATH_PROCESS_TIMEOUT_MS = 120_000;
const ORPHAN_EXIT_WAIT_MS = 8_000;
const HELPER_HOLD_MS = 20_000;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function posixPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString("utf8").trim();
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ESRCH") return false;
		return true;
	}
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const closeParen = stat.lastIndexOf(")");
			const state = closeParen >= 0 ? stat.slice(closeParen + 2, closeParen + 3) : "";
			if (state === "Z" || state === "X") return false;
		} catch {
			return false;
		}
	}
	return true;
}

async function waitForPidFile(pidFile: string, timeoutMs = 15_000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(pidFile)) {
			const raw = readFileSync(pidFile, "utf8").trim();
			const pid = Number(raw);
			if (Number.isInteger(pid) && pid > 0) {
				// #6125: recorded as soon as it records its pid, so the cleanup never signals a later process given it.
				const recorded = await recordProcess(pid);
				cleanups.push(() => signalRecordedProcess(recorded));
				return pid;
			}
		}
		await sleep(40);
	}
	assert.fail(`timed out waiting for pid file ${pidFile}`);
}

async function waitForPath(target: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(target)) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${target}`);
		await sleep(40);
	}
}

async function waitForPidGone(pid: number, timeoutMs = ORPHAN_EXIT_WAIT_MS): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await sleep(50);
	}
	return !isPidAlive(pid);
}

function makeRepo(): { root: string; repo: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-nw-host-death-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
	return { root, repo };
}

const namedWorktreeModuleUrl = pathToFileURL(
	join(moduleDir(import.meta.url), "../../packages/subagents/src/runs/shared/named-worktree.ts"),
).href;

const HOST_LAUNCH_SCRIPT = `const [moduleUrl, repo, rawRequest] = process.argv.slice(1);
const fs = require("node:fs");
const path = require("node:path");
const { ensureNamedWorktree } = await import(moduleUrl);
const started = performance.now();
try {
	const result = await ensureNamedWorktree(repo, JSON.parse(rawRequest));
	const slowFile = path.join(result.path, "slow.txt");
	const slow = fs.existsSync(slowFile) ? fs.readFileSync(slowFile, "utf8") : null;
	console.log(JSON.stringify({ ok: true, ms: Math.round(performance.now() - started), path: result.path, branch: result.branch, slow }));
} catch (error) {
	console.log(JSON.stringify({
		ok: false,
		ms: Math.round(performance.now() - started),
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
	}));
}`;

interface HostLaunchOutcome {
	readonly ok: boolean;
	readonly ms: number;
	readonly path?: string;
	readonly branch?: string;
	readonly slow?: string | null;
	readonly name?: string;
	readonly message?: string;
}

function startHostProcess(repo: string, request: { branch: string; base?: string; path?: string }) {
	const child = spawnProcess(
		[bunExecutable(), "-e", HOST_LAUNCH_SCRIPT, namedWorktreeModuleUrl, repo, JSON.stringify(request)],
		{
			cwd: repo,
			stdout: "pipe",
			stderr: "pipe",
			env: createGitEnvironment(),
		},
	);
	cleanups.push(() => {
		try {
			child.kill("SIGKILL");
		} catch {}
	});
	return child;
}

async function collectHostOutcome(child: ReturnType<typeof startHostProcess>): Promise<HostLaunchOutcome> {
	const [stdout, stderr, exitCode] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	assert.equal(exitCode, 0, `host exited ${exitCode}: ${stdout}\n${stderr}`);
	const line = stdout.trim().split(/\r?\n/).at(-1);
	assert.ok(line, `missing host output: ${stderr}`);
	return JSON.parse(line) as HostLaunchOutcome;
}

test(
	"killing the host session with SIGKILL before git worktree add registers its .git/worktrees entry terminates git and lets the next launch create the worktree without overlap (#5202)",
	async () => {
		const { root, repo } = makeRepo();
		const preAdminPidFile = join(root, "pre-admin.pid");
		const preAdminLateMarker = join(root, "pre-admin-survived.txt");
		const refHookScript = join(root, "reference-transaction-helper.mjs");
		const adminEntry = join(repo, ".git", "worktrees", "feat+pre-admin");
		writeFileSync(
			refHookScript,
			`import { existsSync, renameSync, writeFileSync } from "node:fs";
const [state, pidFile, lateMarker, adminDir, holdMs] = process.argv.slice(2);
if (state !== "committed" || existsSync(adminDir) || existsSync(pidFile)) process.exit(0);
const tmp = pidFile + ".tmp";
writeFileSync(tmp, String(process.pid) + "\\n");
renameSync(tmp, pidFile);
setTimeout(() => {
	writeFileSync(lateMarker, "survived\\n");
	process.exit(0);
}, Number(holdMs));
`,
		);
		const hooksDir = join(repo, ".git", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const refHookPath = join(hooksDir, "reference-transaction");
		writeFileSync(
			refHookPath,
			`#!/bin/sh\nexec "${posixPath(process.execPath)}" "${posixPath(refHookScript)}" "$1" "${posixPath(preAdminPidFile)}" "${posixPath(preAdminLateMarker)}" "${posixPath(adminEntry)}" "${HELPER_HOLD_MS}"\n`,
		);
		chmodSync(refHookPath, 0o755);

		const firstHost = startHostProcess(repo, { branch: "feat/pre-admin" });
		const preAdminPid = await waitForPidFile(preAdminPidFile);
		assert.equal(existsSync(adminEntry), false, "worktree admin entry is not registered yet");
		assert.equal(isPidAlive(preAdminPid), true, "pre-admin git helper is running before host SIGKILL");

		firstHost.kill("SIGKILL");
		assert.equal(await waitForPidGone(firstHost.pid!), true);

		const exitedAfterKill = await waitForPidGone(preAdminPid);
		assert.equal(exitedAfterKill, true, `pre-admin git helper pid ${preAdminPid} remained alive after host SIGKILL`);
		assert.equal(existsSync(adminEntry), false, "killed pre-admin git worktree add never registered the worktree");

		rmSync(refHookPath, { force: true });
		const secondOutcome = await collectHostOutcome(startHostProcess(repo, { branch: "feat/pre-admin" }));
		// The helper's exit was confirmed above; by now its pid can name another process the second launch started.
		assert.equal(existsSync(preAdminLateMarker), false, "killed pre-admin git worktree add must not continue");
		assert.equal(secondOutcome.ok, true, secondOutcome.message);
		assert.equal(secondOutcome.path, join(repo, ".atomic", "worktrees", "feat+pre-admin"));
		assert.equal(secondOutcome.slow, "payload\n");
	},
	HOST_DEATH_PROCESS_TIMEOUT_MS,
);

test(
	"killing the host session with SIGKILL during a slow post-checkout hook terminates the git hook tree before the next launch reuses the worktree (#5202)",
	async () => {
		const { root, repo } = makeRepo();
		const hookPidFile = join(root, "post-checkout.pid");
		const hookLateMarker = join(root, "post-checkout-survived.txt");
		const hookScript = join(root, "post-checkout-helper.mjs");
		writeFileSync(
			hookScript,
			`import { renameSync, writeFileSync } from "node:fs";
const [pidFile, lateMarker, holdMs] = process.argv.slice(2);
const tmp = pidFile + ".tmp";
writeFileSync(tmp, String(process.pid) + "\\n");
renameSync(tmp, pidFile);
setTimeout(() => {
	writeFileSync(lateMarker, "survived\\n");
	process.exit(0);
}, Number(holdMs));
`,
		);
		const hooksDir = join(repo, ".git", "hooks");
		mkdirSync(hooksDir, { recursive: true });
		const hookPath = join(hooksDir, "post-checkout");
		writeFileSync(
			hookPath,
			`#!/bin/sh\nexec "${posixPath(process.execPath)}" "${posixPath(hookScript)}" "${posixPath(hookPidFile)}" "${posixPath(hookLateMarker)}" "${HELPER_HOLD_MS}"\n`,
		);
		chmodSync(hookPath, 0o755);

		const firstHost = startHostProcess(repo, { branch: "feat/hook-sigkill" });
		const hookPid = await waitForPidFile(hookPidFile);
		assert.equal(isPidAlive(hookPid), true, "post-checkout helper is running before host SIGKILL");

		firstHost.kill("SIGKILL");
		assert.equal(await waitForPidGone(firstHost.pid!), true);

		const exitedAfterKill = await waitForPidGone(hookPid);
		assert.equal(exitedAfterKill, true, `post-checkout helper pid ${hookPid} remained alive after host SIGKILL`);

		rmSync(hookPath, { force: true });
		const secondOutcome = await collectHostOutcome(startHostProcess(repo, { branch: "feat/hook-sigkill" }));
		// The helper's exit was confirmed above; by now its pid can name another process the second launch started.
		assert.equal(existsSync(hookLateMarker), false, "killed post-checkout hook must not finish in the background");
		assert.equal(secondOutcome.ok, true, secondOutcome.message);
		assert.equal(secondOutcome.path, join(repo, ".atomic", "worktrees", "feat+hook-sigkill"));
		assert.equal(secondOutcome.slow, "payload\n");
	},
	HOST_DEATH_PROCESS_TIMEOUT_MS,
);

test(
	"killing the host session during a smudge filter refuses the incomplete checkout until the worktree is repaired (#5202)",
	async () => {
		const { root, repo } = makeRepo();
		const smudgePidFile = join(root, "smudge.pid");
		const smudgeScript = join(root, "smudge-helper.mjs");
		writeFileSync(
			smudgeScript,
			`import { renameSync, writeFileSync } from "node:fs";
const [pidFile, holdMs] = process.argv.slice(2);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	const tmp = pidFile + ".tmp";
	writeFileSync(tmp, String(process.pid) + "\\n");
	renameSync(tmp, pidFile);
	setTimeout(() => {
		process.stdout.write(Buffer.concat(chunks));
		process.exit(0);
	}, Number(holdMs));
});
`,
		);
		git(
			repo,
			"config",
			"filter.slow.smudge",
			`"${posixPath(process.execPath)}" "${posixPath(smudgeScript)}" "${posixPath(smudgePidFile)}" "${HELPER_HOLD_MS}"`,
		);

		const indexLockPath = join(repo, ".git", "worktrees", "feat+smudge-sigkill", "index.lock");
		const firstHost = startHostProcess(repo, { branch: "feat/smudge-sigkill" });
		const smudgePid = await waitForPidFile(smudgePidFile);
		await waitForPath(indexLockPath);
		assert.equal(isPidAlive(smudgePid), true, "smudge helper is running before host SIGKILL");

		firstHost.kill("SIGKILL");
		assert.equal(await waitForPidGone(firstHost.pid!), true);

		const exitedAfterKill = await waitForPidGone(smudgePid);
		assert.equal(exitedAfterKill, true, `smudge helper pid ${smudgePid} remained alive after host SIGKILL`);

		git(repo, "config", "--unset", "filter.slow.smudge");

		assert.equal(existsSync(indexLockPath), true, "killed git checkout leaves index.lock intact");
		const busyOutcome = await collectHostOutcome(startHostProcess(repo, { branch: "feat/smudge-sigkill" }));
		assert.equal(busyOutcome.ok, false, "launch must refuse while killed git's index.lock remains");
		assert.match(busyOutcome.message ?? "", /interrupted named-worktree checkout/i);
		assert.match(busyOutcome.message ?? "", /git worktree remove --force --force/);
		assert.match(busyOutcome.message ?? "", /index\.lock/);

		rmSync(indexLockPath, { force: true });
		const stillIncomplete = await collectHostOutcome(startHostProcess(repo, { branch: "feat/smudge-sigkill" }));
		assert.equal(stillIncomplete.ok, false, "removing only index.lock does not complete the checkout");
		git(repo, "worktree", "remove", "--force", "--force", join(repo, ".atomic", "worktrees", "feat+smudge-sigkill"));

		const recoveredOutcome = await collectHostOutcome(startHostProcess(repo, { branch: "feat/smudge-sigkill" }));
		assert.equal(recoveredOutcome.ok, true, recoveredOutcome.message);
		assert.equal(recoveredOutcome.path, join(repo, ".atomic", "worktrees", "feat+smudge-sigkill"));
		assert.equal(recoveredOutcome.slow, "payload\n");
	},
	HOST_DEATH_PROCESS_TIMEOUT_MS,
);
