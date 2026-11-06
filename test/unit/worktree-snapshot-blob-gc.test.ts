import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { SessionEntry } from "../../packages/coding-agent/src/core/session-manager-types.ts";
import {
	MemorySnapshotBlobStore,
	SNAPSHOT_COLLECTION_BATCH,
	SqlSnapshotBlobStore,
	snapshotBlobHashes,
} from "../../packages/coding-agent/src/core/worktree-snapshot/blob-store.ts";
import {
	collectSnapshotGarbage,
	DEFAULT_BLOB_GRACE_SECONDS,
} from "../../packages/coding-agent/src/core/worktree-snapshot/garbage.ts";
import type { SnapshotBlobStore } from "../../packages/coding-agent/src/core/worktree-snapshot/types.ts";
import { isWorkspaceConfigError, isWorkspaceSnapshotError } from "../../packages/coding-agent/src/index.ts";
import { countingDatabase } from "../helpers/counting-database.js";
import {
	ageBlobs,
	checkpointEvent,
	createSession,
	messageEntry,
	openSharedSnapshotDatabase,
	type SharedSnapshotDatabase,
	snapshotEntry,
	startRun,
	statusEvent,
	syntheticSnapshot,
	textBlob,
} from "../helpers/snapshot-reference-index.js";

let directory: string;
let shared: SharedSnapshotDatabase;
beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "snapshot-blob-gc-"));
	shared = await openSharedSnapshotDatabase(join(directory, "shared.sqlite"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await shared.close();
	rmSync(directory, { recursive: true, force: true });
});

const blobs = () => shared.journal.snapshotBlobs;
const stored = async () => [...(await blobs().listBlobHashes())].sort();
const collect = (graceSeconds?: number) =>
	collectSnapshotGarbage(blobs(), graceSeconds === undefined ? {} : { graceSeconds });

/** Stores one blob per name and returns their hashes, in order. */
async function put(...names: string[]): Promise<string[]> {
	const entries = names.map(textBlob);
	await blobs().putBlobs(entries);
	return entries.map((entry) => entry.hash);
}

async function runWithSnapshot(runId: string, status: Parameters<typeof statusEvent>[1], hashes: string[]) {
	const lease = await startRun(shared.journal, runId);
	await shared.journal.append(lease, statusEvent(runId, { status: "running" }, "RunStarted"));
	await shared.journal.append(lease, checkpointEvent([syntheticSnapshot(`snap-${runId}`, hashes)]));
	await shared.journal.append(lease, statusEvent(runId, status));
	return lease;
}

