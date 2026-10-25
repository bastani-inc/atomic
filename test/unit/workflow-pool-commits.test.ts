import assert from "node:assert/strict";
import { join } from "node:path";
import type { SessionEntry } from "@bastani/atomic";
import { StorageProvider } from "@bastani/atomic/storage";
import { test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import {
	completedWorkflowRunSnapshots,
	durableWorkflowRunSnapshots,
} from "../../packages/workflows/src/durable/completed-catalog.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { poolStageUsageKey } from "../../packages/workflows/src/durable/journal/pool-stage-usage.js";
import {
	openSqlPoolQueue,
	type PoolCommitReceipt,
} from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { openSqlPoolUsage } from "../../packages/workflows/src/durable/journal/sql-pool-usage.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import { RUN_EVENT_TYPES } from "../../packages/workflows/src/durable/journal/types.js";
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

async function journalEventCount(database: { get: (sql: string) => Promise<Record<string, unknown> | undefined> }) {
	return Number((await database.get("SELECT COUNT(*) AS count FROM wf_events"))?.count);
}

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
			sessionId: "session",
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
		await f.database.exec("DROP TRIGGER fail_receipt");
		const events = await journalEventCount(f.database);
		const receipt = await f.pool.commit(f.lease, f.attempt, "append", append);
		assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "append", append), receipt);
		assert.deepEqual((await sessions.load("session")).entries, [...entries, ...append.entries]);
		assert.equal(receipt.lastSeq, 2);
		assert.equal(await journalEventCount(f.database), events, "an append journals no checkpoint (#3903)");
	} finally {
		await sessions.close();
		await f.close();
	}
});

test("session replacements require explicit topology, appends need none, and both run graphs recover after reopening (#3869)", async () => {
	const f = await fixture();
	try {
		await f.pool.commit(f.lease, f.attempt, "create", createSession);
		const { topology: _topology, ...withoutTopology } = stage;
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "replace", {
				kind: "session-replace",
				checkpoint: { ...withoutTopology, checkpointId: `${work.scope}:session:1`, completedAt: 1 },
				header,
				entries: messages,
				expectSeq: 1,
			}),
			/Pool topology scope mismatch/,
		);
		const append = {
			kind: "session-append" as const,
			sessionId: "session",
			entries: [{ ...messages[0]!, id: "continued", parentId: "message" }],
			expectSeq: 1,
		};
		const receipt = await f.pool.commit(f.lease, f.attempt, "continue", append);
		assert.equal(receipt.lastSeq, 2);
		await f.pool.commit(f.lease, f.attempt, "stage-complete", {
			kind: "checkpoint",
			checkpoint: {
				...stage,
				checkpointId: `${work.scope}:stage:complete`,
				completedAt: 2,
				output: { done: true },
				topology: { ...stage.topology, status: "completed" },
			},
		});
		const database = await openNodeSqliteDatabase(f.path);
		const journal = await SqlRunJournal.open(database);
		const projection = await JournalDurableBackend.open(journal, { ownsJournal: false });
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "database", database, prefix: "wf_runs_pool_" },
			{ agentDir: "/new/scratch", domain: "sessions" },
		);
		try {
			const peer = await openSqlPoolQueue(journal);
			assert.deepEqual(await peer.commit(f.lease, f.attempt, "continue", append), receipt);
			assert.deepEqual((await sessions.load("session")).entries, [...messages, ...append.entries]);
			const expectedRuns = ["root", work.childRunId].sort();
			assert.deepEqual(
				durableWorkflowRunSnapshots(projection, projection.getWorkflow("root")!)
					.map((snapshot) => snapshot.id)
					.sort(),
				expectedRuns,
			);
			await f.backend.commitCheckpoint({
				...boundary,
				checkpointId: `boundary-complete:${work.scope}`,
				completedAt: 3,
				output: {
					workflow: "child",
					runId: work.childRunId,
					status: "completed",
					exited: false,
					outputs: { done: true },
				},
				topology: {
					...boundary.topology!,
					status: "completed",
					boundary: { ...boundary.topology!.boundary!, event: "terminal", status: "completed" },
				},
			});
			await f.backend.commitWorkflowStatus("root", "completed");
			await projection.hydrateWorkflow("root");
			const [entry] = projection.listCompletedWorkflows();
			assert.ok(entry);
			assert.deepEqual(
				(await completedWorkflowRunSnapshots(projection, entry, sessions)).map((snapshot) => snapshot.id).sort(),
				expectedRuns,
			);
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

test.each(["checkpoint", "session"] as const)(
	"%s receipt survives lost acknowledgement and same-generation work lease expiry (#3869)",
	async (kind) => {
		const f = await fixture();
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "database", database: f.database, prefix: "wf_runs_pool_" },
			{ agentDir: "/unused", domain: "sessions" },
		);
		try {
			await f.pool.commit(f.lease, f.attempt, "create", createSession);
			const append = {
				kind: "session-append" as const,
				sessionId: "session",
				entries: [{ ...messages[0]!, id: "next", parentId: "message" }],
				expectSeq: 1,
			};
			const mutation = kind === "checkpoint" ? { kind: "checkpoint" as const, checkpoint } : append;
			const committed = await f.pool.commit(f.lease, f.attempt, "lost-ack", mutation);
			await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.attempt.id);
			const [expired] = await f.pool.inspect("root");
			assert.equal(expired?.generation, f.attempt.generation);
			assert.equal(expired?.state, "leased");
			assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "lost-ack", mutation), committed);
			const mismatched =
				mutation.kind === "checkpoint"
					? { ...mutation, checkpoint: { ...mutation.checkpoint, output: "changed" } }
					: { ...mutation, entries: [] };
			await assert.rejects(f.pool.commit(f.lease, f.attempt, "lost-ack", mismatched), /identity conflict/);
			await assert.rejects(f.pool.commit(f.lease, f.attempt, "new-operation", mutation), /Stale work lease/);
			await assert.rejects(
				f.pool.commit(f.lease, { ...f.attempt, worker: "impostor" }, "lost-ack", mutation),
				/Stale work lease/,
			);
			await f.backend.hydrateWorkflow("root");
			if (mutation.kind === "checkpoint")
				assert.equal(
					f.backend.listCheckpoints("root").filter((entry) => entry.checkpointId === checkpoint.checkpointId)
						.length,
					1,
				);
			assert.deepEqual(
				(await sessions.load("session")).entries,
				kind === "checkpoint" ? messages : [...messages, ...append.entries],
			);
			if (kind === "session") assert.equal(committed.lastSeq, 2);
		} finally {
			await sessions.close();
			await f.close();
		}
	},
);

