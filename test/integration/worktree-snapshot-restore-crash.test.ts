import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	verifyWorktree,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { bunExecutable, type SpawnedProcess, sleep, spawnProcess } from "../helpers/runtime.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

// A real Bun child, Git subprocesses, and a 30-second stopped-lock expiry are structural costs of these tests.
const RESTORE_CRASH_TIMEOUT_MS = 120_000;
const RESTORE_LOCK_STALE_MS = 30_000;

const CHILD = `
import { readFileSync } from "node:fs";
import { MemorySnapshotBlobStore, restoreWorktreeSnapshot, setWorktreeSnapshotGit } from "./packages/coding-agent/src/core/worktree-snapshot/index.ts";
const data = JSON.parse(readFileSync(process.env.TEST_MANIFEST, "utf8"));
setWorktreeSnapshotGit(async () => ({ path: process.env.TEST_WRAPPER, env: { GIT_CONFIG_GLOBAL: process.env.TEST_CONFIG, GIT_CONFIG_NOSYSTEM: "1", HOME: process.env.TEST_HOME } }));
const blobs = new MemorySnapshotBlobStore();
await blobs.putBlobs(data.blobs.map(({ hash, data }) => ({ hash, data: Uint8Array.from(Buffer.from(data, "base64")) })));
try {
  const path = await restoreWorktreeSnapshot(data.snapshot, { blobs, storeDir: process.env.TEST_STORE, ...(process.env.TEST_INTO ? { into: process.env.TEST_INTO } : {}) });
  console.log(JSON.stringify({ path }));
} catch (error) {
  console.error(JSON.stringify({ name: error.name, code: error.code, hint: error.hint }));
  process.exitCode = 1;
}
`;

const WRAPPER = `#!/bin/sh
printf '%s\n' "$*" >> "$TEST_LOG"
case " $* " in
  *" worktree add "*)
    if [ "$TEST_FAULT" = add ]; then git "$@"; result=$?; [ "$result" -eq 0 ] || exit "$result"; kill -KILL "$PPID"; exit 0; fi
    if [ "$TEST_FAULT" = pause ]; then git "$@"; result=$?; [ "$result" -eq 0 ] || exit "$result"; : > "$TEST_READY"; while [ ! -e "$TEST_GO" ]; do sleep 0.05; done; exit 0; fi
    ;;
  *" read-tree --reset -u "*)
    if [ "$TEST_FAULT" = checkout ]; then git "$@"; result=$?; [ "$result" -eq 0 ] || exit "$result"; kill -KILL "$PPID"; exit 0; fi
    ;;
  *" worktree move "*)
    if [ "$TEST_FAULT" = move ]; then kill -KILL "$PPID"; exit 0; fi
    if [ "$TEST_FAULT" = stop ]; then : > "$TEST_READY"; kill -STOP "$PPID"; while [ ! -e "$TEST_GO" ]; do sleep 0.05; done; exec git "$@"; fi
    if [ "$TEST_FAULT" = race ]; then for arg do target=$arg; done; mkdir -p "$target"; printf 'user data\\n' > "$target/keep.txt"; exec git "$@"; fi
    ;;
  *" fetch "*"history.bundle "*)
    if [ "$TEST_FAULT" = bundle ]; then git "$@" & git_child=$!; kill -KILL "$PPID"; wait "$git_child"; exit 0; fi
    ;;
esac
exec git "$@"
`;

interface Fixture {
	readonly sandbox: GitSandbox;
	readonly snapshot: WorktreeSnapshot;
	readonly manifest: string;
	readonly wrapper: string;
	readonly log: string;
	readonly ready: string;
	readonly go: string;
}

async function fixture(): Promise<Fixture> {
	const sandbox = new GitSandbox();
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "unpushed.txt"), "committed\n");
	await sandbox.commitAll(clone, "unpushed");
	sandbox.write(join(clone, "dirty.txt"), "recorded\n");
	const captured = await captureWorktreeSnapshot(clone, { blobs: new MemorySnapshotBlobStore() });
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") throw new Error("fixture capture failed");
	assert.ok(captured.snapshot.bundle);
	const manifest = sandbox.path("manifest.json");
	writeFileSync(
		manifest,
		JSON.stringify({
			snapshot: captured.snapshot,
			blobs: captured.blobs.map((blob) => ({ hash: blob.hash, data: Buffer.from(blob.data).toString("base64") })),
		}),
	);
	const wrapper = sandbox.path("git-wrapper");
	writeFileSync(wrapper, WRAPPER);
	chmodSync(wrapper, 0o755);
	return {
		sandbox,
		snapshot: captured.snapshot,
		manifest,
		wrapper,
		log: sandbox.path("git.log"),
		ready: sandbox.path("ready"),
		go: sandbox.path("go"),
	};
}

