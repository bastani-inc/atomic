import assert from "node:assert/strict";
import { join } from "node:path";
import type { SessionEntry } from "@bastani/atomic";
import { StorageProvider } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import {
	openSqlPoolQueue,
	type PoolCommitReceipt,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { DurableToolCheckpoint } from "../../packages/workflows/src/durable/types.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const { work, boundary } = poolWorkFixture();
const run = { ...boundary.topology!.boundary!.child };
const checkpoint: DurableToolCheckpoint = {
	kind: "tool",
	workflowId: "root",
	checkpointId: `${work.scope}:tool:1`,
	name: "tool",
	argsHash: `${work.scope}:args`,
	output: { saved: true },
	completedAt: 1,
	topology: { version: 1, nodeId: "tool", parentIds: [], ordinal: 0, order: 0, run },
};
const stage = {
	kind: "stage" as const,
	workflowId: "root",
	checkpointId: `${work.scope}:session:0`,
	name: "stage",
	replayKey: `${work.scope}:stage`,
	sessionId: "session",
	completedAt: 0,
	topology: { version: 1 as const, stageId: "stage", parentIds: [], sourceOrder: 0, run },
};
const header = { id: "session", version: 4 as const, createdAt: "2026-01-01T00:00:00Z", cwd: "/gone/scratch" };
const messages: SessionEntry[] = [
	{
		type: "message",
		id: "message",
		parentId: null,
		timestamp: header.createdAt,
		message: { role: "user", content: "durable prompt", timestamp: 1 },
	},
];
const createSession = { kind: "session-create" as const, checkpoint: stage, header, entries: messages };

async function fixture() {
	const directory = makeTempDirectory("pool-commits-");
	const path = join(directory, "journal.sqlite");
	const database = await openNodeSqliteDatabase(path);
	const journal = await SqlRunJournal.open(database);
	const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
	await backend.commitWorkflowRegistration({
		workflowId: "root",
		name: "root",
		inputs: {},
		createdAt: 0,
		status: "running",
	});
	const acquired = await journal.acquire("root", backend.holderId);
	assert.equal(acquired.status, "acquired");
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const pool = await openSqlPoolQueue(journal);
	await pool.initialize(acquired.lease, 60_000);
	await pool.enqueue(acquired.lease, work, boundary);
	const attempt = await pool.claim(acquired.lease, "worker", [work], 60_000);
	assert.ok(attempt);
	return {
		database,
		journal,
		backend,
		pool,
		attempt,
		lease: acquired.lease,
		path,
		async close() {
			await backend.close();
			await journal.close();
			await database.close();
			removeTempDirectory(directory);
		},
	};
}

test("intervening attempt checkpoints stay visible across root writes and receipt retries (#3869)", async () => {
	const f = await fixture();
	try {
		const mutation = { kind: "checkpoint" as const, checkpoint };
		let committedReceipt: PoolCommitReceipt | undefined;
		const append = f.journal.append.bind(f.journal);
		const interleaved = vi.spyOn(f.journal, "append").mockImplementationOnce(async (...args) => {
			committedReceipt = await f.pool.commit(f.lease, f.attempt, "save", mutation);
			return append(...args);
		});
		await f.backend.commitCheckpoint({
			...checkpoint,
			checkpointId: "root-tool",
			argsHash: "root-args",
			output: "root",
			topology: { ...checkpoint.topology!, run: { runId: "root", runName: "root" } },
		});
		assert.equal(interleaved.mock.calls.length, 1);
		interleaved.mockRestore();
		assert.deepEqual(f.backend.getToolOutput("root", checkpoint.argsHash), { saved: true });
		assert.equal(f.backend.getToolOutput("root", "root-args"), "root");
		const receipt = committedReceipt;
		assert.ok(receipt);
		assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "save", mutation), receipt);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "save", {
				kind: "checkpoint",
				checkpoint: { ...checkpoint, output: "changed" },
			}),
			/identity conflict/,
		);
		await f.backend.commitWorkflowStatus("root", "running");
		assert.deepEqual(f.backend.getToolOutput("root", checkpoint.argsHash), { saved: true });
		assert.equal(f.backend.getToolOutput("root", "root-args"), "root");
		const entries = [];
		for await (const entry of f.journal.read("root")) entries.push(entry);
		assert.equal(entries.filter((entry) => entry.seq === receipt.seq).length, 1);
		assert.equal(entries.length, 5);
	} finally {
		await f.close();
	}
});