describe("the grace window protects blobs whose reference is not published yet (#4355)", () => {
	test("a blob stored by a capture still in flight survives collection, and stays once its reference is published", async () => {
		const [patch] = await put("patch of a capture in flight");
		assert.deepEqual((await collect()).deleted, [], "the reference is not published yet");
		assert.deepEqual(await stored(), [patch]);

		await runWithSnapshot("run-1", { status: "running" }, [patch!]);
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		assert.deepEqual((await collect()).deleted, []);
		assert.ok(await blobs().getBlob(patch!));
	});

	test("an unreferenced blob older than the window goes, a fresh one stays, and the result names exactly the hashes deleted", async () => {
		const [old] = await put("old");
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		const [fresh] = await put("fresh");

		assert.deepEqual((await collect()).deleted, [old]);
		assert.deepEqual(await stored(), [fresh]);
	});

	test("storing a blob again restarts its age, and so does refreshing it without its bytes", async () => {
		const [stored1, refreshed, untouched] = await put("stored again", "refreshed", "untouched");
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		await blobs().putBlobs([textBlob("stored again")]);
		assert.equal(await blobs().refreshBlobs([refreshed!, refreshed!]), true);

		assert.deepEqual((await collect()).deleted, [untouched]);
		assert.deepEqual(await stored(), [stored1, refreshed].sort());
		assert.equal(await blobs().refreshBlobs([refreshed!, "absent"]), false, "a missing hash is reported");
		assert.equal(await blobs().refreshBlobs([]), true);
	});

	test("the default window is one hour: a blob stored over an hour ago goes and one ten seconds younger stays", async () => {
		assert.equal(DEFAULT_BLOB_GRACE_SECONDS, 3600);
		const [older] = await put("over an hour old");
		await ageBlobs(shared.database, blobs().table, 3601);
		const [younger] = await put("ten seconds younger");
		await shared.database.run(`UPDATE ${blobs().table} SET created_at = created_at - 3590 WHERE hash = ?`, younger!);

		assert.deepEqual((await collect()).deleted, [older]);
	});

	test("a blob stored in the second that began exactly graceSeconds ago stays, because it can be younger than the window", async () => {
		// The age is kept in whole seconds on the database clock, so a blob stored late in a second carries that
		// second's start: stored at 10.9 and collected at 12.0, it is 1.1 seconds old, not 2.
		const graceSeconds = 2;
		const databaseSecond = async () =>
			Number((await shared.database.get<{ now: number }>("SELECT unixepoch() AS now"))!.now);
		const age = (hash: string, createdAt: number) =>
			shared.database.run(`UPDATE ${blobs().table} SET created_at = ? WHERE hash = ?`, createdAt, hash);
		for (let attempt = 1; ; attempt++) {
			const [sameSecond, secondBefore] = await put("stored in the boundary second", "stored a second earlier");
			const now = await databaseSecond();
			await age(sameSecond!, now - graceSeconds);
			await age(secondBefore!, now - graceSeconds - 1);
			const { deleted } = await collect(graceSeconds);
			// The database clock moved to the next second during the check, which makes both blobs old enough.
			if ((await databaseSecond()) !== now && attempt < 3) continue;

			assert.deepEqual(deleted, [secondBefore], "only a blob certainly older than the window goes");
			assert.deepEqual(await stored(), [sameSecond]);
			return;
		}
	});

	test("graceSeconds 0 collects an unreferenced blob at once, and a larger window is honoured", async () => {
		const [patch] = await put("short lived");
		await ageBlobs(shared.database, blobs().table, 120);

		assert.deepEqual((await collect(600)).deleted, []);
		assert.deepEqual((await collect(60)).deleted, [patch]);
		await put("short lived");
		assert.deepEqual((await collect(0)).deleted, [patch]);
		assert.deepEqual(await stored(), []);
	});

	test("age is measured on the database clock: a client clock two hours ahead neither exposes nor hides a blob", async () => {
		const [old] = await put("old");
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		const [fresh] = await put("fresh");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3600_000);

		assert.deepEqual((await collect()).deleted, [old]);
		assert.deepEqual(await stored(), [fresh]);
	});
});

