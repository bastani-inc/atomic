import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import { sleep } from "../../../test/helpers/runtime.js";
import { renameWithRetry } from "../src/core/rename-retry.ts";
import { SessionManager } from "../src/core/session-manager.js";
import {
	openSessionInWorktree,
	releaseSessionWorktrees,
	resumeSessionWorktree,
} from "../src/core/session-worktree-snapshots.js";
import {
	claimIdleWorktree,
	evictIdleWorktrees,
	holdRestoredWorktree,
	pooledWorktreeHolder,
	releaseRestoredWorktree,
	repositoryIdOf,
} from "../src/core/worktree-snapshot/pool.js";
import { removeRestoredWorktree } from "../src/core/worktree-snapshot/restore.js";
import {
	capture,
	claimOptions,
	idleSlotOfX,
	opened,
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

describe("tracked files snapshots omit (#4897)", () => {
	/**
	 * Two snapshots of a checkout that tracks files snapshots leave out: `.env.example` on the deny list, `private/notes.txt`
	 * under `.atomic/snapshot-ignore`, and `big.dat`, whose edit below goes over the size cap. A and B both edit the
	 * tracked `README.md` differently, so each records a tracked change. Session X then restores A into slot 0 and
	 * releases it.
	 */
	async function idleSlotWithOmittedFiles() {
		const { clone } = await sandbox.remoteWithClone("omitting", {
			".gitignore": "node_modules/\n",
			".atomic/snapshot-ignore": "private/\n",
			".env.example": "TOKEN=placeholder\n",
			"private/notes.txt": "committed notes\n",
			"big.dat": "small\n",
			"README.md": "hello\n",
		});
		sandbox.write(join(clone, "README.md"), "A\n");
		const a = await capture(clone);
		sandbox.write(join(clone, "README.md"), "B\n");
		const b = await capture(clone);
		await renameWithRetry(clone, sandbox.path("omitting-away"));
		const x = await idleSlotOfX(a, clone);
		return { a, b, x };
	}

	const omittedEdits: [string, string, () => string][] = [
		["a deny-listed .env.example", ".env.example", () => "TOKEN=edited\n"],
		["a file under .atomic/snapshot-ignore", "private/notes.txt", () => "edited notes\n"],
		["a file over the size cap", "big.dat", () => "x".repeat(settings.maxFileBytes + 1)],
	];
	for (const [what, file, content] of omittedEdits) {
		test(`a slot with an edit to ${what} that it tracks is not claimed and keeps the edit (#4897)`, async () => {
			const { a, b, x } = await idleSlotWithOmittedFiles();
			const edited = content();
			sandbox.write(join(slot(a, 0), file), edited);

			assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "dirty" });

			assert.equal(readFileSync(join(slot(a, 0), file), "utf8"), edited);
			assert.equal(readFileSync(join(slot(a, 0), "README.md"), "utf8"), "A\n");
			assert.deepEqual(recordOf(a, 0).holder, { kind: "session", id: x.getSessionId() });
		});

		test(`a slot with an edit to ${what} that it tracks is never evicted (#4897)`, async () => {
			const { a } = await idleSlotWithOmittedFiles();
			const edited = content();
			sandbox.write(join(slot(a, 0), file), edited);

			const removed = await evictIdleWorktrees(storeDir(), repositoryIdOf(a.remotes), { maxIdle: 0, settings });

			assert.deepEqual(removed, []);
			assert.equal(readFileSync(join(slot(a, 0), file), "utf8"), edited);
			assert.equal(existsSync(recordFile(a, 0)), true);
		});
	}

	test("a slot whose omitted tracked files are unchanged is still claimed, and evicted when idle (#4897)", async () => {
		const { a, b } = await idleSlotWithOmittedFiles();

		const claim = await claimIdleWorktree(b, claimOptions());

		assert.equal(claim.claimed && claim.lease.path, slot(a, 0));
		if (claim.claimed) await releaseRestoredWorktree(claim.lease);
		assert.equal(readFileSync(join(slot(a, 0), "README.md"), "utf8"), "B\n");
		assert.equal(readFileSync(join(slot(a, 0), ".env.example"), "utf8"), "TOKEN=placeholder\n");
		assert.deepEqual(await evictIdleWorktrees(storeDir(), repositoryIdOf(a.remotes), { maxIdle: 0, settings }), [
			slot(a, 0),
		]);
		assert.equal(existsSync(slot(a, 0)), false);
	});
});

