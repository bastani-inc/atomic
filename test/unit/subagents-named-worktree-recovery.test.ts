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
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { createGitEnvironment } from "../../packages/coding-agent/src/utils/git-env.js";
import { bunExecutable, moduleDir, readStreamText, sleep, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";

const CHECKOUT_PROCESS_TIMEOUT_MS = 60_000;
const CHECKOUT_EVENT_TIMEOUT_MS = 15_000;
const CONCURRENT_ADD_WAIT_MS = 30_000;
const FAST_FAILURE_BUDGET_MS = CONCURRENT_ADD_WAIT_MS / 3;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(repo: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", "-C", repo, ...args], { env: createGitEnvironment() });
	assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function shellPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function makeRepo(): { root: string; repo: string; target: string; entry: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "named-worktree-recovery-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
	git(repo, "config", "core.autocrlf", "false");
	writeFileSync(join(repo, "README.md"), "hello\n");
	writeFileSync(join(repo, ".gitattributes"), "slow.txt filter=slow\n");
	writeFileSync(join(repo, "slow.txt"), "payload\n");
	git(repo, "add", ".");
	git(repo, "commit", "-qm", "init");
	return {
		root,
		repo,
		target: join(repo, ".atomic", "worktrees", "feat+recover"),
		entry: join(repo, ".git", "worktrees", "feat+recover"),
	};
}

function holdBeforeIndex(repo: string, root: string): { started: string; release: string; remove: () => void } {
	const started = join(root, "checkout-started");
	const release = join(root, "checkout-release");
	const hold = `[ -e "${shellPath(started)}" ] && exit 0\necho ready > "${shellPath(started)}"\nwhile [ ! -e "${shellPath(release)}" ]; do sleep 0.05; done\n`;
	const monitor = join(root, "fsmonitor");
	writeFileSync(monitor, `#!/bin/sh\ncase "$PWD" in\n*/feat+recover) ;;\n*) exit 1 ;;\nesac\n${hold}exit 1\n`);
	chmodSync(monitor, 0o755);
	git(repo, "config", "core.fsmonitor", shellPath(monitor));
	const hook = join(repo, ".git", "hooks", "reference-transaction");
	writeFileSync(
		hook,
		`#!/bin/sh\nin=$(cat)\n[ "$1" = committed ] || exit 0\nprintf '%s\\n' "$in" | grep -q ' HEAD$' || exit 0\n${hold}`,
	);
	chmodSync(hook, 0o755);
	cleanups.push(() => writeFileSync(release, "release\n"));
	return {
		started,
		release,
		remove: () => {
			writeFileSync(release, "release\n");
			git(repo, "config", "--unset", "core.fsmonitor");
			rmSync(hook, { force: true });
		},
	};
}

function holdPreparedRefTransaction(
	repo: string,
	root: string,
	entry: string,
): { started: string; release: string; remove: () => void } {
	const started = join(root, "prepared-started");
	const release = join(root, "prepared-release");
	const hold = `[ -e "${shellPath(started)}" ] && exit 0\necho ready > "${shellPath(started)}"\nwhile [ ! -e "${shellPath(release)}" ]; do sleep 0.05; done\n`;
	const hook = join(repo, ".git", "hooks", "reference-transaction");
	writeFileSync(
		hook,
		`#!/bin/sh\nin=$(cat)\n[ "$1" = prepared ] || exit 0\n[ -d "${shellPath(entry)}" ] || exit 0\nprintf '%s\\n' "$in" | grep -Eq ' (HEAD|refs/heads/feat/recover)$' || exit 0\n${hold}`,
	);
	chmodSync(hook, 0o755);
	cleanups.push(() => writeFileSync(release, "release\n"));
	return {
		started,
		release,
		remove: () => {
			writeFileSync(release, "release\n");
			rmSync(hook, { force: true });
		},
	};
}

function writeGermanGitCatalog(root: string): string {
	const entries: Array<[string, string]> = [
		["", "Content-Type: text/plain; charset=UTF-8\n"],
		["initializing", "initialisiere"],
	];
	const count = entries.length;
	const headerSize = 28;
	const tableSize = count * 8;
	const origTableOffset = headerSize;
	const transTableOffset = origTableOffset + tableSize;
	let stringOffset = transTableOffset + tableSize;
	const origBuffers = entries.map(([key]) => Buffer.from(key, "utf8"));
	const transBuffers = entries.map(([, value]) => Buffer.from(value, "utf8"));
	const totalSize =
		stringOffset +
		origBuffers.reduce((sum, item) => sum + item.length + 1, 0) +
		transBuffers.reduce((sum, item) => sum + item.length + 1, 0);
	const catalog = Buffer.alloc(totalSize);
	catalog.writeUInt32LE(0x950412de, 0);
	catalog.writeUInt32LE(0, 4);
	catalog.writeUInt32LE(count, 8);
	catalog.writeUInt32LE(origTableOffset, 12);
	catalog.writeUInt32LE(transTableOffset, 16);
	catalog.writeUInt32LE(0, 20);
	catalog.writeUInt32LE(stringOffset, 24);
	for (let index = 0; index < count; index++) {
		const original = origBuffers[index]!;
		catalog.writeUInt32LE(original.length, origTableOffset + index * 8);
		catalog.writeUInt32LE(stringOffset, origTableOffset + index * 8 + 4);
		original.copy(catalog, stringOffset);
		stringOffset += original.length + 1;
	}
	for (let index = 0; index < count; index++) {
		const translated = transBuffers[index]!;
		catalog.writeUInt32LE(translated.length, transTableOffset + index * 8);
		catalog.writeUInt32LE(stringOffset, transTableOffset + index * 8 + 4);
		translated.copy(catalog, stringOffset);
		stringOffset += translated.length + 1;
	}
	const localeDir = join(root, "locale");
	const moDir = join(localeDir, "de", "LC_MESSAGES");
	mkdirSync(moDir, { recursive: true });
	writeFileSync(join(moDir, "git.mo"), catalog);
	return localeDir;
}

async function waitFor(target: string): Promise<void> {
	const deadline = Date.now() + CHECKOUT_EVENT_TIMEOUT_MS;
	while (!existsSync(target)) {
		assert.ok(Date.now() < deadline, `timed out waiting for ${target}`);
		await sleep(25);
	}
}

const moduleUrl = pathToFileURL(
	join(moduleDir(import.meta.url), "../../packages/subagents/src/runs/shared/named-worktree.ts"),
).href;
const launchScript = `const [moduleUrl, repo, abortAt, readyAt] = process.argv.slice(1);
const fs = require("node:fs");
const { ensureNamedWorktree } = await import(moduleUrl);
const controller = new AbortController();
const timer = abortAt ? setInterval(() => { if (fs.existsSync(abortAt)) controller.abort(new Error("cancel checkout")); }, 20) : undefined;
try {
 if (readyAt) fs.writeFileSync(readyAt, "ready\\n");
 const result = await ensureNamedWorktree(repo, { branch: "feat/recover" }, { signal: controller.signal });
 console.log(JSON.stringify({ ok: true, path: result.path }));
} catch (error) {
 console.log(JSON.stringify({ ok: false, name: error.name, message: error.message }));
} finally { clearInterval(timer); }`;

function launch(repo: string, abortAt = "", readyAt = "") {
	const child = spawnProcess([bunExecutable(), "-e", launchScript, moduleUrl, repo, abortAt, readyAt], {
		cwd: repo,
		env: createGitEnvironment(),
		stdout: "pipe",
		stderr: "pipe",
	});
	cleanups.push(async () => {
		try {
			child.kill("SIGKILL");
		} catch {}
		await child.exited;
	});
	return child;
}

interface Outcome {
	ok: boolean;
	path?: string;
	name?: string;
	message?: string;
}

async function collect(child: ReturnType<typeof launch>): Promise<Outcome> {
	const [stdout, stderr, code] = await Promise.all([
		readStreamText(child.stdout),
		readStreamText(child.stderr),
		child.exited,
	]);
	assert.equal(code, 0, `${stdout}\n${stderr}`);
	return JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as Outcome;
}

function completeOrRefused(outcome: Outcome, repo: string, target: string): void {
	if (outcome.ok) {
		assert.equal(readFileSync(join(target, "README.md"), "utf8"), "hello\n");
		assert.equal(readFileSync(join(target, "slow.txt"), "utf8"), "payload\n");
		assert.equal(git(target, "status", "--porcelain"), "");
	} else {
		assert.equal(outcome.name, "WorktreeBusyError", outcome.message);
		assert.match(outcome.message ?? "", /git worktree remove --force --force/);
		assert.ok(outcome.message?.includes(target));
	}
	assert.ok(shellPath(git(repo, "worktree", "list", "--porcelain")).includes(shellPath(repo)));
}

test(
	"a queued launch never reuses an empty worktree after host death before index creation (#5202)",
	async () => {
		const { root, repo, target, entry } = makeRepo();
		const hold = holdBeforeIndex(repo, root);
		const first = launch(repo);
		await waitFor(hold.started);
		assert.equal(readFileSync(join(entry, "HEAD"), "utf8").trim(), "ref: refs/heads/feat/recover");
		assert.equal(existsSync(join(entry, "index")), false);
		assert.equal(existsSync(join(entry, "index.lock")), false);
		assert.deepEqual(readdirSync(target), [".git"]);
		const ready = join(root, "queued-ready");
		let finished = false;
		const queued = collect(launch(repo, "", ready)).then((result) => {
			finished = true;
			return result;
		});
		await waitFor(ready);
		await sleep(300);
		assert.equal(finished, false);
		first.kill("SIGKILL");
		await first.exited;
		const outcome = await queued;
		completeOrRefused(outcome, repo, target);
		hold.remove();
		completeOrRefused(await collect(launch(repo)), repo, target);
	},
	CHECKOUT_PROCESS_TIMEOUT_MS,
);

test(
	"cancellation before index creation never permits an empty worktree on relaunch (#5202)",
	async () => {
		const { root, repo, target, entry } = makeRepo();
		const hold = holdBeforeIndex(repo, root);
		const cancelled = await collect(launch(repo, hold.started));
		assert.equal(cancelled.ok, false);
		assert.match(cancelled.message ?? "", /cancel checkout/);
		hold.remove();
		const outcome = await collect(launch(repo));
		completeOrRefused(outcome, repo, target);
		if (!outcome.ok) {
			assert.equal(existsSync(join(entry, "index")), false);
			git(repo, "worktree", "remove", "--force", "--force", target);
			const repaired = await collect(launch(repo));
			assert.equal(repaired.ok, true, repaired.message);
			completeOrRefused(repaired, repo, target);
		}
	},
	CHECKOUT_PROCESS_TIMEOUT_MS,
);

test(
	"removing index.lock after a killed checkout does not turn a partial checkout into success (#5202)",
	async () => {
		const { root, repo, target, entry } = makeRepo();
		const started = join(root, "smudge-started");
		git(repo, "config", "filter.slow.smudge", `echo ready > "${shellPath(started)}"; sleep 20; cat`);
		const first = launch(repo);
		await waitFor(started);
		await waitFor(join(entry, "index.lock"));
		first.kill("SIGKILL");
		await first.exited;
		await sleep(1_500);
		git(repo, "config", "--unset", "filter.slow.smudge");
		const began = performance.now();
		const blocked = await collect(launch(repo));
		assert.equal(blocked.ok, false, "an interrupted checkout must be refused before manual repair");
		assert.ok(
			performance.now() - began < FAST_FAILURE_BUDGET_MS,
			"Atomic's interrupted add is identified without a 30-second wait",
		);
		completeOrRefused(blocked, repo, target);
		rmSync(join(entry, "index.lock"), { force: true });
		const withoutLock = await collect(launch(repo));
		assert.equal(withoutLock.ok, false, "deleting only index.lock is not checkout repair");
		completeOrRefused(withoutLock, repo, target);
		git(repo, "worktree", "remove", "--force", "--force", target);
		const repaired = await collect(launch(repo));
		assert.equal(repaired.ok, true, repaired.message);
		completeOrRefused(repaired, repo, target);
	},
	CHECKOUT_PROCESS_TIMEOUT_MS,
);

test(
	"an external add between HEAD and index creation is not reused until checkout completes (#5202)",
	async () => {
		const { root, repo, target, entry } = makeRepo();
		const hold = holdBeforeIndex(repo, root);
		const external = spawnProcess(["git", "-C", repo, "worktree", "add", "-b", "feat/recover", target], {
			cwd: repo,
			env: createGitEnvironment({ LANGUAGE: "C" }),
			stdout: "pipe",
			stderr: "pipe",
		});
		cleanups.push(async () => {
			writeFileSync(hold.release, "release\n");
			await external.exited;
		});
		await waitFor(hold.started);
		assert.equal(existsSync(join(entry, "index")), false);
		assert.equal(existsSync(join(entry, "index.lock")), false);
		const ready = join(root, "waiter-ready");
		let finished = false;
		const waiter = collect(launch(repo, "", ready)).then((result) => {
			finished = true;
			return result;
		});
		await waitFor(ready);
		await sleep(1_000);
		assert.equal(finished, false, "the launch must wait instead of returning the .git-only worktree");
		writeFileSync(hold.release, "release\n");
		const [outcome, code, stderr] = await Promise.all([waiter, external.exited, readStreamText(external.stderr)]);
		assert.equal(code, 0, stderr);
		assert.equal(outcome.ok, true, outcome.message);
		hold.remove();
		completeOrRefused(outcome, repo, target);
	},
	CHECKOUT_PROCESS_TIMEOUT_MS,
);

test(
	"a localized external add between HEAD and index creation is not reused until checkout completes (#5202)",
	async () => {
		const { root, repo, target, entry } = makeRepo();
		const localeDir = writeGermanGitCatalog(root);
		const locale = process.platform === "win32" ? "de_DE.UTF-8" : "en_US.UTF-8";
		const hold = holdBeforeIndex(repo, root);
		const external = spawnProcess(["git", "-C", repo, "worktree", "add", "-b", "feat/recover", target], {
			cwd: repo,
			env: createGitEnvironment({
				GIT_TEXTDOMAINDIR: localeDir,
				LANGUAGE: "de",
				LC_ALL: locale,
				LANG: locale,
			}),
			stdout: "pipe",
			stderr: "pipe",
		});
		cleanups.push(async () => {
			writeFileSync(hold.release, "release\n");
			await external.exited;
		});
		await waitFor(hold.started);
		assert.equal(readFileSync(join(entry, "locked"), "utf8").trim(), "initialisiere");
		assert.equal(existsSync(join(entry, "index")), false);
		assert.equal(existsSync(join(entry, "index.lock")), false);
		const ready = join(root, "localized-waiter-ready");
		let finished = false;
		const waiter = collect(launch(repo, "", ready)).then((result) => {
			finished = true;
			return result;
		});
		await waitFor(ready);
		await sleep(1_000);
		assert.equal(finished, false, "the launch must wait for a localized initializing marker");
		writeFileSync(hold.release, "release\n");
		const [outcome, code, stderr] = await Promise.all([waiter, external.exited, readStreamText(external.stderr)]);
		assert.equal(code, 0, stderr);
		assert.equal(outcome.ok, true, outcome.message);
		hold.remove();
		completeOrRefused(outcome, repo, target);
	},
	CHECKOUT_PROCESS_TIMEOUT_MS,
);

test(
	"an external add held during its prepared HEAD transaction is waited for instead of refused (#5202)",
	async () => {
		const { root, repo, target, entry } = makeRepo();
		const hold = holdPreparedRefTransaction(repo, root, entry);
		const external = spawnProcess(["git", "-C", repo, "worktree", "add", "-b", "feat/recover", target], {
			cwd: repo,
			env: createGitEnvironment({ LANGUAGE: "C" }),
			stdout: "pipe",
			stderr: "pipe",
		});
		cleanups.push(async () => {
			writeFileSync(hold.release, "release\n");
			await external.exited;
		});
		await waitFor(hold.started);
		assert.equal(existsSync(join(entry, "HEAD.lock")), true);
		const ready = join(root, "prepared-waiter-ready");
		let finished = false;
		const waiter = collect(launch(repo, "", ready)).then((result) => {
			finished = true;
			return result;
		});
		await waitFor(ready);
		await sleep(1_000);
		assert.equal(finished, false, "the launch must wait while the external add's ref transaction is prepared");
		writeFileSync(hold.release, "release\n");
		const [outcome, code, stderr] = await Promise.all([waiter, external.exited, readStreamText(external.stderr)]);
		assert.equal(code, 0, stderr);
		assert.equal(outcome.ok, true, outcome.message);
		hold.remove();
		completeOrRefused(outcome, repo, target);
	},
	CHECKOUT_PROCESS_TIMEOUT_MS,
);

test(
	"killing an owned add during its prepared ref transaction refuses relaunch until unlocked and pruned (#5202)",
	async () => {
		const { root, repo, target, entry } = makeRepo();
		const hold = holdPreparedRefTransaction(repo, root, entry);
		const first = launch(repo);
		await waitFor(hold.started);
		assert.equal(existsSync(join(entry, "HEAD.lock")), true);
		first.kill("SIGKILL");
		await first.exited;
		await sleep(1_500);
		hold.remove();
		const began = performance.now();
		const blocked = await collect(launch(repo));
		assert.equal(blocked.ok, false, "an interrupted ref transaction must be refused before manual repair");
		assert.ok(
			performance.now() - began < FAST_FAILURE_BUDGET_MS,
			"Atomic's interrupted add is identified without a 30-second wait",
		);
		assert.equal(blocked.name, "WorktreeBusyError", blocked.message);
		assert.match(blocked.message ?? "", /interrupted named-worktree checkout/);
		assert.match(blocked.message ?? "", /git worktree unlock/);
		assert.match(blocked.message ?? "", /git worktree prune/);
		assert.match(blocked.message ?? "", /HEAD\.lock/);
		completeOrRefused(blocked, repo, target);
		git(repo, "worktree", "unlock", target);
		rmSync(target, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		rmSync(join(repo, ".git", "refs", "heads", "feat", "recover.lock"), { force: true });
		const repaired = await collect(launch(repo));
		assert.equal(repaired.ok, true, repaired.message);
		completeOrRefused(repaired, repo, target);
	},
	CHECKOUT_PROCESS_TIMEOUT_MS,
);