describe("collection keeps the union of the session and workflow retained sets (#4355)", () => {
	test("blobs a resumable run or a session's latest snapshot needs survive one collection of the shared table; the rest go", async () => {
		const [runPatch, runBundle, sessionPatch, sessionBundle, olderSession, orphan] = await put(
			"run patch",
			"run bundle",
			"session patch",
			"session bundle",
			"older session snapshot",
			"orphan",
		);
		const lease = await startRun(shared.journal, "run-1");
		await shared.journal.append(lease, statusEvent("run-1", { status: "running" }, "RunStarted"));
		await shared.journal.append(
			lease,
			checkpointEvent([syntheticSnapshot("run-snap", [runPatch!, null], { bundle: runBundle })], "stage"),
		);
		const older = syntheticSnapshot("older", [olderSession!]);
		const latest = syntheticSnapshot("latest", [sessionPatch!], { bundle: sessionBundle });
		await createSession(shared.sessions, "session-1", [
			snapshotEntry("/repo", older.id, older),
			snapshotEntry("/repo", latest.id, latest),
		]);
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		assert.deepEqual([...(await collect()).deleted].sort(), [olderSession, orphan].sort());
		assert.deepEqual(await stored(), [runPatch, runBundle, sessionPatch, sessionBundle].sort());
	});

	test.each([
		["running", { status: "running" }, true],
		["paused", { status: "paused" }, true],
		["failed", { status: "failed" }, true],
		["blocked", { status: "blocked" }, true],
		["failed and not resumable", { status: "failed", resumable: false }, false],
		["running and not resumable", { status: "running", resumable: false }, false],
		["failed and explicitly resumable", { status: "failed", resumable: true }, true],
		["completed", { status: "completed" }, false],
		["cancelled", { status: "cancelled" }, false],
		["killed", { status: "killed" }, false],
		["a child of another root", { status: "failed", rootWorkflowId: "another-root" }, false],
		["its own root", { status: "failed", rootWorkflowId: "run-1" }, true],
		["a null root", { status: "failed", rootWorkflowId: null }, false],
	] as const)("a run whose latest status is %s keeps its snapshots: %s", async (_name, status, kept) => {
		const [patch] = await put("checkpointed");
		await runWithSnapshot("run-1", status, [patch!]);
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		assert.deepEqual((await collect()).deleted, kept ? [] : [patch]);
	});

	test("the latest status by sequence decides, and a status without the resume fields is ignored", async () => {
		const [patch] = await put("checkpointed");
		const lease = await runWithSnapshot("run-1", { status: "completed" }, [patch!]);
		await shared.journal.append(lease, {
			type: "StatusChanged",
			payload: { status: "failed", workflowId: "run-1" },
		} as never);
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		assert.deepEqual((await collect()).deleted, [patch], "the incomplete status does not revive the run");

		const [again] = await put("checkpointed again");
		await shared.journal.append(lease, checkpointEvent([syntheticSnapshot("again", [again!])]));
		await shared.journal.append(lease, statusEvent("run-1", { status: "failed" }));
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		assert.deepEqual((await collect()).deleted, []);
	});

	test("ui, task and boundary checkpoints do not reference snapshots, and a run without a status keeps them", async () => {
		const [ui, statusless] = await put("ui checkpoint", "run without status");
		const lease = await startRun(shared.journal, "run-1");
		await shared.journal.append(lease, checkpointEvent([syntheticSnapshot("ui", [ui!])], "ui"));
		await shared.journal.append(lease, checkpointEvent([syntheticSnapshot("kept", [statusless!])], "tool"));
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		assert.deepEqual((await collect()).deleted, [ui]);
	});

	test("deleting a run releases its blobs; a blob another retained run shares stays", async () => {
		const [own, sharedPatch] = await put("own", "shared");
		await runWithSnapshot("run-1", { status: "failed" }, [own!, sharedPatch!]);
		await runWithSnapshot("run-2", { status: "failed" }, [sharedPatch!]);
		await shared.journal.deleteRun("run-1");
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		assert.deepEqual((await collect()).deleted, [own]);
		await shared.journal.deleteRun("run-2");
		assert.deepEqual((await collect()).deleted, [sharedPatch]);
	});

	test("a session keeps the latest snapshot of each checkout, by sequence across every entry, only when it holds the record", async () => {
		const [a1, a2, b1, foreign] = await put("a1", "a2", "b1", "recorded elsewhere");
		const first = syntheticSnapshot("a1", [a1!], { root: "/a" });
		const second = syntheticSnapshot("a2", [a2!], { root: "/a" });
		const other = syntheticSnapshot("b1", [b1!], { root: "/b" });
		const elsewhere = syntheticSnapshot("elsewhere", [foreign!], { root: "/c" });
		await createSession(shared.sessions, "holder", [snapshotEntry("/c", elsewhere.id, elsewhere)]);
		await createSession(shared.sessions, "session-1", [
			snapshotEntry("/a", first.id, first),
			snapshotEntry("/b", other.id, other),
			snapshotEntry("/a", second.id, second),
			snapshotEntry("/a", first.id),
			snapshotEntry("/c", elsewhere.id),
		]);
		await shared.sessions.delete("holder");
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		assert.deepEqual(
			[...(await collect()).deleted].sort(),
			[a2, foreign].sort(),
			"the latest /a entry re-references a1, and /c's record lives only in a deleted session",
		);
	});

	test("replacing a session's entries replaces its references, and deleting the session releases them", async () => {
		const [before, after] = await put("before", "after");
		const original = syntheticSnapshot("before", [before!]);
		const replacement = syntheticSnapshot("after", [after!]);
		const { lastSeq } = await createSession(shared.sessions, "session-1", [
			snapshotEntry("/repo", original.id, original),
		]);
		const header = (await shared.sessions.load("session-1")).header;
		await shared.sessions.replace("session-1", header, [snapshotEntry("/repo", replacement.id, replacement)], {
			expectSeq: lastSeq,
		});
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		assert.deepEqual((await collect()).deleted, [before]);

		await shared.sessions.delete("session-1");
		assert.deepEqual((await collect()).deleted, [after]);
	});

	test("an appended entry moves the session's latest snapshot", async () => {
		const [first, second] = await put("first", "second");
		const one = syntheticSnapshot("one", [first!]);
		const two = syntheticSnapshot("two", [second!]);
		const firstEntry = snapshotEntry("/repo", one.id, one);
		const { lastSeq } = await createSession(shared.sessions, "session-1", [firstEntry]);
		await shared.sessions.append("session-1", [snapshotEntry("/repo", two.id, two, firstEntry.id)], {
			expectSeq: lastSeq,
		});
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		assert.deepEqual((await collect()).deleted, [first]);
		assert.deepEqual(await stored(), [second]);
	});
});