describe("pooled resume edges (#4748)", () => {
	test("a pooled resume that continues in its own idle slot holds it, so no claim can take it meanwhile (#4748)", async () => {
		const { a, b, clone } = await twoSnapshots();
		const x = await sessionOf(clone, a);
		opened.push(x);
		const pool = { settings, storeDir: storeDir(), pool: { maxIdlePerRepository: 2 } };
		assert.equal(await resumeSessionWorktree(x, pool).then((result) => result.status), "restored");
		await releaseSessionWorktrees(x);
		const owner = { kind: "session" as const, id: x.getSessionId() };

		assert.equal((await resumeSessionWorktree(x, pool)).status, "verified");

		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: true });
		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "busy" });
		await releaseSessionWorktrees(x);

		const continued = await openSessionInWorktree(x, pool);
		opened.push(continued.sessionManager);
		assert.equal(continued.sessionManager.getCwd(), slot(a, 0));
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: true });
		await releaseSessionWorktrees(x);
		assert.deepEqual(await claimIdleWorktree(b, claimOptions()), { claimed: false, reason: "busy" });
		await releaseSessionWorktrees(continued.sessionManager);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), { owner, held: false });
	});

	test("a resume without pool settings keeps two idle slots by default (#4748)", async () => {
		const { a, clone } = await twoSnapshots();
		const sessions: SessionManager[] = [];
		for (let n = 0; n < 4; n++) sessions.push((await resume(await sessionOf(clone, a))).sessionManager);
		assert.deepEqual(
			sessions.map((session) => session.getCwd()),
			[0, 1, 2, 3].map((n) => slot(a, n)),
		);
		// Released newest slot first, so slot 0 is the most recently released and slot 3 the oldest.
		for (const session of [...sessions].reverse()) {
			await releaseSessionWorktrees(session);
			await sleep(5);
		}

		const fifth = await resume(await sessionOf(clone, a));

		assert.equal(fifth.sessionManager.getCwd(), slot(a, 0));
		assert.equal(existsSync(slot(a, 3)), false);
		assert.equal(existsSync(slot(a, 1)), true);
		assert.equal(existsSync(slot(a, 2)), true);
	});

	test("only a pooled restore treats a slot another session holds as gone; its owner's own slot verifies (#4748)", async () => {
		const { a, clone } = await twoSnapshots();
		const x = await sessionOf(clone, a);
		opened.push(x);
		const pool = { settings, storeDir: storeDir(), pool: { maxIdlePerRepository: 2 } };
		const first = await resumeSessionWorktree(x, pool);
		assert.equal(first.status === "restored" && first.mappings[0]?.to, slot(a, 0));
		assert.equal((await resumeSessionWorktree(x, pool)).status, "verified");
		await releaseSessionWorktrees(x);
		// An unpooled resume, as for workflow runs, compares the slot without holding it.
		assert.equal((await resumeSessionWorktree(x, { settings, storeDir: storeDir() })).status, "verified");
		opened.push((await openSessionInWorktree(x, { settings, storeDir: storeDir() })).sessionManager);
		assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot(a, 0)), {
			owner: { kind: "session", id: x.getSessionId() },
			held: false,
		});
		writeFileSync(recordFile(a, 0), JSON.stringify({ ...recordOf(a, 0), holder: Y }));
		const held = await holdRestoredWorktree(storeDir(), slot(a, 0), Y);
		assert.ok(held);
		try {
			assert.equal((await resumeSessionWorktree(x, { settings, storeDir: storeDir() })).status, "verified");
			const pooled = await resumeSessionWorktree(x, pool);
			assert.equal(pooled.status === "restored" && pooled.mappings[0]?.to, slot(a, 1));
		} finally {
			await releaseRestoredWorktree(held);
		}
	});

	test("a resume that reuses the launch checkout keeps a changed sibling slot the session owns (#4748)", async () => {
		const { clone: main } = await sandbox.remoteWithClone("main");
		const { clone: sibling } = await sandbox.remoteWithClone("sibling");
		const x = await SessionManager.create(store, main);
		for (const root of [main, sibling]) {
			sandbox.write(join(root, "file.txt"), `${root}\n`);
			const snapshot = await capture(root);
			await x.appendWorktreeSnapshot(root, snapshot.id, snapshot);
		}
		const launch = sandbox.path("launch");
		cpSync(main, launch, { recursive: true });
		await renameWithRetry(main, sandbox.path("main-away"));
		await renameWithRetry(sibling, sandbox.path("sibling-away"));
		const first = await resume(x);
		const mainSlot = first.sessionManager.getCwd();
		const siblingSlot = first.sessionManager
			.getWorktreeRootMappings()
			.find((mapping) => mapping.from === sibling)!.to;
		await releaseSessionWorktrees(first.sessionManager);
		opened.pop();
		await removeRestoredWorktree(mainSlot, { storeDir: storeDir() });
		sandbox.write(join(siblingSlot, "file.txt"), "uncaptured sibling work\n");

		const again = await resume(first.sessionManager, { launchCwd: launch });

		assert.equal(again.sessionManager.getCwd(), launch);
		assert.equal(readFileSync(join(siblingSlot, "file.txt"), "utf8"), "uncaptured sibling work\n");
		assert.ok(
			again.notices.some(
				(notice) =>
					notice.message.includes(siblingSlot) && notice.message.includes("the session worked in it on this node"),
			),
			JSON.stringify(again.notices),
		);
	});
});
