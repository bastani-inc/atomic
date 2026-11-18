import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { bunExecutable, sleep } from "../../../test/helpers/runtime.js";
import { latestResumeTimings } from "../src/core/resume/timings.js";
import { releaseSessionWorktrees } from "../src/core/session-worktree-snapshots.js";
import {
	claimIdleWorktree,
	evictIdleWorktrees,
	holdRestoredWorktree,
	pooledWorktreeHolder,
	releaseRestoredWorktree,
	repositoryIdOf,
} from "../src/core/worktree-snapshot/pool.js";
import { verifyWorktree } from "../src/core/worktree-snapshot/restore.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";
import {
	claimOptions,
	idleSlotOfX,
	recordFile,
	recordOf,
	resume,
	sandbox,
	sessionOf,
	settings,
	slot,
	store,
	storeDir,
	twoSnapshots,
	useWorktreePoolClaimSandbox,
	Y,
} from "./helpers/worktree-pool-claim-fixture.js";

useWorktreePoolClaimSandbox();

/** A Bun child that loads the snapshot modules and claims a slot before it is killed. */
const CHILD_PROCESS_TIMEOUT_MS = 60_000;
/** Four resumes, each running its blueprint maintenance, on a loaded machine. */
const FOUR_RESUMES_TIMEOUT_MS = 60_000;