describe("session retention follows every leaf of the session tree (#4245, #4355)", () => {
	/** A session whose entries are written as given, each naming its parent, with every blob old enough to collect. */
	async function sessionOf(entries: SessionEntry[]) {
		await createSession(shared.sessions, "session-1", entries);
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
	}
	const record = (name: string, hash: string, root = "/repo") =>
		snapshotEntry(root, name, syntheticSnapshot(name, [hash]));
	const child = (entry: SessionEntry, parent: SessionEntry): SessionEntry => ({ ...entry, parentId: parent.id });

	test("returning to an earlier entry keeps the snapshot of the branch left behind and of the one continued", async () => {
		const [kept, abandoned] = await put("kept", "abandoned");
		const root = messageEntry("start");
		const first = child(record("kept", kept!), root);
		const second = child(record("abandoned", abandoned!), first);
		const returned = child(messageEntry("back at the first snapshot"), first);
		await sessionOf([root, first, second, returned]);

		assert.deepEqual((await collect()).deleted, []);
		assert.deepEqual(await stored(), [kept, abandoned].sort());
	});

	test("a snapshot that every leaf has a later snapshot of the same root for is collected", async () => {
		const [old, left, right] = await put("old", "left", "right");
		const root = messageEntry("start");
		const base = child(record("old", old!), root);
		const leftLeaf = child(record("left", left!), base);
		const rightLeaf = child(record("right", right!), base);
		await sessionOf([root, base, leftLeaf, rightLeaf]);

		assert.deepEqual((await collect()).deleted, [old]);
		assert.deepEqual(await stored(), [left, right].sort());
	});

	test("each root keeps its latest snapshot on a branch, and a branch that never recorded a root keeps the earlier one", async () => {
		const [a1, a2, b1] = await put("a1", "a2", "b1");
		const root = messageEntry("start");
		const firstA = child(record("a1", a1!, "/a"), root);
		const firstB = child(record("b1", b1!, "/b"), firstA);
		const secondA = child(record("a2", a2!, "/a"), firstB);
		const sideBranch = child(messageEntry("a branch of /b only"), firstB);
		await sessionOf([root, firstA, firstB, secondA, sideBranch]);

		assert.deepEqual((await collect()).deleted, [], "a2 and b1 on one branch, a1 and b1 on the other");
		assert.deepEqual(await stored(), [a1, a2, b1].sort());
	});

	test("messages between snapshots do not change which snapshots are kept", async () => {
		const [early, late] = await put("early", "late");
		const entries: SessionEntry[] = [messageEntry("start")];
		entries.push(child(record("early", early!), entries.at(-1)!));
		for (let index = 0; index < 40; index++) entries.push(child(messageEntry(`chat ${index}`), entries.at(-1)!));
		entries.push(child(record("late", late!), entries.at(-1)!));
		for (let index = 0; index < 40; index++) entries.push(child(messageEntry(`more ${index}`), entries.at(-1)!));
		await sessionOf(entries);

		assert.deepEqual((await collect()).deleted, [early]);
		assert.deepEqual(await stored(), [late]);
	});

	test("a checkout restored into a new worktree keeps only its newest snapshot, wherever it was recorded", async () => {
		const [before, after, later] = await put("before restore", "after restore", "after a second restore");
		const root = messageEntry("start");
		const first = child(record("before", before!, "/repo"), root);
		const restoredTo = (from: string, to: string) =>
			({ from, to, snapshotId: "before", tree: "tree", restoredAt: "now" }) as const;
		const restored = child(
			{
				...record("after", after!, "/repo-restored"),
				restore: restoredTo("/repo", "/repo-restored"),
			} as SessionEntry,
			first,
		);
		const restoredAgain = child(
			{
				...record("later", later!, "/repo-again"),
				restore: restoredTo("/repo-restored", "/repo-again"),
			} as SessionEntry,
			restored,
		);
		await sessionOf([root, first, restored, restoredAgain]);

		assert.deepEqual(
			[...(await collect()).deleted].sort(),
			[before, after].sort(),
			"a chain of restores is one checkout",
		);
		assert.deepEqual(await stored(), [later]);
	});

	test("a root that no restore on the branch connects to an earlier one is a checkout of its own", async () => {
		const [elsewhere, here] = await put("elsewhere", "here");
		const root = messageEntry("start");
		const first = child(record("elsewhere", elsewhere!, "/other"), root);
		const second = child(record("here", here!, "/repo"), first);
		await sessionOf([root, first, second]);

		assert.deepEqual((await collect()).deleted, []);
	});

	test("a restore on another branch does not merge two roots on this one", async () => {
		const [old, newer, side] = await put("old", "newer", "side");
		const root = messageEntry("start");
		const first = child(record("old", old!, "/repo"), root);
		const sideRestore = child(
			{
				...record("side", side!, "/repo-restored"),
				restore: { from: "/repo", to: "/repo-restored", snapshotId: "old", tree: "tree", restoredAt: "now" },
			} as SessionEntry,
			first,
		);
		const own = child(record("newer", newer!, "/repo-restored"), first);
		await sessionOf([root, first, sideRestore, own]);

		assert.deepEqual((await collect()).deleted, [], "here /repo and /repo-restored are two checkouts, there one");
	});

	test("an entry whose parent was never written makes its session keep every snapshot it records", async () => {
		const [old, latest] = await put("old", "latest");
		const root = messageEntry("start");
		const first = child(record("old", old!), root);
		const second = child(record("latest", latest!), first);
		const orphan = { ...messageEntry("lost its parent"), parentId: "never-written" } as SessionEntry;
		await sessionOf([root, first, second, orphan]);

		assert.deepEqual((await collect()).deleted, []);
	});

	test("two entries with one id make their session keep every snapshot it records", async () => {
		const [old, latest] = await put("old", "latest");
		const root = messageEntry("start");
		const first = child(record("old", old!), root);
		const second = child(record("latest", latest!), first);
		const twin = {
			...messageEntry("same id as the first snapshot"),
			id: first.id,
			parentId: root.id,
		} as SessionEntry;
		await sessionOf([root, first, second, twin]);

		assert.deepEqual((await collect()).deleted, []);
	});

	test("replacing a session's entries rebuilds its tree: the old branches stop keeping their snapshots", async () => {
		const [old, fresh] = await put("old", "fresh");
		const root = messageEntry("start");
		await sessionOf([root, child(record("old", old!), root)]);
		const { header } = await shared.sessions.load("session-1");
		const replacement = messageEntry("start again");
		await shared.sessions.replace("session-1", header, [replacement, child(record("fresh", fresh!), replacement)], {
			expectSeq: 2,
		});
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		assert.deepEqual((await collect()).deleted, [old]);
		assert.deepEqual(await stored(), [fresh]);
	});
});