test("root status snapshots preserve interleaved checkpoint metadata after reopening (#3869)", async () => {
	const f = await fixture();
	try {
		const append = f.journal.append.bind(f.journal);
		const interleaved = vi.spyOn(f.journal, "append").mockImplementationOnce(async (...args) => {
			await f.pool.commit(f.lease, f.attempt, "save", { kind: "checkpoint", checkpoint });
			return append(...args);
		});
		try {
			await f.backend.commitWorkflowStatus("root", "paused");
		} finally {
			interleaved.mockRestore();
		}
		const expectedCheckpoints = [boundary, checkpoint];
		assert.deepEqual(f.backend.listCheckpoints("root"), expectedCheckpoints);
		assert.equal(f.backend.getWorkflow("root")?.status, "paused");
		assert.equal(f.backend.getWorkflow("root")?.completedCheckpoints, expectedCheckpoints.length);
		const reopened = await JournalDurableBackend.open(f.journal, { ownsJournal: false });
		try {
			assert.deepEqual(reopened.listCheckpoints("root"), expectedCheckpoints);
			assert.equal(reopened.getWorkflow("root")?.status, "paused");
			assert.equal(reopened.getWorkflow("root")?.completedCheckpoints, expectedCheckpoints.length);
		} finally {
			await reopened.close();
		}
	} finally {
		await f.close();
	}
});

test("session transcripts and checkpoints commit atomically and acknowledge once (#3869)", async () => {
	const f = await fixture();
	const sessions = await new StorageProvider().openSessionStore(
		{ kind: "database", database: f.database, prefix: "wf_runs_pool_" },
		{ agentDir: "/unused", domain: "sessions" },
	);
	try {
		const entries = messages;
		const create = createSession;
		const first = await f.pool.commit(f.lease, f.attempt, "create", create);
		assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "create", create), first);
		assert.deepEqual((await sessions.load("session")).entries, entries);
		const append = {
			kind: "session-append" as const,
			checkpoint: { ...stage, checkpointId: `${work.scope}:session:1` },
			entries: [{ ...entries[0]!, id: "next", parentId: "message" }],
			expectSeq: 1,
		};
		await f.database.exec(
			"CREATE TRIGGER fail_receipt BEFORE INSERT ON wf_runs_pool_operations WHEN NEW.operation = 'append' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
		);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "append", append),
			(error: Error) => error.cause instanceof Error && error.cause.message === "receipt failure",
		);
		assert.equal((await sessions.load("session")).lastSeq, 1);
		await f.backend.hydrateWorkflow("root");
		assert.equal(
			f.backend.listCheckpoints("root").some((c) => c.checkpointId === append.checkpoint.checkpointId),
			false,
		);
		await f.database.exec("DROP TRIGGER fail_receipt");
		const receipt = await f.pool.commit(f.lease, f.attempt, "append", append);
		assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "append", append), receipt);
		assert.deepEqual((await sessions.load("session")).entries, [...entries, ...append.entries]);
	} finally {
		await sessions.close();
		await f.close();
	}
});

