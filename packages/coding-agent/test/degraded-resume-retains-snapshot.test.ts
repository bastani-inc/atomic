import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test, vi } from "vitest";
import { renameReplacing } from "../src/core/rename-retry.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	DEGRADED_RESTORE_RETENTION_DAYS,
	degradedRestorePin,
	describeWorktreeRestoreStatus,
	discardDegradedRestore,
} from "../src/core/session-worktree-snapshots.js";
import { type SqlSnapshotBlobStore, snapshotBlobHashes } from "../src/core/worktree-snapshot/blob-store.js";
import { collectSnapshotGarbage } from "../src/core/worktree-snapshot/garbage.js";
import { prepareSessionResume } from "../src/index.js";
import {
	ready,
	runTurn,
	degradedResumeSettings as settings,
	snapshotEntries,
	useDegradedResumeFixture,
} from "./degraded-resume-retains-snapshot-helpers.js";

const fixture = useDegradedResumeFixture();
const { cleanups, sqlStore, options, machineA, degradedTurnOnB } = fixture;

describe("a degraded resume keeps the snapshot it could not restore fully (#4922)", () => {
	test("after a turn on the degraded machine and a collection, a later resume restores the pushed commit plus work.txt (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);

		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.snapshotId, a.snapshot.id);
		assert.equal(c.degraded, undefined);
		assert.equal(c.degradedWork, undefined, "the partly restored worktree recorded no work of its own");
		assert.equal(await fixture.sandbox.git(c.to, "rev-parse", "HEAD"), a.unpushed);
		assert.equal(readFileSync(join(c.to, "work.txt"), "utf8"), "uncommitted work\n");
	});

	test("collection never deletes the snapshot's content while its degraded restore stands (#4922)", async () => {
		const a = await machineA();
		const { onB } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		await runTurn(onB.sessionManager, onB.sessionManager.getWorktreeRootMappings().at(-1)!.to);
		await collectSnapshotGarbage(onB.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });

		const stored = new Set(await onB.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		for (const hash of snapshotBlobHashes(a.snapshot)) assert.ok(stored.has(hash), `blob ${hash} was collected`);
	});

	test("a resume that still cannot reach the snapshot continues from the partly restored worktree's work, keeping the pin (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const work = snapshotEntries(onB.sessionManager).at(-1)!;
		assert.equal(work.degradedFrom, a.snapshot.id);

		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.snapshotId, work.snapshotId);
		assert.equal(c.degradedWork, undefined);
		assert.equal(readFileSync(join(c.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.ok(onC.notices.every((notice) => !notice.message.includes("is no longer kept")));
		assert.equal(snapshotEntries(onC.sessionManager).at(-1)?.degradedFrom, a.snapshot.id);
		assert.ok(onC.notices.some((notice) => notice.message.includes("still cannot be restored here")));
		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		const stored = new Set(await onC.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		for (const hash of snapshotBlobHashes(a.snapshot)) assert.ok(stored.has(hash), `blob ${hash} was collected`);

		// Once the commit is pushed, the next resume restores the snapshot with the work on top.
		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(onC.sessionManager, options("machine-d")));
		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, a.snapshot.id);
		assert.equal(readFileSync(join(d.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(readFileSync(join(d.to, "from-b.txt"), "utf8"), "done on machine B\n");
	});

	test("discardDegradedRestore records the partly restored worktree and releases the snapshot (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		fixture.sandbox.write(join(b.to, "kept.txt"), "kept on machine B\n");

		assert.deepEqual(
			await discardDegradedRestore(onB.sessionManager, { settings, root: fixture.sandbox.path("other") }),
			[],
		);
		assert.deepEqual(
			await discardDegradedRestore(onB.sessionManager, { settings: { ...settings, enabled: false } }),
			[],
		);
		assert.ok(describeWorktreeRestoreStatus(onB.sessionManager, b.to), "the partial restore is still reported");
		assert.deepEqual(await discardDegradedRestore(onB.sessionManager, { settings, root: b.to }), [b.to]);
		const discarded = snapshotEntries(onB.sessionManager).at(-1)!;
		assert.equal(discarded.degradedFrom, undefined);
		assert.equal(describeWorktreeRestoreStatus(onB.sessionManager, b.to), undefined);
		assert.ok(discarded.snapshot !== undefined, "the worktree's changed state is recorded");
		await collectSnapshotGarbage(onB.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });

		const stored = new Set(await onB.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		assert.ok(snapshotBlobHashes(a.snapshot).every((hash) => !stored.has(hash)));
		assert.ok(snapshotBlobHashes(discarded.snapshot!).every((hash) => stored.has(hash)));
		await runTurn(onB.sessionManager, b.to);
		assert.equal(snapshotEntries(onB.sessionManager).at(-1)?.degradedFrom, undefined);
		assert.deepEqual(await discardDegradedRestore(onB.sessionManager, { settings }), []);
	});

	test(`the pin lapses ${DEGRADED_RESTORE_RETENTION_DAYS} days after the partial restore, with a notice, and collection releases the snapshot (#4922)`, async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		const blobs = onB.sessionManager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		const { database } = blobs as unknown as {
			readonly database: { run(sql: string, ...params: unknown[]): Promise<unknown> };
		};

		// Collection counts the days on the database clock: a minute short of them keeps the snapshot.
		await database.run(
			"UPDATE snapshot_session_refs SET degraded_since = degraded_since - ? WHERE degraded_from IS NOT NULL",
			DEGRADED_RESTORE_RETENTION_DAYS * 24 * 60 * 60 - 60,
		);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const inside = new Set(await blobs.listBlobHashes());
		assert.ok(snapshotBlobHashes(a.snapshot).every((hash) => inside.has(hash)));
		await database.run(
			"UPDATE snapshot_session_refs SET degraded_since = degraded_since - ? WHERE degraded_from IS NOT NULL",
			61,
		);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const stored = new Set(await blobs.listBlobHashes());
		assert.ok(snapshotBlobHashes(a.snapshot).every((hash) => !stored.has(hash)));

		// Resume and capture count them on this machine's clock, from the partial restore.
		const pin = degradedRestorePin(onB.sessionManager, b.to)!;
		const work = snapshotEntries(onB.sessionManager).at(-1)!.snapshotId;
		vi.useFakeTimers({
			toFake: ["Date"],
			now: Date.parse(pin.since) + (DEGRADED_RESTORE_RETENTION_DAYS - 1) * 24 * 60 * 60 * 1000,
		});
		assert.equal(
			degradedRestorePin(onB.sessionManager, b.to)?.snapshotId,
			a.snapshot.id,
			"the pin stands a day short",
		);
		vi.useFakeTimers({
			toFake: ["Date"],
			now: Date.now() + (DEGRADED_RESTORE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
		});
		cleanups.push(() => vi.useRealTimers());
		const again = ready(await prepareSessionResume(onB.sessionManager, options("machine-b")));
		const lapsed = again.notices.find((notice) => notice.message.includes("is no longer kept"));
		assert.equal(lapsed?.type, "warning");
		assert.ok(lapsed?.message.includes(pin.since.slice(0, 10)));
		assert.ok(lapsed?.message.includes(`from snapshot ${work.slice(0, 12)}`));
		assert.equal(degradedRestorePin(again.sessionManager, b.to), undefined);
		assert.equal(again.sessionManager.getCwd(), b.to);
		await runTurn(again.sessionManager, b.to);
		assert.equal(snapshotEntries(again.sessionManager).at(-1)?.degradedFrom, undefined);
	});

	test("a resume and collection with no partial restore record and keep what they did before (#4922)", async () => {
		const { clone } = await fixture.sandbox.remoteWithClone("plain", { "README.md": "hello\n" });
		fixture.sandbox.write(join(clone, "work.txt"), "uncommitted work\n");
		const store = await sqlStore();
		const manager = await SessionManager.create(store, clone);
		await runTurn(manager, clone);
		fixture.sandbox.write(join(clone, "work.txt"), "more work\n");
		await runTurn(manager, clone);
		const second = snapshotEntries(manager).at(-1)!;
		await collectSnapshotGarbage(store.snapshotBlobs, { graceSeconds: 0 });

		const stored = new Set(await store.snapshotBlobs!.listBlobHashes());
		assert.ok(snapshotBlobHashes(second.snapshot!).every((hash) => stored.has(hash)));
		renameReplacing(clone, fixture.sandbox.path("plain-elsewhere"));
		const resumed = ready(await prepareSessionResume(manager, options("machine-b")));
		const restored = resumed.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(restored.snapshotId, second.snapshotId);
		assert.equal(restored.degradedWork, undefined);
		assert.equal(readFileSync(join(restored.to, "work.txt"), "utf8"), "more work\n");
		assert.ok(snapshotEntries(resumed.sessionManager).every((entry) => entry.degradedFrom === undefined));
	});

	test("a later resume on the degraded machine restores the snapshot fully once it can, when the worktree holds nothing new (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);

		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		const again = ready(await prepareSessionResume(onB.sessionManager, options("machine-b")));

		const restored = again.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.notEqual(restored.to, b.to);
		assert.equal(restored.snapshotId, a.snapshot.id);
		assert.equal(restored.degraded, undefined);
		assert.equal(readFileSync(join(restored.to, "work.txt"), "utf8"), "uncommitted work\n");
	});

	test("a resume that can restore nothing keeps the pin and the work done in the partly restored worktree (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const work = snapshotEntries(onB.sessionManager).at(-1)!;
		rmSync(b.to, { recursive: true, force: true });
		renameReplacing(fixture.sandbox.path("repo.git"), fixture.sandbox.path("remote-gone"));

		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const left = snapshotEntries(onC.sessionManager).at(-1)!;
		assert.ok(left.unrestored !== undefined, JSON.stringify(left));
		assert.equal(left.snapshotId, work.snapshotId);
		assert.equal(left.degradedFrom, a.snapshot.id);
		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		const stored = new Set(await onC.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		for (const hash of [...snapshotBlobHashes(a.snapshot), ...snapshotBlobHashes(work.snapshot!)])
			assert.ok(stored.has(hash), `blob ${hash} was collected`);
	});

	test("a snapshot entry names in degradedFrom only another snapshot the session recorded (#4922)", async () => {
		const a = await machineA();
		const other = "0123456789abcdef0123456789abcdef";
		await assert.rejects(
			a.manager.appendWorktreeSnapshot(
				a.clone,
				a.snapshot.id,
				undefined,
				undefined,
				[],
				undefined,
				undefined,
				a.snapshot.id,
			),
			/degradedFrom/,
		);
		await assert.rejects(
			a.manager.appendWorktreeSnapshot(
				a.clone,
				a.snapshot.id,
				undefined,
				undefined,
				[],
				undefined,
				undefined,
				other,
			),
			/degradedFrom/,
		);
		const { onB } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		const reopened = await SessionManager.open(
			onB.sessionManager.getSessionStore(),
			onB.sessionManager.getSessionId(),
		);
		assert.equal(snapshotEntries(reopened).at(-1)?.degradedFrom, a.snapshot.id, "the pin is stored with the entry");
	});

	test("a resume on the degraded machine continues in the worktree the session worked in, as it is (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const mappings = onB.sessionManager.getWorktreeRootMappings().length;

		const again = ready(await prepareSessionResume(onB.sessionManager, options("machine-b")));

		assert.equal(again.sessionManager.getCwd(), b.to);
		assert.equal(again.sessionManager.getWorktreeRootMappings().length, mappings);
		assert.deepEqual(
			again.notices.filter((notice) => notice.type === "warning"),
			[],
		);
		assert.equal(readFileSync(join(b.to, "from-b.txt"), "utf8"), "done on machine B\n");
	});

	test("discardDegradedRestore reports a worktree it cannot record (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed);
		rmSync(b.to, { recursive: true, force: true });
		await assert.rejects(discardDegradedRestore(onB.sessionManager, { settings }), /not-a-repository|repository/);
	});
});