describe("collection runs in batches", () => {
	test("more blobs than one batch are all examined, with retained blobs spread between the deleted ones", async () => {
		const total = SNAPSHOT_COLLECTION_BATCH * 2 + 7;
		const hashes = await put(...Array.from({ length: total }, (_, index) => `blob-${index}`));
		const keep = hashes.filter((_, index) => index % 3 === 0);
		await runWithSnapshot("run-1", { status: "failed" }, keep);
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);

		const { deleted } = await collect();
		assert.deepEqual([...deleted].sort(), hashes.filter((hash) => !keep.includes(hash)).sort());
		assert.deepEqual(await stored(), [...keep].sort());
	});

	test("a collection returns to the event loop between batches, so timers and I/O run during a long one", async () => {
		await put(...Array.from({ length: SNAPSHOT_COLLECTION_BATCH * 2 + 1 }, (_, index) => `blob-${index}`));
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		let ticked = false;
		const tickedBeforeBatch: boolean[] = [];

		await blobs().sweep({
			graceSeconds: DEFAULT_BLOB_GRACE_SECONDS,
			onBatch: () => {
				tickedBeforeBatch.push(ticked);
				ticked = false;
				setImmediate(() => {
					ticked = true;
				});
			},
		});

		assert.deepEqual(tickedBeforeBatch, [false, true, true], "a callback queued by one batch ran before the next");
	});

	test("an aborted collection rejects with the signal's reason, unwrapped, and keeps what earlier batches deleted", async () => {
		await put(...Array.from({ length: SNAPSHOT_COLLECTION_BATCH + 1 }, (_, index) => `blob-${index}`));
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		const controller = new AbortController();
		const reason = new Error("stop");
		const batches: number[] = [];

		await assert.rejects(
			blobs().collectGarbage({
				graceSeconds: DEFAULT_BLOB_GRACE_SECONDS,
				signal: controller.signal,
				onBatch: (deleted) => {
					batches.push(deleted.length);
					controller.abort(reason);
				},
			}),
			(error: unknown) => error === reason,
		);
		assert.deepEqual(batches, [SNAPSHOT_COLLECTION_BATCH]);
		assert.equal((await stored()).length, 1);
		await assert.rejects(
			collectSnapshotGarbage(blobs(), { signal: AbortSignal.abort(reason) }),
			(error) => error === reason,
		);
	});
});