test("worker clock skew preserves checkpoints and receipts without extending leases (#3869)", async () => {
	const f = await fixture();
	const coordinatorNow = Date.now() + 60_000;
	const completedAt = coordinatorNow + 20;
	const clock = vi.spyOn(Date, "now").mockReturnValue(coordinatorNow);
	try {
		const mutation = { kind: "checkpoint" as const, checkpoint: { ...checkpoint, completedAt } };
		const receipt = await f.pool.commit(f.lease, f.attempt, "save", mutation);
		assert.ok(receipt.at < completedAt);
		assert.deepEqual(await f.pool.commit(f.lease, f.attempt, "save", mutation), receipt);
		await f.backend.hydrateWorkflow("root");
		assert.equal(f.backend.getToolCheckpoint("root", checkpoint.argsHash)?.completedAt, completedAt);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "future", {
				...mutation,
				checkpoint: { ...mutation.checkpoint, completedAt: coordinatorNow + 60_000 },
			}),
			/Pool checkpoint timestamp is in the future/,
		);
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.attempt.id);
		await assert.rejects(f.pool.commit(f.lease, f.attempt, "late", mutation), /Stale work lease/);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "save", {
				...mutation,
				checkpoint: { ...mutation.checkpoint, completedAt: completedAt + 1 },
			}),
			/identity conflict/,
		);
	} finally {
		clock.mockRestore();
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

test.each(["generation", "epoch", "coordinator-expired", "expired", "paused"] as const)(
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
			} else if (fence === "coordinator-expired") {
				await f.database.run("UPDATE wf_leases SET renewed_at = 0");
			} else await f.backend.commitWorkflowStatus("root", "paused");
			if (fence !== "expired" && fence !== "paused")
				await assert.rejects(f.pool.commit(coordinator, f.attempt, "create", createSession), /[Ss]tale/);
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

test("session appends journal no checkpoint and keep only a request digest, however large the entries (#3903)", async () => {
	const f = await fixture();
	const sessions = await new StorageProvider().openSessionStore(
		{ kind: "database", database: f.database, prefix: "wf_runs_pool_" },
		{ agentDir: "/unused", domain: "sessions" },
	);
	try {
		await f.pool.commit(f.lease, f.attempt, "create", createSession);
		const events = await journalEventCount(f.database);
		const large = "x".repeat(128 * 1024);
		let parentId = "message";
		for (let index = 0; index < 20; index++) {
			const entry: SessionEntry = {
				type: "message",
				id: `entry-${index}`,
				parentId,
				timestamp: header.createdAt,
				message: { role: "user", content: index % 5 === 0 ? large : `entry ${index}`, timestamp: index + 2 },
			};
			const receipt = await f.pool.commit(f.lease, f.attempt, `append-${index}`, {
				kind: "session-append",
				sessionId: "session",
				entries: [entry],
				expectSeq: index + 1,
			});
			assert.equal(receipt.lastSeq, index + 2);
			parentId = entry.id;
		}
		assert.equal((await sessions.load("session")).entries.length, 21);
		assert.equal(await journalEventCount(f.database), events);
		const operations = await f.database.all(
			"SELECT length(request) AS request, length(receipt) AS receipt FROM wf_runs_pool_operations",
		);
		assert.equal(operations.length, 21);
		assert.ok(
			operations.every((row) => Number(row.request) === 64 && Number(row.receipt) < 128),
			JSON.stringify(operations),
		);
	} finally {
		await sessions.close();
		await f.close();
	}
});

test("a session append is refused for a session another work item created (#3903)", async () => {
	const f = await fixture();
	const sessions = await new StorageProvider().openSessionStore(
		{ kind: "database", database: f.database, prefix: "wf_runs_pool_" },
		{ agentDir: "/unused", domain: "sessions" },
	);
	try {
		await f.pool.commit(f.lease, f.attempt, "create", createSession);
		const other = poolWorkFixture("other", "other-child", "workflow:other:0");
		await f.pool.enqueue(f.lease, other.work, other.boundary);
		const intruder = await f.pool.claim(f.lease, "intruder", [other.work], 60_000);
		assert.equal(intruder?.childRunId, other.work.childRunId);
		const append = {
			kind: "session-append" as const,
			sessionId: "session",
			entries: [{ ...messages[0]!, id: "forged", parentId: "message" }],
			expectSeq: 1,
		};
		await assert.rejects(f.pool.commit(f.lease, intruder!, "forged", append), /Pool session scope mismatch/);
		assert.deepEqual((await sessions.load("session")).entries, messages);
		assert.equal((await f.pool.commit(f.lease, f.attempt, "owned", append)).lastSeq, 2);
	} finally {
		await sessions.close();
		await f.close();
	}
});

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
				sessionId: "session",
				entries: [{ ...messages[0]!, id: "continued", parentId: "message" }],
				expectSeq: 1,
			};
			await assert.rejects(
				peer.commit(takeover.lease, next, "wrong-session", { ...append, sessionId: "unowned-session" }),
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

test("a version 1 pool journal migrates: renewal rows go, requests become digests, and its sessions stay inspectable and resumable (#3903)", async () => {
	const f = await fixture();
	const sessions = await new StorageProvider().openSessionStore(
		{ kind: "database", database: f.database, prefix: "wf_runs_pool_" },
		{ agentDir: "/unused", domain: "sessions" },
	);
	try {
		// Rows exactly as version 1 wrote them: every commit kept its full request for retry identity, every append
		// journaled its own `:session:` stage checkpoint, and every heartbeat renewal kept the whole work as a receipt.
		const created = await f.pool.commit(f.lease, f.attempt, "create", createSession);
		await f.database.run(
			"UPDATE wf_runs_pool_operations SET request = ? WHERE operation = 'create'",
			JSON.stringify({ epoch: f.attempt.epoch, worker: f.attempt.worker, mutation: createSession }),
		);
		const v1Append = {
			kind: "session-append",
			checkpoint: { ...stage, checkpointId: `${work.scope}:session:1`, completedAt: 1 },
			entries: [{ ...messages[0]!, id: "v1-append", parentId: "message" }],
			expectSeq: 1,
		};
		assert.equal((await sessions.append("session", v1Append.entries, { expectSeq: 1 })).lastSeq, 2);
		const seq =
			Number((await f.database.get("SELECT MAX(seq) AS seq FROM wf_events WHERE run_id = 'root'"))?.seq) + 1;
		await f.database.run(
			"INSERT INTO wf_events VALUES (?, ?, ?, ?, ?, ?, ?)",
			"root",
			seq,
			f.lease.epoch,
			JSON.stringify([RUN_EVENT_TYPES.checkpointRecorded, "stage", v1Append.checkpoint.checkpointId]),
			RUN_EVENT_TYPES.checkpointRecorded,
			JSON.stringify(v1Append.checkpoint),
			2,
		);
		await f.database.run(
			"INSERT INTO wf_runs_pool_operations VALUES (?, ?, ?, ?, ?)",
			f.attempt.id,
			f.attempt.generation,
			"v1-append",
			JSON.stringify({ epoch: f.attempt.epoch, worker: f.attempt.worker, mutation: v1Append }),
			JSON.stringify({ seq, at: 2, lastSeq: 2 }),
		);
		for (let beat = 0; beat < 100; beat++)
			await f.database.run(
				"INSERT INTO wf_runs_pool_operations VALUES (?, ?, ?, ?, ?)",
				f.attempt.id,
				f.attempt.generation,
				`heartbeat-${beat}`,
				JSON.stringify([f.attempt.epoch, f.attempt.generation, f.attempt.worker, 5_000]),
				JSON.stringify(f.attempt),
			);
		await f.database.run("UPDATE wf_runs_pool_meta SET version = 1");

		const database = await openNodeSqliteDatabase(f.path);
		const journal = await SqlRunJournal.open(database);
		const resumed = await openSqlPoolQueue(journal);
		const projection = await JournalDurableBackend.open(journal, { ownsJournal: false });
		try {
			assert.equal((await database.get("SELECT version FROM wf_runs_pool_meta"))?.version, 2);
			const operations = await database.all("SELECT operation, request FROM wf_runs_pool_operations ORDER BY rowid");
			assert.deepEqual(
				operations.map((row) => row.operation),
				["create", "v1-append"],
			);
			assert.ok(operations.every((row) => /^[0-9a-f]{64}$/.test(String(row.request))));
			assert.deepEqual(await resumed.commit(f.lease, f.attempt, "create", createSession), created);
			await assert.rejects(
				resumed.commit(f.lease, f.attempt, "create", { ...createSession, entries: [] }),
				/identity conflict/,
			);

			const handle = projection.getWorkflow("root")!;
			const child = durableWorkflowRunSnapshots(projection, handle).find((snapshot) => snapshot.id === run.runId);
			assert.equal(child?.stages[0]?.sessionId, "session");
			assert.equal(projection.getStageSession("root", stage.replayKey)?.sessionId, "session");

			await database.run("UPDATE wf_leases SET renewed_at = 0");
			const takeover = await journal.takeoverExpired("root", "replacement-coordinator", 60_000);
			if (takeover.status !== "acquired") assert.fail("No takeover");
			assert.equal(await resumed.releasePreviousIncarnations(takeover.lease), 1);
			const next = await resumed.claim(takeover.lease, "replacement-worker", [work], 60_000);
			assert.equal(next?.generation, f.attempt.generation + 1);
			const append = {
				kind: "session-append" as const,
				sessionId: "session",
				entries: [{ ...messages[0]!, id: "v2-append", parentId: "v1-append" }],
				expectSeq: 2,
			};
			assert.equal((await resumed.commit(takeover.lease, next!, "continue", append)).lastSeq, 3);
			assert.deepEqual(
				(await sessions.load("session")).entries.map((entry) => entry.id),
				["message", "v1-append", "v2-append"],
			);
		} finally {
			await projection.close();
			await journal.close();
			await database.close();
		}
	} finally {
		await sessions.close();
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

test("completed child result survives a lost acknowledgement and fences later writes (#3869)", async () => {
	const f = await fixture();
	try {
		await f.pool.commit(f.lease, f.attempt, "saved", { kind: "checkpoint", checkpoint });
		const result = {
			runId: work.childRunId,
			status: "completed",
			result: { saved: true },
			stages: [],
			toolNodes: [],
		};
		await f.pool.complete(f.lease, f.attempt, result);
		await f.pool.complete(f.lease, f.attempt, result);
		assert.deepEqual(await f.pool.result("root", f.attempt.id), result);
		assert.equal((await f.pool.inspect("root"))[0]!.state, "completed");
		assert.equal(await f.pool.claim(f.lease, "another", [work], 60_000), undefined);
		await assert.rejects(
			f.pool.commit(f.lease, f.attempt, "late", { kind: "checkpoint", checkpoint }),
			/Stale work lease/,
		);
		await assert.rejects(f.pool.complete(f.lease, f.attempt, { ...result, status: "failed" }), /identity conflict/);
	} finally {
		await f.close();
	}
});

test.each(["completed", "failed"] as const)(
	"a billed %s stage checkpoint charges its usage with the commit, once, without any usage report (#3869)",
	async (status) => {
		const f = await fixture();
		try {
			const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.5 };
			const { sessionId: _session, ...unsessioned } = stage;
			const billed = {
				...unsessioned,
				checkpointId: `${work.scope}:session:billed`,
				topology: { ...stage.topology, status },
				...(status === "completed" ? { output: "done" } : {}),
				modelAttempts: [{ model: "fixture", success: status === "completed", usage }],
			};
			const mutation = { kind: "checkpoint" as const, checkpoint: billed };
			const ledger = await openSqlPoolUsage(f.journal);
			await f.pool.commit(f.lease, f.attempt, "billed", mutation);
			assert.deepEqual(await ledger.total("root"), usage);
			const recoveredDatabase = await openNodeSqliteDatabase(f.path);
			const recoveredJournal = await SqlRunJournal.open(recoveredDatabase);
			try {
				const recoveredLedger = await openSqlPoolUsage(recoveredJournal);
				assert.deepEqual(await recoveredLedger.total("root"), usage, "checkpoint usage survives reopening");
			} finally {
				await recoveredJournal.close();
				await recoveredDatabase.close();
			}
			await f.pool.commit(f.lease, f.attempt, "billed", mutation);
			assert.deepEqual(await ledger.total("root"), usage, "a retried commit does not recharge");
			assert.deepEqual(
				await ledger.report(f.lease, f.attempt, [{ key: poolStageUsageKey(run.runId, "stage"), usage }]),
				usage,
				"the late heartbeat report for the same stage does not double-charge",
			);
			await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.attempt.id);
			assert.equal(await f.pool.expire(f.lease, f.attempt), true);
			const replacement = await f.pool.claim(f.lease, "replacement", [work], 60_000);
			assert.ok(replacement);
			await f.pool.commit(f.lease, replacement, "billed-again", mutation);
			assert.deepEqual(
				await ledger.total("root"),
				usage,
				"a replacement recommitting the checkpoint does not recharge",
			);
		} finally {
			await f.close();
		}
	},
);

test("a replacement generation re-recording a checkpoint at a later time keeps the first write", async () => {
	const f = await fixture();
	try {
		const { sessionId: _session, ...cached } = stage;
		const replayed = {
			...cached,
			checkpointId: `${work.scope}:stage-replay-meta:h0`,
			completedAt: Date.now() - 1_000,
			output: "draft",
		};
		const first = await f.pool.commit(f.lease, f.attempt, "replay", { kind: "checkpoint", checkpoint: replayed });
		await f.database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", f.attempt.id);
		assert.equal(await f.pool.expire(f.lease, f.attempt), true);
		const replacement = await f.pool.claim(f.lease, "replacement", [work], 60_000);
		assert.ok(replacement);
		const later = { ...replayed, completedAt: Date.now() };
		assert.deepEqual(
			await f.pool.commit(f.lease, replacement, "replay-again", { kind: "checkpoint", checkpoint: later }),
			{ seq: first.seq, at: first.at },
		);
		await assert.rejects(
			f.pool.commit(f.lease, replacement, "diverged", {
				kind: "checkpoint",
				checkpoint: { ...later, output: "different" },
			}),
			/Pool checkpoint identity conflict/,
		);
		await f.backend.hydrateWorkflow("root");
		const recorded = f.backend
			.listCheckpoints("root")
			.filter((entry) => entry.checkpointId === replayed.checkpointId);
		assert.deepEqual(recorded, [replayed]);
	} finally {
		await f.close();
	}
});
