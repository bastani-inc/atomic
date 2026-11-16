import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { ensureNamedWorktree } from "../../packages/subagents/src/runs/shared/named-worktree.js";
import { addNamedWorktree } from "../../packages/subagents/src/runs/shared/named-worktree-git.js";
import { sleep, spawnSyncCollect } from "../helpers/runtime.js";

const REPEATED_SUPERVISED_GIT_TIMEOUT_MS = 120_000;
const SPOOL_RETIREMENT_WAIT_MS = 5_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function posixPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function git(cwd: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd, env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString("utf8").trim();
}

function makeRepo(): { root: string; repo: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-nw-supervisor-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "init");
	return { root, repo };
}

async function waitForFile(target: string, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(target)) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${target}`);
		await sleep(50);
	}
}

test("background processes started by a post-checkout hook survive normal git exit with or without stdio redirection (#5202)", async () => {
	const { root, repo } = makeRepo();
	const redirectedMarker = join(root, "redirected.txt");
	const nohupMarker = join(root, "nohup.txt");
	const unredirectedMarker = join(root, "unredirected.txt");
	const writerScript = join(root, "bg-writer.mjs");
	writeFileSync(
		writerScript,
		`import { writeFileSync } from "node:fs";
const [target, label, delayMs] = process.argv.slice(2);
setTimeout(() => {
	writeFileSync(target, label + "\\n");
	process.exit(0);
}, Number(delayMs));
`,
	);
	const hooksDir = join(repo, ".git", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const hookPath = join(hooksDir, "post-checkout");
	const nodeBin = posixPath(process.execPath);
	const scriptPath = posixPath(writerScript);
	writeFileSync(
		hookPath,
		`#!/bin/sh
("${nodeBin}" "${scriptPath}" "${posixPath(redirectedMarker)}" "redirected" 1500) >/dev/null 2>&1 &
nohup "${nodeBin}" "${scriptPath}" "${posixPath(nohupMarker)}" "nohup" 1500 >/dev/null 2>&1 &
("${nodeBin}" "${scriptPath}" "${posixPath(unredirectedMarker)}" "unredirected" 1500) &
exit 0
`,
	);
	chmodSync(hookPath, 0o755);

	const created = await ensureNamedWorktree(repo, { branch: "feat/bg-hook" });
	assert.equal(created.branch, "feat/bg-hook");

	await waitForFile(redirectedMarker);
	await waitForFile(nohupMarker);
	await waitForFile(unredirectedMarker);
	assert.equal(readFileSync(redirectedMarker, "utf8").trim(), "redirected");
	assert.equal(readFileSync(nohupMarker, "utf8").trim(), "nohup");
	assert.equal(readFileSync(unredirectedMarker, "utf8").trim(), "unredirected");
});

test("addNamedWorktree captures large hook diagnostics and settles boundedly when a background child keeps writing (#5202)", async () => {
	const { root, repo } = makeRepo();
	const doneMarker = join(root, "chatter-done.txt");
	const hookScript = join(root, "large-hook.mjs");
	writeFileSync(
		hookScript,
		`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, doneFile] = process.argv.slice(2);
if (mode === "child") {
	process.stderr.on("error", () => {});
	try {
		process.on("SIGPIPE", () => {});
	} catch {}
	const timer = setInterval(() => {
		try {
			process.stderr.write("background-chatter\\n");
		} catch {}
	}, 10);
	setTimeout(() => {
		clearInterval(timer);
		writeFileSync(doneFile, "done\\n");
		process.exit(0);
	}, 1500);
} else {
	const payload = "HEADER:" + "x".repeat(120_000) + ":TRAILER\\n";
	process.stderr.write(payload, () => {
		process.exit(0);
	});
}
`,
	);
	const hooksDir = join(repo, ".git", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const hookPath = join(hooksDir, "post-checkout");
	writeFileSync(
		hookPath,
		`#!/bin/sh
("${posixPath(process.execPath)}" "${posixPath(hookScript)}" "child" "${posixPath(doneMarker)}") &
exec "${posixPath(process.execPath)}" "${posixPath(hookScript)}" "leader" "${posixPath(doneMarker)}"
`,
	);
	chmodSync(hookPath, 0o755);

	const target = join(repo, ".atomic", "worktrees", "feat+large-hook");
	const added = await addNamedWorktree(repo, ["worktree", "add", "-b", "feat/large-hook", target, "HEAD"], {});
	assert.equal(added.status, 0);
	assert.match(added.stdout, /HEADER:x{120000}:TRAILER/);
	await waitForFile(doneMarker);
	assert.equal(readFileSync(doneMarker, "utf8").trim(), "done");
});

test("cancelling a named-worktree checkout during a post-checkout hook terminates its background child (#5202)", async () => {
	const { root, repo } = makeRepo();
	const startedMarker = join(root, "cancel-started.txt");
	const lateMarker = join(root, "cancel-survived.txt");
	const writerScript = join(root, "cancel-writer.mjs");
	writeFileSync(
		writerScript,
		`import { writeFileSync } from "node:fs";
const [startedFile, lateFile] = process.argv.slice(2);
writeFileSync(startedFile, String(process.pid) + "\\n");
setTimeout(() => {
	writeFileSync(lateFile, "survived\\n");
	process.exit(0);
}, 2000);
`,
	);
	const hooksDir = join(repo, ".git", "hooks");
	mkdirSync(hooksDir, { recursive: true });
	const hookPath = join(hooksDir, "post-checkout");
	writeFileSync(
		hookPath,
		`#!/bin/sh
"${posixPath(process.execPath)}" "${posixPath(writerScript)}" "${posixPath(startedMarker)}" "${posixPath(lateMarker)}" >/dev/null 2>&1 &
sleep 10
`,
	);
	chmodSync(hookPath, 0o755);

	const controller = new AbortController();
	const launch = ensureNamedWorktree(repo, { branch: "feat/cancel-hook" }, { signal: controller.signal });
	await waitForFile(startedMarker);
	controller.abort(new Error("abort during hook"));
	await assert.rejects(launch, /abort during hook/);
	await sleep(2_500);
	assert.equal(
		existsSync(lateMarker),
		false,
		"cancelled checkout must terminate background child started by active hook",
	);
});

test(
	"repeated addNamedWorktree calls reuse one TaskSupervisor owner and cap retained spool files at 256 (#5202)",
	async () => {
		const { repo } = makeRepo();
		const spoolPrefix = `atomic-command-${process.pid}-`;
		const beforeSpools = new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith(spoolPrefix)));
		for (let index = 0; index < 300; index += 1) {
			const result = await addNamedWorktree(repo, ["worktree", "list", "--porcelain"], {});
			assert.equal(result.status, 0);
		}
		const burst = Array.from({ length: 320 }, () => addNamedWorktree(repo, ["worktree", "list", "--porcelain"], {}));
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
		const burstResults = await Promise.all(burst);
		for (const result of burstResults) {
			assert.equal(result.status, 0);
			assert.match(result.stdout, /worktree /);
		}
		const countAddedSpools = (): number =>
			readdirSync(tmpdir()).filter((entry) => entry.startsWith(spoolPrefix) && !beforeSpools.has(entry)).length;
		const deadline = Date.now() + SPOOL_RETIREMENT_WAIT_MS;
		while (countAddedSpools() > 256 && Date.now() < deadline) {
			await sleep(50);
		}
		const remaining = countAddedSpools();
		assert.ok(remaining <= 256, `expected <= 256 spool files, got ${remaining}`);
	},
	REPEATED_SUPERVISED_GIT_TIMEOUT_MS,
);