describe("claiming an idle pooled worktree on resume (#4748)", () => {
	test("a resume claims another session's idle slot, resets it to its snapshot and keeps node_modules (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		await idleSlotOfX(a, clone);
		const y = await sessionOf(clone, b);

		const prepared = await resume(y);

		const root = slot(b, 0);
		assert.equal(prepared.sessionManager.getCwd(), root);
		assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "B\n");
		assert.equal(existsSync(join(root, "only-a.txt")), false);
		assert.equal(readFileSync(join(root, "node_modules", "dep", ".installed"), "utf8"), "marker\n");
		await verifyWorktree(b, root, { settings });
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), root), {
			owner: { kind: "session", id: y.getSessionId() },
			held: true,
		});
		const record = recordOf(b, 0);
		assert.deepEqual(record.lastState, { snapshotId: b.id, head: b.head, tree: b.tree });
		assert.equal(record.releasedAt, null);
		assert.equal(record.resetting, undefined);
		assert.equal(existsSync(slot(b, 1)), false);
		const [restore] = latestResumeTimings(prepared.sessionManager)?.restores ?? [];
		assert.equal(restore?.mode, "claimed");
		assert.deepEqual(Object.keys(restore?.phases ?? {}).sort(), ["fetch", "materialize", "reconstruct", "verify"]);
		// The slot keeps the remotes its restore configured, so `git fetch` and `git push` still work there.
		assert.equal(await sandbox.git(root, "remote", "get-url", "origin"), sandbox.path("repo.git"));
	});

	test("the previous owner of a claimed slot restores fresh on its next resume and loses nothing (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		await resume(await sessionOf(clone, b));

		const again = await resume(x);

		assert.equal(again.sessionManager.getCwd(), slot(a, 1));
		assert.equal(readFileSync(join(slot(a, 1), "file.txt"), "utf8"), "A\n");
		assert.equal(readFileSync(join(slot(a, 1), "only-a.txt"), "utf8"), "A only\n");
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "B\n");
		assert.deepEqual(
			latestResumeTimings(again.sessionManager)?.restores.map((restore) => restore.mode),
			["fresh"],
		);
	});

	const fallbacks: [string, (root: string) => void, string][] = [
		["an uncaptured edit", (root) => sandbox.write(join(root, "file.txt"), "uncaptured\n"), "file.txt"],
		["an untracked file", (root) => sandbox.write(join(root, "notes.txt"), "mine\n"), "notes.txt"],
		["a .env no snapshot records", (root) => sandbox.write(join(root, ".env"), "TOKEN=1\n"), ".env"],
	];
	for (const [what, change, file] of fallbacks) {
		test(`a slot holding ${what} is not claimed: the resume restores fresh and the slot keeps it (#4748)`, async () => {
			const { a, b, clone } = await twoSnapshots();
			const x = await idleSlotOfX(a, clone);
			change(slot(a, 0));
			const kept = readFileSync(join(slot(a, 0), file), "utf8");

			assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "dirty" });
			const prepared = await resume(await sessionOf(clone, b));

			assert.equal(prepared.sessionManager.getCwd(), slot(b, 1));
			assert.equal(readFileSync(join(slot(b, 1), "file.txt"), "utf8"), "B\n");
			assert.equal(readFileSync(join(slot(a, 0), file), "utf8"), kept);
			assert.deepEqual(recordOf(a, 0).holder, { kind: "session", id: x.getSessionId() });
		});
	}

	test("a slot its owner holds is busy: the resume restores fresh and leaves it alone (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		const held = await holdRestoredWorktree(storeDir(), slot(a, 0), { kind: "session", id: x.getSessionId() });
		assert.ok(held);
		try {
			assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "busy" });
			const prepared = await resume(await sessionOf(clone, b));

			assert.equal(prepared.sessionManager.getCwd(), slot(b, 1));
			assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "A\n");
		} finally {
			await releaseRestoredWorktree(held);
		}
	});

	test("a reset that fails verification leaves the slot marked; the resume restores fresh and eviction removes it (#4748)", async () => {
		// B stops ignoring build/, so the build output A's slot keeps there becomes an untracked file B never recorded.
		const { a, b, clone } = await twoSnapshots((root) => sandbox.write(join(root, ".gitignore"), "node_modules/\n"));
		await idleSlotOfX(a, clone);
		sandbox.write(join(slot(a, 0), "build", "out.txt"), "built\n");

		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "verify-failed" });
		assert.deepEqual(recordOf(a, 0).resetting, { snapshotId: b.id, head: b.head, tree: b.tree });
		assert.deepEqual(recordOf(a, 0).holder, Y);
		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "dirty" });

		const prepared = await resume(await sessionOf(clone, b), { pool: { maxIdlePerRepository: 5 } });

		assert.equal(prepared.sessionManager.getCwd(), slot(b, 1));
		await verifyWorktree(b, slot(b, 1), { settings });
		assert.equal(existsSync(slot(a, 0)), false);
		assert.equal(existsSync(recordFile(a, 0)), false);
	});

	test("a claim whose snapshot content is missing gives the slot back to its owner untouched (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		const before = recordOf(a, 0);

		// Without the blob storage, B's change set cannot be read, and the store does not hold B's tree.
		assert.deepEqual(await claimIdleWorktree(b, { ...claimOptions(), blobs: undefined }), {
			claimed: false,
			reason: "fetch-failed",
		});

		assert.deepEqual(recordOf(a, 0), before);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), {
			owner: { kind: "session", id: x.getSessionId() },
			held: false,
		});
		assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "A\n");
	});

	test("a claim cancelled during fetch gives its untouched slot back to its previous owner (#5320)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		const before = recordOf(a, 0);
		const controller = new AbortController();
		const cancelled = new Error("cancelled while fetching the claim");
		sandbox.write(join(slot(a, 0), "node_modules", "installed"), "installed\n");
		sandbox.write(join(slot(a, 0), "build", "output"), "built\n");
		const blobs = {
			getBlob: async (hash: string) => {
				controller.abort(cancelled);
				return store.snapshotBlobs.getBlob(hash);
			},
		};

		await assert.rejects(claimIdleWorktree(b, { ...claimOptions(), blobs, signal: controller.signal }), cancelled);

		assert.deepEqual(recordOf(a, 0), before);
		const owner = { kind: "session" as const, id: x.getSessionId() };
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: false });
		const held = await holdRestoredWorktree(storeDir(), slot(a, 0), owner);
		assert.ok(held);
		try {
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: true });
			assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "A\n");
			assert.equal(readFileSync(join(slot(a, 0), "node_modules", "installed"), "utf8"), "installed\n");
			assert.equal(readFileSync(join(slot(a, 0), "build", "output"), "utf8"), "built\n");
		} finally {
			await releaseRestoredWorktree(held);
		}
	});

	test.skipIf(process.platform === "win32")(
		"a claim killed with SIGKILL mid-reset leaves a slot the next claim skips and eviction removes (#4748)",
		async () => {
			const { a, b, clone } = await twoSnapshots();
			const x = await idleSlotOfX(a, clone);
			// The child's Git stops for good right after the reset wrote the slot's files, before HEAD moves.
			const mark = sandbox.path("reset-written");
			const git = sandbox.path("git-wrapper.sh");
			writeFileSync(
				git,
				`#!/bin/sh\nfor arg in "$@"; do\n\tif [ "$arg" = "--no-deref" ]; then : > ${JSON.stringify(mark)}; exec sleep 600; fi\ndone\nexec git "$@"\n`,
			);
			chmodSync(git, 0o755);
			const patches: Record<string, string> = {};
			for (const link of b.chain) {
				if (link.patch === null) continue;
				patches[link.patch] = Buffer.from((await store.snapshotBlobs.getBlob(link.patch))!).toString("base64");
			}
			const script = sandbox.path("claim.ts");
			const module = (path: string) =>
				JSON.stringify(fileURLToPath(new URL(`../src/core/worktree-snapshot/${path}`, import.meta.url)));
			writeFileSync(
				script,
				`import { claimIdleWorktree } from ${module("pool.ts")};
import { withWorktreeSnapshotGit } from ${module("git.ts")};
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from ${module("settings.ts")};
const patches = ${JSON.stringify(patches)};
const blobs = { getBlob: async (hash) => patches[hash] === undefined ? undefined : new Uint8Array(Buffer.from(patches[hash], "base64")) };
const env = { ...${JSON.stringify(sandbox.executable.env)}, PATH: process.env.PATH };
await withWorktreeSnapshotGit({ path: ${JSON.stringify(git)}, env }, () =>
	claimIdleWorktree(${JSON.stringify(b)}, { storeDir: ${JSON.stringify(storeDir())}, owner: { kind: "session", id: "killed" }, settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS, blobs }),
);
`,
			);
			const child = spawn(bunExecutable(), [script], { stdio: ["ignore", "inherit", "inherit"] });
			const exited = new Promise((resolve) => child.once("exit", resolve));
			try {
				while (!existsSync(mark)) {
					assert.equal(child.exitCode, null, "the claim ended before it reset the slot");
					await sleep(20);
				}
			} finally {
				child.kill("SIGKILL");
				await exited;
			}
			assert.equal(readFileSync(join(slot(a, 0), "file.txt"), "utf8"), "B\n");
			assert.deepEqual(recordOf(a, 0).resetting, { snapshotId: b.id, head: b.head, tree: b.tree });
			assert.deepEqual(recordOf(a, 0).holder, { kind: "session", id: "killed" });
			// Nothing refreshes the killed process's lease: once older than the stale time, the slot is idle.
			const pool = join(storeDir(), "pool", repositoryIdOf(a.remotes));
			const past = new Date(Date.now() - 120_000);
			for (const name of readdirSync(pool).filter((entry) => entry.endsWith(".lock"))) {
				utimesSync(join(pool, name), past, past);
			}

			assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "dirty" });
			// The previous owner restores fresh, as its slot belongs to the killed claim; eviction removes that slot.
			const again = await resume(x);
			assert.equal(again.sessionManager.getCwd(), slot(a, 1));
			assert.equal(readFileSync(join(slot(a, 1), "only-a.txt"), "utf8"), "A only\n");
			assert.equal(existsSync(slot(a, 0)), false);
			assert.equal(existsSync(recordFile(a, 0)), false);
		},
		CHILD_PROCESS_TIMEOUT_MS,
	);

	// Spec S5's saving, compared by the work each resume does rather than by wall time, which load skews.
	test(
		"a resume that claims the slot an install filled skips the install a fresh one runs (#4748)",
		async () => {
			const { a, b, clone } = await twoSnapshots();
			// POSIX paths: the step runs in bash on every platform, where a backslash would escape the next character.
			const installed = "node_modules/.installed";
			const installs = sandbox.path("installs.log").replace(/\\/g, "/");
			const blueprints = {
				blueprints: "build" as const,
				blueprint: {
					agentDir: sandbox.path("agent"),
					setupCommand: `test -f ${installed} || { echo install >> ${JSON.stringify(installs)}; mkdir -p node_modules && : > ${installed}; }`,
					trusted: () => true,
				},
			};
			const restoreOf = async (snapshot: WorktreeSnapshot) => {
				const prepared = await resume(await sessionOf(clone, snapshot), blueprints);
				assert.equal(prepared.sessionManager.getCwd(), slot(a, 0));
				const [restore] = latestResumeTimings(prepared.sessionManager)?.restores ?? [];
				await releaseSessionWorktrees(prepared.sessionManager);
				return { mode: restore?.mode, installs: readFileSync(sandbox.path("installs.log"), "utf8") };
			};

			assert.deepEqual(await restoreOf(a), { mode: "fresh", installs: "install\n" });
			// Alternating snapshots, so each claim resets the slot to a different state.
			for (const snapshot of [b, a, b])
				assert.deepEqual(await restoreOf(snapshot), { mode: "claimed", installs: "install\n" }, snapshot.id);
		},
		FOUR_RESUMES_TIMEOUT_MS,
	);
});

