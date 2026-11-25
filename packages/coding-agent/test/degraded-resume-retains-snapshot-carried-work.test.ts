import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test, vi } from "vitest";
import { renameReplacing } from "../src/core/rename-retry.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
	degradedRestorePin,
	discardDegradedRestore,
	formatDegradedWorkNotice,
} from "../src/core/session-worktree-snapshots.js";
import { type SqlSnapshotBlobStore, snapshotBlobHashes } from "../src/core/worktree-snapshot/blob-store.js";
import { carryOverDegradedWork } from "../src/core/worktree-snapshot/degraded-work.js";
import { collectSnapshotGarbage } from "../src/core/worktree-snapshot/garbage.js";
import { setWorktreeSnapshotGit } from "../src/core/worktree-snapshot/git.js";
import { prepareSessionResume } from "../src/index.js";
import {
	ready,
	runTurn,
	degradedResumeSettings as settings,
	snapshotEntries,
	useDegradedResumeFixture,
} from "./degraded-resume-retains-snapshot-helpers.js";

const fixture = useDegradedResumeFixture();
const { options, machineA, degradedTurnOnB } = fixture;

describe("a degraded resume keeps the snapshot it could not restore fully (#4922)", () => {
	test("work done in the partly restored worktree is applied on top of the full restore, and recorded (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);

		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.snapshotId, a.snapshot.id);
		assert.equal(c.degradedWork?.outcome, "applied");
		assert.deepEqual(c.degradedWork?.paths, ["from-b.txt"]);
		assert.equal(readFileSync(join(c.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(readFileSync(join(c.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.ok(
			onC.notices.some(
				(notice) => notice.type === "info" && notice.message.startsWith("Also applied the work done"),
			),
		);
		assert.ok(onC.notices.some((notice) => notice.message.includes("(from-b.txt)")));
		assert.ok(
			!onC.notices.some(
				(notice) => notice.message.includes("not recorded yet") || notice.message.includes("restored only partly"),
			),
			"recorded at once, the carried-over work needs no warning (#5009)",
		);
		const recorded = onC.sessionManager.getLatestWorktreeSnapshots().get(c.to)!;
		assert.notEqual(recorded.id, a.snapshot.id, "the merged worktree is recorded at once");
		const stored = new Set(await onC.sessionManager.getSessionStore().snapshotBlobs!.listBlobHashes());
		assert.ok(snapshotBlobHashes(recorded).every((hash) => stored.has(hash)));
		assert.equal(snapshotEntries(onC.sessionManager).at(-1)?.degradedFrom, undefined);
	});

	test("work that conflicts with the full restore is left out and kept as a commit (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "work.txt"), "a different work.txt on machine B\n"),
		);

		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));

		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.degradedWork?.outcome, "kept");
		assert.equal(readFileSync(join(c.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(await fixture.sandbox.git(c.to, "rev-parse", c.degradedWork!.ref!), c.degradedWork!.commit);
		assert.equal(
			await fixture.sandbox.git(c.to, "show", `${c.degradedWork!.commit}:work.txt`),
			"a different work.txt on machine B",
		);
		assert.ok(c.degradedWork!.ref!.startsWith("refs/atomic/degraded-work/"));
		const warning = onC.notices.find(
			(notice) => notice.type === "warning" && notice.message.startsWith("Did not apply"),
		);
		assert.ok(warning?.message.includes(`git diff ${c.degradedWork!.base} ${c.degradedWork!.commit}`));
		assert.ok(warning?.message.includes(`Commit ${c.degradedWork!.commit!.slice(0, 12)} `));
	});

	test("work that cannot be read on this machine is reported, and nothing is applied (#4922)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		const work = snapshotEntries(onB.sessionManager).at(-1)!.snapshot!;
		const blobs = onB.sessionManager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;
		const unreadable = await carryOverDegradedWork({
			worktree: b.to,
			work: { ...work, chain: [{ ...work.chain[0]!, patch: "f".repeat(64) }] },
			base: "0".repeat(40),
			blobs,
			storeDir: fixture.sandbox.path("machine-b"),
		});
		assert.equal(unreadable.outcome, "unavailable");
		assert.deepEqual(unreadable.paths, []);
		assert.match(unreadable.reason ?? "", /./);
		const unknownBase = await carryOverDegradedWork({
			worktree: b.to,
			work,
			base: "0".repeat(40),
			blobs,
			storeDir: fixture.sandbox.path("machine-b"),
		});
		assert.deepEqual([unknownBase.outcome, unknownBase.paths], ["unavailable", []]);
		assert.match(unknownBase.reason ?? "", /is not here/);
		const noBase = await carryOverDegradedWork({ worktree: b.to, work, base: undefined, blobs });
		assert.deepEqual([noBase.outcome, noBase.paths], ["unavailable", []]);
		assert.match(noBase.reason ?? "", /no record of the partial restore/);
		assert.equal(readFileSync(join(b.to, "from-b.txt"), "utf8"), "done on machine B\n");
		const notice = formatDegradedWorkNotice(onB.sessionManager.getWorktreeRootMappings().at(-1)!, noBase);
		assert.match(notice, /^Could not read the work done in the partly restored worktree /);
		assert.ok(notice.includes("(the session holds no record of the partial restore)"));
	});
});

async function withCarriedWorkCaptureFailing<T>(resume: () => Promise<T>): Promise<{ result: T; failed: boolean }> {
	const append = SessionManager.prototype.appendWorktreeSnapshot;
	let armed = false;
	let failed = false;
	const spy = vi.spyOn(SessionManager.prototype, "appendWorktreeSnapshot").mockImplementation(async function (
		this: SessionManager,
		...args
	) {
		const id = await append.apply(this, args);
		if (!failed && args[3]?.degradedWork?.outcome === "applied") armed = true;
		return id;
	});
	const git = fixture.sandbox.executable;
	const previous = setWorktreeSnapshotGit(async () => {
		if (!armed) return git;
		armed = false;
		failed = true;
		return { path: fixture.sandbox.path("no-git"), env: {} };
	});
	try {
		return { result: await resume(), failed };
	} finally {
		setWorktreeSnapshotGit(previous);
		spy.mockRestore();
	}
}

describe("the pin ends only once the carried-over work is recorded (#5009)", () => {
	test("a capture failing after the replay keeps the work: after a collection, another machine restores from-b.txt (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });

		const { result: onC, failed } = await withCarriedWorkCaptureFailing(async () =>
			ready(await prepareSessionResume(onB.sessionManager, options("machine-c"))),
		);
		assert.equal(failed, true, "the capture of the merged state failed");
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.degradedWork?.outcome, "applied");
		assert.equal(readFileSync(join(c.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.ok(
			onC.notices.some((notice) => notice.type === "warning" && notice.message.includes("not recorded yet")),
			"the unrecorded carried-over work is reported",
		);

		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(onC.sessionManager, options("machine-d")));

		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, a.snapshot.id);
		assert.equal(d.degradedWork?.outcome, "applied");
		assert.equal(readFileSync(join(d.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(readFileSync(join(d.to, "from-b.txt"), "utf8"), "done on machine B\n");
		assert.equal(snapshotEntries(onD.sessionManager).at(-1)?.degradedFrom, undefined, "now recorded, the pin ends");
		assert.equal(degradedRestorePin(onD.sessionManager, d.to), undefined);
	});

	test("after a failed capture, the next resume on the same machine records the merged worktree and ends the pin (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const { result: onC } = await withCarriedWorkCaptureFailing(async () =>
			ready(await prepareSessionResume(onB.sessionManager, options("machine-c"))),
		);
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.notEqual(degradedRestorePin(onC.sessionManager, c.to), undefined, "the pin stands until it is recorded");
		const mappings = onC.sessionManager.getWorktreeRootMappings().length;

		const again = ready(await prepareSessionResume(onC.sessionManager, options("machine-c")));

		assert.equal(again.sessionManager.getWorktreeRootMappings().length, mappings, "no new restore");
		assert.equal(degradedRestorePin(again.sessionManager, c.to), undefined);
		const recorded = again.sessionManager.getLatestWorktreeSnapshots().get(c.to)!;
		assert.notEqual(recorded.id, a.snapshot.id);
		await collectSnapshotGarbage(again.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(again.sessionManager, options("machine-d")));
		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, recorded.id);
		assert.equal(readFileSync(join(d.to, "from-b.txt"), "utf8"), "done on machine B\n");
	});

	test("after a failed capture, the next turn records the merged worktree and ends the pin (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "from-b.txt"), "done on machine B\n"),
		);
		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const { result: onC } = await withCarriedWorkCaptureFailing(async () =>
			ready(await prepareSessionResume(onB.sessionManager, options("machine-c"))),
		);
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;

		await runTurn(onC.sessionManager, c.to);

		assert.equal(snapshotEntries(onC.sessionManager).at(-1)?.degradedFrom, undefined);
		assert.equal(degradedRestorePin(onC.sessionManager, c.to), undefined);
	});

	test("conflicting carried-over work stays recoverable on another machine after a collection (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "work.txt"), "a different work.txt on machine B\n"),
		);
		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(c.degradedWork?.outcome, "kept");
		assert.ok(
			onC.notices.some((notice) => notice.message.includes("discardDegradedRestore")),
			"the notice says how long the kept work stays",
		);

		await collectSnapshotGarbage(onC.sessionManager.getSessionStore().snapshotBlobs, { graceSeconds: 0 });
		rmSync(c.to, { recursive: true, force: true });
		const onD = ready(await prepareSessionResume(onC.sessionManager, options("machine-d")));

		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(readFileSync(join(d.to, "work.txt"), "utf8"), "uncommitted work\n");
		assert.equal(d.degradedWork?.outcome, "kept");
		assert.ok(!onD.notices.some((notice) => notice.message.includes("restored only partly")));
		assert.equal(
			await fixture.sandbox.git(d.to, "show", `${d.degradedWork!.ref!}:work.txt`),
			"a different work.txt on machine B",
		);
	});

	test("kept work stays across later turns until discardDegradedRestore releases it (#5009)", async () => {
		const a = await machineA();
		const { onB, b } = await degradedTurnOnB(a.manager, a.snapshot, a.pushed, (worktree) =>
			fixture.sandbox.write(join(worktree, "work.txt"), "a different work.txt on machine B\n"),
		);
		const work = onB.sessionManager.getLatestWorktreeSnapshots().get(b.to)!;
		await fixture.sandbox.git(a.clone, "push", "-q", "origin", "HEAD:main");
		rmSync(b.to, { recursive: true, force: true });
		const onC = ready(await prepareSessionResume(onB.sessionManager, options("machine-c")));
		const c = onC.sessionManager.getWorktreeRootMappings().at(-1)!;
		fixture.sandbox.write(join(c.to, "from-c.txt"), "done on machine C\n");
		await runTurn(onC.sessionManager, c.to);
		const blobs = onC.sessionManager.getSessionStore().snapshotBlobs as SqlSnapshotBlobStore;

		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const kept = new Set(await blobs.listBlobHashes());
		assert.ok(
			snapshotBlobHashes(work).every((hash) => kept.has(hash)),
			"the kept work's content stays",
		);
		const latest = onC.sessionManager.getLatestWorktreeSnapshots().get(c.to)!;
		rmSync(c.to, { recursive: true, force: true });
		renameReplacing(fixture.sandbox.path("repo.git"), fixture.sandbox.path("remote-gone"));
		const onE = ready(await prepareSessionResume(onC.sessionManager, options("machine-e")));
		const left = snapshotEntries(onE.sessionManager).at(-1)!;
		assert.ok(left.unrestored !== undefined);
		assert.equal(left.degradedFrom, work.id);
		renameReplacing(fixture.sandbox.path("remote-gone"), fixture.sandbox.path("repo.git"));
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const stillKept = new Set(await blobs.listBlobHashes());
		assert.ok(snapshotBlobHashes(work).every((hash) => stillKept.has(hash)));

		const onD = ready(await prepareSessionResume(onE.sessionManager, options("machine-d")));
		const d = onD.sessionManager.getWorktreeRootMappings().at(-1)!;
		assert.equal(d.snapshotId, latest.id, "the checkout continues from its latest snapshot");
		assert.equal(readFileSync(join(d.to, "from-c.txt"), "utf8"), "done on machine C\n");
		assert.equal(snapshotEntries(onD.sessionManager).at(-1)?.degradedFrom, work.id);
		assert.ok(!onD.notices.some((notice) => notice.message.includes("restored only partly")));

		assert.deepEqual(await discardDegradedRestore(onD.sessionManager, { settings }), [d.to]);
		await collectSnapshotGarbage(blobs, { graceSeconds: 0 });
		const released = new Set(await blobs.listBlobHashes());
		assert.ok(!snapshotBlobHashes(work).every((hash) => released.has(hash)), "discarding releases it");
	});
});
