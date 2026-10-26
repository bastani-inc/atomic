import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const RECOVERY_LEASE_MS = 10 * 60_000;
const [mode, path] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });
const input = lines[Symbol.asyncIterator]();
const receive = async () => {
	const next = await input.next();
	assert.equal(next.done, false, "Control channel closed unexpectedly");
	return JSON.parse(next.value);
};
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === "worker") {
	send({ event: "request" });
	assert.equal((await receive()).event, "acknowledged");
	send({ event: "acknowledged" });
	process.exit(0);
}

const jiti = createJiti(import.meta.url, { fsCache: false });
const load = (relative) => jiti.import(fileURLToPath(new URL(relative, import.meta.url)));
const { openNodeSqliteDatabase } = await load("../../packages/coding-agent/src/core/storage/node-sqlite.ts");
const { SqlRunJournal } = await load("../../packages/workflows/src/durable/journal/sql-run-journal.ts");
const { openSqlPoolQueue } = await load("../../packages/workflows/src/durable/journal/sql-pool-queue.ts");
const { JournalDurableBackend } = await load("../../packages/workflows/src/durable/journal/journal-backend.ts");
const { StorageProvider } = await import("@bastani/atomic/storage");
const { poolWorkFixture } = await load("../helpers/pool-journal.ts");
const { work, boundary } = poolWorkFixture();
const run = boundary.topology.boundary.child;
const checkpoint = {
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
	kind: "stage",
	workflowId: "root",
	checkpointId: `${work.scope}:session:0`,
	name: "stage",
	replayKey: `${work.scope}:stage`,
	sessionId: "session",
	completedAt: 1,
	topology: { version: 1, stageId: "stage", parentIds: [], sourceOrder: 0, run },
};
const messages = [
	{
		type: "message",
		id: "message",
		parentId: null,
		timestamp: "2026-01-01T00:00:00Z",
		message: { role: "user", content: "durable prompt", timestamp: 1 },
	},
];
const database = await openNodeSqliteDatabase(path);
const journal = await SqlRunJournal.open(database);
const pool = await openSqlPoolQueue(journal);
try {
	if (mode === "coordinator") {
		const registrar = await JournalDurableBackend.open(journal, { ownsJournal: false });
		await registrar.commitWorkflowRegistration({
			workflowId: "root",
			name: "root",
			inputs: {},
			createdAt: 0,
			status: "running",
		});
		await registrar.close();
		const acquired = await journal.acquire("root", "coordinator");
		assert.equal(acquired.status, "acquired");
		const lease = acquired.lease;
		await pool.initialize(lease, RECOVERY_LEASE_MS);
		await pool.enqueue(lease, work, boundary);
		const attempt = await pool.claim(lease, "worker", [work], RECOVERY_LEASE_MS);
		assert.ok(attempt);
		send({ event: "ready", lease, attempt });
		assert.equal((await receive()).event, "request");
		const saved = await pool.commit(lease, attempt, "save", { kind: "checkpoint", checkpoint });
		const create = {
			kind: "session-create",
			checkpoint: stage,
			header: { id: "session", version: 4, createdAt: messages[0].timestamp, cwd: process.cwd() },
			entries: messages,
		};
		const transact = database.transaction.bind(database);
		database.transaction = async (body) => {
			const receipt = await transact(body);
			send({ event: "committed", saved, created: receipt, create });
			assert.equal((await receive()).event, "release-ack");
			return receipt;
		};
		const created = await pool.commit(lease, attempt, "create", create);
		send({ event: "acknowledged", saved, created });
	} else {
		assert.equal(mode, "recover");
		const { ready, committed, crashed } = await receive();
		const { lease, attempt } = ready;
		const { saved, created, create } = committed;
		assert.notEqual(process.cwd(), create.header.cwd);
		const sessions = await new StorageProvider().openSessionStore(
			{ kind: "database", database, prefix: "wf_runs_pool_" },
			{ agentDir: process.cwd(), domain: "sessions" },
		);
		const backend = await JournalDurableBackend.open(journal, { ownsJournal: false });
		try {
			const rows = await database.all("SELECT operation, receipt FROM wf_runs_pool_operations ORDER BY operation");
			assert.deepEqual(
				rows.map((row) => [row.operation, JSON.parse(row.receipt)]),
				[
					["create", created],
					["save", saved],
				],
			);
			const snapshot = async () => {
				await backend.hydrateWorkflow("root");
				const events = [];
				for await (const entry of journal.read("root")) events.push(entry);
				return { events, session: await sessions.load("session") };
			};
			const before = await snapshot();
			assert.equal(before.events.length, 4);
			assert.deepEqual(backend.getToolOutput("root", checkpoint.argsHash), { saved: true });
			assert.deepEqual(before.session.entries, messages);
			assert.equal(before.session.lastSeq, 1);
			assert.deepEqual(
				backend.listCheckpoints("root").find((entry) => entry.checkpointId === stage.checkpointId),
				stage,
			);
			let coordinator = lease;
			if (crashed === "coordinator") {
				await database.run("UPDATE wf_leases SET renewed_at = 0 WHERE run_id = ?", "root");
				const takeover = await journal.takeoverExpired("root", "replacement-coordinator", RECOVERY_LEASE_MS);
				assert.equal(takeover.status, "acquired");
				coordinator = takeover.lease;
				assert.equal(coordinator.epoch, lease.epoch + 1);
			} else {
				assert.deepEqual(await pool.commit(lease, attempt, "save", { kind: "checkpoint", checkpoint }), saved);
				assert.deepEqual(await pool.commit(lease, attempt, "create", create), created);
				await database.run("UPDATE wf_runs_work SET expires_at = 0 WHERE id = ?", attempt.id);
			}
			const lateCheckpoint = {
				...checkpoint,
				checkpointId: `${work.scope}:late`,
				argsHash: `${work.scope}:late`,
				output: "stale",
				topology: { ...checkpoint.topology, nodeId: "late" },
			};
			const lateSession = {
				kind: "session-replace",
				checkpoint: { ...stage, checkpointId: `${work.scope}:late-session` },
				header: create.header,
				entries: [],
				expectSeq: 1,
			};
			const rejectStale = async (authority, error = /Stale work lease$/) => {
				await assert.rejects(
					pool.commit(authority, attempt, "late-checkpoint", { kind: "checkpoint", checkpoint: lateCheckpoint }),
					error,
				);
				await assert.rejects(pool.commit(authority, attempt, "late-session", lateSession), error);
				assert.deepEqual(await snapshot(), before);
			};
			if (crashed === "coordinator") await rejectStale(lease, /Stale lease/);
			await rejectStale(coordinator);
			assert.equal(await pool.expire(coordinator, attempt), true);
			// A replacement coordinator's root re-enqueues its child before any worker may claim it (#3979).
			await pool.enqueue(coordinator, work, boundary);
			const replacement = await pool.claim(coordinator, attempt.worker, [work], RECOVERY_LEASE_MS);
			assert.ok(replacement);
			assert.equal(replacement.generation, attempt.generation + 1);
			assert.equal(replacement.epoch, coordinator.epoch);
			await rejectStale(coordinator);
			assert.deepEqual(
				await pool.commit(coordinator, replacement, "save", { kind: "checkpoint", checkpoint }),
				saved,
			);
			const append = {
				kind: "session-append",
				sessionId: "session",
				entries: [{ ...messages[0], id: "continued", parentId: "message" }],
				expectSeq: 1,
			};
			const continued = await pool.commit(coordinator, replacement, "continue", append);
			assert.equal(continued.lastSeq, 2);
			assert.deepEqual(await pool.commit(coordinator, replacement, "continue", append), continued);
			assert.deepEqual((await sessions.load("session")).entries, [...messages, ...append.entries]);
			const nextCheckpoint = {
				...checkpoint,
				checkpointId: `${work.scope}:tool:2`,
				argsHash: `${work.scope}:next`,
				output: "continued",
				topology: { ...checkpoint.topology, nodeId: "next" },
			};
			await pool.commit(coordinator, replacement, "next", { kind: "checkpoint", checkpoint: nextCheckpoint });
			await backend.hydrateWorkflow("root");
			assert.equal(backend.getToolOutput("root", nextCheckpoint.argsHash), "continued");
			send({ event: "recovered", generation: replacement.generation, epoch: replacement.epoch });
		} finally {
			await sessions.close();
			await backend.close();
		}
	}
} finally {
	await journal.close();
	await database.close();
	lines.close();
	process.stdin.destroy();
}