describe("what pool actions leave in the pool directory (#4991)", () => {
	/** The pool directory of `snapshot`'s repository holds slot records and live leases, never a private file left over. */
	function assertOnlyRecordsAndLeases(snapshot: WorktreeSnapshot): void {
		const pool = join(storeDir(), "pool", repositoryIdOf(snapshot.remotes));
		const leftovers = readdirSync(pool).filter((name) => !/^\d+\.json(?:\.[0-9a-f-]+\.lease\.lock)?$/.test(name));
		assert.deepEqual(leftovers, []);
	}

	test("a hold, a release, a claim and an eviction leave no taken record, temporary file or lock token behind (#4991)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await idleSlotOfX(a, clone);
		assertOnlyRecordsAndLeases(a);

		const held = await holdRestoredWorktree(storeDir(), slot(a, 0), { kind: "session", id: x.getSessionId() });
		assert.ok(held);
		assertOnlyRecordsAndLeases(a);
		assert.equal(await releaseRestoredWorktree(held), true);
		assertOnlyRecordsAndLeases(a);

		const claim = await claimIdleWorktree(b, claimOptions());
		assert.equal(claim.claimed, true);
		assertOnlyRecordsAndLeases(a);
		if (claim.claimed) await releaseRestoredWorktree(claim.lease);
		assertOnlyRecordsAndLeases(a);

		assert.deepEqual(await evictIdleWorktrees(storeDir(), repositoryIdOf(a.remotes), { maxIdle: 0, settings }), [
			slot(a, 0),
		]);
		assertOnlyRecordsAndLeases(a);
		assert.deepEqual(
			readdirSync(join(storeDir(), "worktrees")).filter((name) => name.startsWith(`${repositoryIdOf(a.remotes)}-`)),
			[],
		);
	});
});
