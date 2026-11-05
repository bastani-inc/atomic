import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { restoreWorktreeSnapshot, setWorktreeSnapshotGit } from "@bastani/atomic";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import {
	listWorkflowSnapshotBoundaries,
	type WorkflowSnapshotBoundary,
} from "../../packages/workflows/src/durable/worktree-snapshots.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { openSqlSnapshotJournal, type SqlSnapshotJournal } from "../helpers/workflow-snapshot-journal.js";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

const BASE_SIZE = 128 * 1024;

interface RecordedRun {
	readonly status: string;
	readonly captureReads: number;
	readonly journal: SqlSnapshotJournal["journal"];
	readonly boundaries: readonly WorkflowSnapshotBoundary[];
}

let sandbox: GitSandbox;
let fixture: SqlSnapshotJournal | undefined;
let backend: JournalDurableBackend | undefined;
let recorded: RecordedRun;
/** The work a hook or test started, awaited before cleanup so a timed-out body never holds files being removed. */
let inFlight: Promise<unknown> = Promise.resolve();
const track = <T>(work: Promise<T>): Promise<T> => {
	inFlight = work;
	return work;
};

async function recordEightBoundaries(): Promise<RecordedRun> {
	const { clone } = await sandbox.remoteWithClone("repo", { "base.bin": Buffer.alloc(BASE_SIZE, 42) });
	fixture = await openSqlSnapshotJournal(sandbox.path("journal.sqlite"));
	const actual = fixture.journal;
	let ancestryReads = 0;
	let readsBeforeFirstCheckpoint = 0;
	const journal = new Proxy(actual, {
		get(target, key) {
			if (key === "read")
				return (runId: string, fromSeq?: number) => {
					if (fromSeq === undefined) ancestryReads++;
					return target.read(runId, fromSeq);
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	backend = await JournalDurableBackend.open(journal, { runs: [] });
	const definition = workflow({
		name: "count-deltas",
		description: "",
		inputs: {},
		outputs: { ok: Type.Boolean() },
		run: async (ctx) => {
			for (let index = 0; index < 8; index++) {
				await ctx.tool(`edit-${index}`, {}, async () => {
					if (index === 0) readsBeforeFirstCheckpoint = ancestryReads;
					sandbox.write(join(ctx.cwd!, "small.txt"), `change ${index}\n`);
					return index;
				});
			}
			return { ok: true };
		},
	});
	const result = await run(definition, {}, { cwd: clone, durableBackend: backend, store: createStore() });
	return {
		status: result.status,
		captureReads: ancestryReads - readsBeforeFirstCheckpoint,
		journal,
		boundaries: await listWorkflowSnapshotBoundaries(journal, result.runId),
	};
}

describe("eight workflow boundaries on one base (#4245)", () => {
	beforeAll(async () => {
		sandbox = new GitSandbox();
		recorded = await track(recordEightBoundaries());
	});

	afterAll(async () => {
		await inFlight.catch(() => undefined);
		await backend?.close();
		await fixture?.database.close();
		sandbox.dispose();
	});

	test("store deltas instead of eight bases, reading the root journal's ancestry once", async () => {
		const { status, captureReads, journal, boundaries } = recorded;
		assert.equal(status, "completed");
		assert.ok(
			captureReads <= 1,
			`snapshot ancestry read the root journal ${captureReads} times for eight checkpoints`,
		);
		assert.equal(boundaries.length, 8);
		const hashes = await journal.snapshotBlobs.listBlobHashes();
		const totalBytes = (await Promise.all(hashes.map((hash) => journal.snapshotBlobs.getBlob(hash)))).reduce<number>(
			(sum, blob) => sum + (blob?.byteLength ?? 0),
			0,
		);
		assert.equal(hashes.length, 8);
		assert.ok(totalBytes < BASE_SIZE, `delta bytes ${totalBytes} should be smaller than one ${BASE_SIZE}-byte base`);
	});

	test("restore all eight with one fetch of the base", async () => {
		await track(
			(async () => {
				const { journal, boundaries } = recorded;
				const trace = sandbox.path("git-trace.jsonl");
				setWorktreeSnapshotGit(async () => ({
					...sandbox.executable,
					env: { ...sandbox.executable.env, GIT_TRACE2_EVENT: trace },
				}));
				for (const [index, boundary] of boundaries.entries()) {
					const restored = await restoreWorktreeSnapshot(boundary.snapshot, {
						blobs: journal.snapshotBlobs,
						storeDir: sandbox.path("host"),
					});
					assert.equal(readFileSync(join(restored, "small.txt"), "utf8"), `change ${index}\n`);
				}
				const started = readFileSync(trace, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { event: string; argv?: string[] })
					.filter((event) => event.event === "start");
				assert.equal(started.filter((event) => event.argv?.includes("fetch")).length, 1);
				assert.equal(
					started.filter((event) => event.argv?.includes("apply")).length,
					boundaries.length,
					"each restore applies only the deltas after the newest tree the store already holds",
				);
			})(),
		);
	});
});