describe("collectSnapshotGarbage validates graceSeconds at the boundary", () => {
	test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "10" as unknown as number])(
		"%s is refused as a typed config error before the store is touched",
		async (graceSeconds) => {
			const [patch] = await put("untouched");
			await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
			const reads = vi.spyOn(shared.database, "transaction");
			await assert.rejects(collectSnapshotGarbage(blobs(), { graceSeconds }), (error: unknown) => {
				assert.ok(isWorkspaceConfigError(error));
				assert.equal(error.code, "invalid-setting");
				assert.deepEqual(error.fields, {
					source: "sdk",
					field: "graceSeconds",
					expected: "a non-negative integer number of seconds",
				});
				return true;
			});
			assert.equal(reads.mock.calls.length, 0);
			assert.deepEqual(await stored(), [patch]);
		},
	);

	test("the refusal tells the caller what to set", async () => {
		await assert.rejects(
			collectSnapshotGarbage(blobs(), { graceSeconds: -5 }),
			(error: unknown) =>
				(error as Error).message ===
				"Invalid worktree snapshot setting: graceSeconds from sdk (invalid-setting). Set graceSeconds to a non-negative integer number of seconds.",
		);
	});
});

describe("collectSnapshotGarbage refuses a store it cannot collect, before reading anything (#4355)", () => {
	/** A store that keeps its blobs in the shared database but is not the SQL store, so it has no reference index. */
	async function wrappedSqlStore() {
		const counted = countingDatabase(shared.database);
		const sql = await SqlSnapshotBlobStore.open(counted.wrapped);
		const wrapped: SnapshotBlobStore = {
			putBlobs: (entries) => sql.putBlobs(entries),
			getBlob: (hash) => sql.getBlob(hash),
			refreshBlobs: (hashes) => sql.refreshBlobs(hashes),
			listBlobHashes: () => sql.listBlobHashes(),
		};
		counted.statements.length = 0;
		counted.counts.transactions = 0;
		return { wrapped, counted };
	}

	test.each([
		["an in-memory store", new MemorySnapshotBlobStore()],
		["no store, as for storage without a blob table", undefined],
	] as const)(
		"%s is refused with the typed blob-store-unsupported error",
		async (_name, store: SnapshotBlobStore | undefined) => {
			await assert.rejects(collectSnapshotGarbage(store), (error: unknown) => {
				assert.ok(isWorkspaceSnapshotError(error));
				assert.equal(error.code, "blob-store-unsupported");
				assert.deepEqual(error.fields, { subject: "non-SQLite" });
				assert.equal(error.retryable, false);
				return true;
			});
		},
	);

	test("a store of its own over a SQL database is refused without a single statement or transaction", async () => {
		const [patch] = await put("untouched");
		await ageBlobs(shared.database, blobs().table, DEFAULT_BLOB_GRACE_SECONDS + 10);
		const { wrapped, counted } = await wrappedSqlStore();

		await assert.rejects(collectSnapshotGarbage(wrapped), (error: unknown) => isWorkspaceSnapshotError(error));

		assert.deepEqual(counted.statements, []);
		assert.equal(counted.counts.transactions, 0);
		assert.deepEqual(await stored(), [patch]);
	});

	test("the store is checked before the settings: an unsupported store with an invalid grace is a store error", async () => {
		await assert.rejects(collectSnapshotGarbage(undefined, { graceSeconds: -1 }), (error: unknown) =>
			isWorkspaceSnapshotError(error),
		);
	});
});

test("snapshotBlobHashes names each chain patch and the bundle once, skipping links without a patch", () => {
	assert.deepEqual(snapshotBlobHashes(syntheticSnapshot("s", ["p1", null, "p2", "p1"], { bundle: "b" })), [
		"p1",
		"p2",
		"b",
	]);
});