function child(fixture: Fixture, store: string, fault: string, into?: string): SpawnedProcess {
	return spawnProcess([bunExecutable(), "-e", CHILD], {
		cwd: process.cwd(),
		env: {
			...process.env,
			TEST_MANIFEST: fixture.manifest,
			TEST_WRAPPER: fixture.wrapper,
			TEST_CONFIG: fixture.sandbox.globalConfig,
			TEST_HOME: fixture.sandbox.root,
			TEST_STORE: store,
			TEST_FAULT: fault,
			TEST_LOG: fixture.log,
			TEST_READY: fixture.ready,
			TEST_GO: fixture.go,
			TEST_INTO: into,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function result(process: SpawnedProcess): Promise<{ exit: number; stdout: string; stderr: string }> {
	const stdout = new Response(process.stdout).text();
	const stderr = new Response(process.stderr).text();
	const exit = await process.exited;
	return { exit, stdout: await stdout, stderr: await stderr };
}

async function waitFor(path: string): Promise<void> {
	for (let attempts = 0; attempts < 600; attempts++) {
		if (existsSync(path)) return;
		await sleep(50);
	}
	assert.fail(`child did not create its ready marker: ${path}`);
}

function ageLocks(store: string): void {
	const records = join(store, "restores");
	if (!existsSync(records)) return;
	const old = new Date(Date.now() - RESTORE_LOCK_STALE_MS * 2);
	for (const name of readdirSync(records)) if (name.endsWith(".lock")) utimesSync(join(records, name), old, old);
}

async function assertHealthy(fixture: Fixture, store: string, results: readonly string[]): Promise<void> {
	const { sandbox, snapshot } = fixture;
	const worktrees = join(store, "worktrees");
	assert.deepEqual(readdirSync(worktrees).sort(), results.map((path) => path.split(/[\\/]/).at(-1)).sort());
	for (const path of results) {
		assert.equal(readFileSync(join(path, "dirty.txt"), "utf8"), "recorded\n");
		assert.equal((await verifyWorktree(snapshot, path)).tree, snapshot.tree);
	}
	const repositories = join(store, "repositories");
	for (const name of readdirSync(repositories)) {
		const repo = join(repositories, name);
		const listing = await sandbox.git(sandbox.root, "--git-dir", repo, "worktree", "list", "--porcelain");
		assert.doesNotMatch(listing, /^(locked|prunable)( |$)/m);
		await sandbox.git(sandbox.root, "--git-dir", repo, "fsck", "--no-reflogs");
	}
	if (existsSync(join(store, "restores"))) assert.deepEqual(readdirSync(join(store, "restores")), []);
}

async function retry(fixture: Fixture, store: string): Promise<string> {
	const retried = await result(child(fixture, store, "none"));
	assert.equal(retried.exit, 0, retried.stderr);
	return (JSON.parse(retried.stdout) as { path: string }).path;
}

test.skipIf(process.platform === "win32")(
	"SIGKILL at four restore phases leaves no unverified published worktree and stale staging is swept (#4245)",
	async () => {
		const f = await fixture();
		try {
			for (const phase of ["add", "checkout", "move", "bundle"]) {
				const store = f.sandbox.path(`host-${phase}`);
				const killed = child(f, store, phase);
				const outcome = await result(killed);
				assert.equal(killed.signalCode, "SIGKILL", `${phase}: ${outcome.stderr}`);
				const worktrees = join(store, "worktrees");
				if (existsSync(worktrees)) assert.ok(readdirSync(worktrees).every((name) => name.startsWith(".staging-")));
				ageLocks(store);
				const path = await retry(f, store);
				await assertHealthy(f, store, [path]);
			}
			assert.ok(
				readFileSync(f.log, "utf8").trim().split("\n").length < 200,
				"recovery uses a bounded number of Git calls",
			);
		} finally {
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a stale locked-initializing worktree is swept even when removal is the next operation (#4245)",
	async () => {
		const f = await fixture();
		try {
			const store = f.sandbox.path("host");
			const first = await retry(f, store);
			const repositories = join(store, "repositories");
			const repo = join(repositories, readdirSync(repositories)[0]!);
			const id = randomUUID();
			const staging = join(store, "worktrees", `.staging-${id}`);
			const target = join(store, "worktrees", `unused-${id}`);
			await f.sandbox.git(
				f.sandbox.root,
				"--git-dir",
				repo,
				"worktree",
				"add",
				"-q",
				"--detach",
				"--no-checkout",
				staging,
				f.snapshot.head,
			);
			await f.sandbox.git(
				f.sandbox.root,
				"--git-dir",
				repo,
				"worktree",
				"lock",
				"--reason",
				"initializing",
				staging,
			);
			mkdirSync(join(store, "restores"), { recursive: true });
			writeFileSync(
				join(store, "restores", `${id}.json`),
				JSON.stringify({ staging, target, store: repo, createdTarget: true }),
			);
			await removeRestoredWorktree(f.sandbox.path("does-not-exist"), { storeDir: store });
			assert.equal(existsSync(staging), false);
			await assertHealthy(f, store, [first]);
		} finally {
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a concurrent restore never sweeps another process's live staging worktree (#4245)",
	async () => {
		const f = await fixture();
		let paused: SpawnedProcess | undefined;
		try {
			const store = f.sandbox.path("host");
			paused = child(f, store, "pause");
			await waitFor(f.ready);
			const first = await retry(f, store);
			writeFileSync(f.go, "continue");
			const resumed = await result(paused);
			assert.equal(resumed.exit, 0, resumed.stderr);
			paused = undefined;
			const second = (JSON.parse(resumed.stdout) as { path: string }).path;
			await assertHealthy(f, store, [first, second]);
		} finally {
			if (paused) {
				paused.kill("SIGKILL");
				await paused.exited;
			}
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"an interrupted restore into an existing empty directory recreates it before the retry (#4245)",
	async () => {
		const f = await fixture();
		try {
			const store = f.sandbox.path("host");
			const into = f.sandbox.path("existing-empty");
			mkdirSync(into);
			const killed = child(f, store, "move", into);
			await result(killed);
			assert.equal(killed.signalCode, "SIGKILL");
			assert.equal(
				existsSync(into),
				false,
				"the process stopped between removing the empty target and moving staging",
			);
			ageLocks(store);
			await removeRestoredWorktree(f.sandbox.path("does-not-exist"), { storeDir: store });
			assert.deepEqual(readdirSync(into), [], "recovery recreated the original empty directory");
			const resumed = await result(child(f, store, "none", into));
			assert.equal(resumed.exit, 0, resumed.stderr);
			assert.equal((JSON.parse(resumed.stdout) as { path: string }).path, into);
			assert.equal((await verifyWorktree(f.snapshot, into)).tree, f.snapshot.tree);
			assert.equal(readFileSync(join(into, "dirty.txt"), "utf8"), "recorded\n");
			assert.deepEqual(readdirSync(join(store, "restores")), []);
		} finally {
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a restore stopped past its lock's stale window is swept and fails typed when resumed (#4245)",
	async () => {
		const f = await fixture();
		let stopped: SpawnedProcess | undefined;
		try {
			const store = f.sandbox.path("host");
			stopped = child(f, store, "stop");
			await waitFor(f.ready);
			await sleep(RESTORE_LOCK_STALE_MS + 2_000);
			const recovered = await retry(f, store);
			writeFileSync(f.go, "continue");
			stopped.kill("SIGCONT");
			const resumed = await result(stopped);
			stopped = undefined;
			assert.equal(resumed.exit, 1, resumed.stderr);
			const error = JSON.parse(resumed.stderr) as { name: string; code: string; hint: string };
			assert.equal(error.name, "WorkspaceGitError");
			assert.equal(error.code, "git-failed");
			assert.ok(error.hint);
			await assertHealthy(f, store, [recovered]);
		} finally {
			if (stopped) {
				stopped.kill("SIGCONT");
				stopped.kill("SIGKILL");
				await stopped.exited;
			}
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);

test.skipIf(process.platform === "win32")(
	"a target created during publication is never returned as the verified worktree (#4245)",
	async () => {
		const f = await fixture();
		try {
			const store = f.sandbox.path("host");
			const into = f.sandbox.path("target");
			const raced = await result(child(f, store, "race", into));
			assert.equal(raced.exit, 1, raced.stderr);
			const error = JSON.parse(raced.stderr) as { name: string; code: string };
			assert.equal(error.name, "WorkspaceRestoreError");
			assert.equal(error.code, "unsafe-target");
			assert.deepEqual(readdirSync(into), ["keep.txt"]);
			assert.equal(readFileSync(join(into, "keep.txt"), "utf8"), "user data\n");
			assert.deepEqual(readdirSync(join(store, "restores")), []);
		} finally {
			f.sandbox.dispose();
		}
	},
	RESTORE_CRASH_TIMEOUT_MS,
);