test("workers cannot forge root graph ownership or commit non-protocol mutations (#3869)", async () => {
	const f = await fixture();
	try {
		for (const invalid of [
			{ ...checkpoint, workflowId: "sibling" },
			{ ...checkpoint, checkpointId: `${work.scope}-other:tool` },
			{ ...checkpoint, argsHash: "root-result" },
			{
				...checkpoint,
				topology: {
					version: 1 as const,
					nodeId: "root:tool:0",
					parentIds: [],
					ordinal: 0,
					order: 0,
					run: { runId: "root", runName: "root" },
				},
			},
		])
			await assert.rejects(
				f.pool.commit(f.lease, f.attempt, "invalid", { kind: "checkpoint", checkpoint: invalid }),
				/scope/,
			);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "scratch", {
				kind: "checkpoint",
				checkpoint: { ...stage, sessionFile: "/gone/session.jsonl" },
			}),
			/database/,
		);
		const unowned = { ...checkpoint };
		Reflect.deleteProperty(unowned, "topology");
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "unowned", { kind: "checkpoint", checkpoint: unowned }),
			/scope/,
		);
		const invalid = { kind: "checkpoint" as const, checkpoint };
		Reflect.set(invalid, "kind", "root-status");
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "invalid", invalid), /mutation/);
		const foreignParents = { ...checkpoint, topology: { ...checkpoint.topology!, parentIds: ["root-node"] } };
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "foreign-parent", { kind: "checkpoint", checkpoint: foreignParents }),
			/scope/,
		);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "future", {
				kind: "checkpoint",
				checkpoint: { ...checkpoint, completedAt: Number.MAX_SAFE_INTEGER },
			}),
			/timestamp/,
		);
		Reflect.set(invalid, "kind", "checkpoint");
		Reflect.set(invalid, "checkpoint", { ...checkpoint, output: () => "not serializable" });
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "invalid", invalid), /JSON/);
		const overlapping = poolWorkFixture("overlap", "other-child", `${work.scope}:overlap`);
		await assert.rejects(f.pool.enqueue(f.lease, overlapping.work, overlapping.boundary), /scope/);
		await f.pool.commit(f.lease, f.attempt, "invalid", { kind: "checkpoint", checkpoint });
	} finally {
		await f.close();
	}
});

test.each(["generation", "epoch", "expired", "paused"] as const)(
	"%s fences checkpoint and session mutations without losing durable state (#3869)",
	async (fence) => {
		const f = await fixture();
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "database", database: f.database, prefix: "wf_runs_pool_" },
			{ agentDir: "/unused", domain: "sessions" },
		);
		try {
			await f.pool.commit(f.lease, f.attempt, "create", createSession);
			let coordinator = f.lease;
			if (fence === "generation" || fence === "expired") {
				await f.database.run("UPDATE wf_runs_work SET expires_at = 0");
				if (fence === "generation") {
					await f.pool.expire(coordinator, f.attempt);
					await f.pool.claim(coordinator, "worker", [work], 60_000);
				}
			} else if (fence === "epoch") {
				await f.journal.release(coordinator);
				const next = await f.journal.acquire("root", coordinator.holderId);
				if (next.status !== "acquired") assert.fail("No replacement coordinator");
				coordinator = next.lease;
			} else await f.backend.commitWorkflowStatus("root", "paused");
			const replacement = { ...stage, checkpointId: `${work.scope}:session:1` };
			const mutation = {
				kind: "session-replace" as const,
				checkpoint: replacement,
				header,
				entries: [],
				expectSeq: 1,
			};
			await assert.rejects(f.pool.commit(coordinator, f.attempt, "late-session", mutation), /[Ss]tale|not running/);
			await assert.rejects(
				f.pool.commit(coordinator, f.attempt, "late-result", { kind: "checkpoint", checkpoint }),
				/[Ss]tale|not running/,
			);
			if (fence === "epoch")
				await assert.rejects(
					f.pool.commit(f.lease, f.attempt, "old-coordinator", { kind: "checkpoint", checkpoint }),
					/Stale lease/,
				);
			assert.deepEqual((await sessions.load("session")).entries, messages);
			await f.backend.hydrateWorkflow("root");
			assert.equal(f.backend.getToolOutput("root", checkpoint.argsHash), undefined);
		} finally {
			await sessions.close();
			await f.close();
		}
	},
);

test("database reopen recovers attempts, receipts, sessions and results without the scratch directory (#3869)", async () => {
	const f = await fixture();
	try {
		const saved = await f.pool.commit(f.lease, f.attempt, "save", { kind: "checkpoint", checkpoint });
		await f.pool.commit(f.lease, f.attempt, "create", createSession);
		const database = await openNodeSqliteDatabase(f.path);
		const journal = await SqlRunJournal.open(database);
		const peer = await openSqlPoolQueue(journal);
		const projection = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "database", database, prefix: "wf_runs_pool_" },
			{ agentDir: "/new/scratch", domain: "sessions" },
		);
		try {
			assert.deepEqual(await peer.commit(f.lease, f.attempt, "save", { kind: "checkpoint", checkpoint }), saved);
			assert.deepEqual(projection.getToolOutput("root", checkpoint.argsHash), { saved: true });
			assert.deepEqual((await sessions.load("session")).entries, messages);
			await database.run("UPDATE wf_leases SET renewed_at = 0");
			const takeover = await journal.takeoverExpired("root", "replacement-coordinator", 60_000);
			if (takeover.status !== "acquired") assert.fail("No takeover");
			await peer.expire(takeover.lease, f.attempt);
			const next = await peer.claim(takeover.lease, "replacement-worker", [work], 60_000);
			assert.ok(next);
			assert.equal(next.generation, f.attempt.generation + 1);
			assert.equal(next.epoch, takeover.lease.epoch);
			await assert.rejects(
				peer.commit(takeover.lease, f.attempt, "late", { kind: "checkpoint", checkpoint }),
				/Stale work/,
			);
			assert.deepEqual(await peer.commit(takeover.lease, next, "save", { kind: "checkpoint", checkpoint }), saved);
			const append = {
				kind: "session-append" as const,
				checkpoint: { ...stage, checkpointId: `${work.scope}:session:1` },
				entries: [{ ...messages[0]!, id: "continued", parentId: "message" }],
				expectSeq: 1,
			};
			await assert.rejects(
				peer.commit(takeover.lease, next, "wrong-session", {
					...append,
					checkpoint: { ...append.checkpoint, replayKey: `${work.scope}:other-stage` },
				}),
				/scope/,
			);
			assert.equal((await peer.commit(takeover.lease, next, "continue", append)).lastSeq, 2);
			assert.deepEqual((await sessions.load("session")).entries, [...messages, ...append.entries]);
		} finally {
			await sessions.close();
			await projection.close();
			await journal.close();
			await database.close();
		}
	} finally {
		await f.close();
	}
});

test("nested boundary commits remain replayable and reject malformed ownership (#3869)", async () => {
	const f = await fixture();
	try {
		const nested = poolWorkFixture("nested", "grandchild", `${work.scope}:workflow:nested:0`).boundary;
		const child = { ...nested.topology!.boundary!.child, parentRunId: run.runId };
		const start = {
			...nested,
			checkpointId: `${work.scope}:boundary-start:workflow:nested:0`,
			topology: { ...nested.topology!, run, boundary: { ...nested.topology!.boundary!, child } },
		};
		const malformed = structuredClone(start);
		Reflect.deleteProperty(malformed.topology, "sourceOrder");
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "malformed", { kind: "checkpoint", checkpoint: malformed }),
			/source identity/,
		);
		await f.pool.commit(f.lease, f.attempt, "nested", { kind: "checkpoint", checkpoint: start });
		const grandchild = {
			...checkpoint,
			checkpointId: `${start.replayKey}:tool`,
			argsHash: `${start.replayKey}:args`,
			topology: { ...checkpoint.topology!, run: child },
		};
		await f.pool.commit(f.lease, f.attempt, "grandchild", { kind: "checkpoint", checkpoint: grandchild });
		await f.backend.hydrateWorkflow("root");
		assert.deepEqual(
			durableWorkflowRunSnapshots(f.backend, f.backend.getWorkflow("root")!)
				.map((snapshot) => snapshot.id)
				.sort(),
			["root", work.childRunId, child.runId].sort(),
		);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "wrong-scope", {
				kind: "checkpoint",
				checkpoint: { ...grandchild, checkpointId: `${work.scope}:escaped`, argsHash: `${work.scope}:escaped` },
			}),
			/scope/,
		);
	} finally {
		await f.close();
	}
});
