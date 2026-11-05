/**
 * A pool coordinator queues a forked child with the claims the root sends (#4321): an accepted claim gives the child's
 * work the fork's copy, and a refused one reaches the root as a `ForkSessionClaimError` in a JSON reply.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { SessionEntry } from "@bastani/atomic";
import { test } from "vitest";
import { ForkSessionClaimError, isForkSessionClaimError } from "../../packages/workflows/src/durable/fork-errors.js";
import { sqlPoolStorage } from "../../packages/workflows/src/durable/journal/internal.js";
import { poolTransactionSessionStore } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import { resolveRunJournal } from "../../packages/workflows/src/durable/journal/resolution.js";
import { openSqlPoolQueue } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import type { Lease } from "../../packages/workflows/src/durable/journal/types.js";
import {
	type CoordinatorEvent,
	type CoordinatorInbound,
	type CoordinatorReply,
	coordinatorReplyError,
} from "../../packages/workflows/src/workers/coordinator-protocol.js";
import { PoolCoordinator } from "../../packages/workflows/src/workers/pool-coordinator.js";
import { poolWorkFixture } from "../helpers/pool-journal.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const { work, boundary } = poolWorkFixture();
const REPLY_WAIT_MS = 10_000;
const copied: SessionEntry = {
	type: "message",
	id: "copied",
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	message: { role: "user", content: "copied", timestamp: 1 },
};

/** A coordinator in this process, reached only through its port with JSON messages, as the root reaches it. */
async function coordinator() {
	const directory = makeTempDirectory("pool-coordinator-claims-");
	const path = join(directory, "journal.sqlite");
	const journal = await resolveRunJournal({ journal: { path } });
	await journal.createRun({ runId: "root", name: "root", cwd: directory, createdAt: 0, status: "running" });
	const acquired = await journal.acquire("root", "root-holder");
	if (acquired.status !== "acquired") assert.fail("No root lease");
	const lease: Lease = acquired.lease;
	const storage = sqlPoolStorage(journal)!;
	const prefix = `${storage.tables.runs}_pool_`;
	const replies: CoordinatorReply[] = [];
	const listeners: ((message: CoordinatorInbound) => void)[] = [];
	// The coordinator lives as long as its port: it listens on it from construction.
	new PoolCoordinator({
		send: (message: CoordinatorEvent) => {
			const received = JSON.parse(JSON.stringify(message)) as CoordinatorEvent;
			if (received.kind === "reply") replies.push(received);
		},
		onMessage: (listener) => listeners.push(listener),
		onClose: () => {},
		close: async () => {},
	});
	let sequence = 0;
	const command = async (body: Record<string, unknown>): Promise<CoordinatorReply> => {
		const id = ++sequence;
		const message = JSON.parse(JSON.stringify({ ...body, id })) as CoordinatorInbound;
		for (const listener of listeners) listener(message);
		const deadline = Date.now() + REPLY_WAIT_MS;
		for (;;) {
			const reply = replies.find((candidate) => candidate.id === id);
			if (reply !== undefined) return reply;
			if (Date.now() > deadline) assert.fail(`no reply to ${String(body.kind)}`);
			await sleep(10);
		}
	};
	const prepared = await command({
		kind: "prepare",
		root: "root",
		lease,
		options: { journalPath: path, workers: 1, leaseMs: 30_000, heartbeatMs: 7_500, startupTimeoutMs: 30_000 },
	});
	assert.equal(prepared.error, undefined, prepared.error);
	const stageCopy = (id: string) =>
		storage.transaction(async (tx) => {
			const sessions = await poolTransactionSessionStore(tx, prefix);
			try {
				await sessions.create(
					{
						id,
						version: 4,
						createdAt: "2026-01-01T00:00:00Z",
						cwd: directory,
						parentSessionId: `source-of-${id}`,
						internal: true,
						workflow: { runId: work.childRunId, stageId: "stage", stageName: "stage" },
					},
					[copied],
				);
			} finally {
				await sessions.close();
			}
		});
	const owner = (session: string) =>
		storage.read((tx) => tx.get(`SELECT work FROM ${prefix}session_owners WHERE session = ?`, session));
	return {
		command,
		stageCopy,
		owner,
		queued: async () => (await openSqlPoolQueue(journal)).inspect("root"),
		async close() {
			await command({ kind: "close" });
			await journal.close();
			removeTempDirectory(directory);
		},
	};
}

const claim = (sessionId: string) => ({ sessionId, replayKey: `${work.scope}:stage`, runId: work.childRunId });

test("a coordinator gives the queued child's work the claimed copy, and refuses a missing one with a ForkSessionClaimError reply (#4321)", async () => {
	const c = await coordinator();
	try {
		await c.stageCopy("copy");
		const refused = await c.command({
			kind: "enqueue",
			descriptor: work,
			boundary,
			claimSessions: [claim("missing")],
		});
		assert.equal(refused.kind, "reply");
		assert.equal(refused.value, undefined);
		const error = coordinatorReplyError(refused);
		assert.ok(error instanceof ForkSessionClaimError);
		assert.ok(isForkSessionClaimError(error));
		assert.deepEqual(
			[error.code, error.reason, error.sessionId, error.rootRunId, error.childRunId, error.scope],
			["session-claim-refused", "missing", "missing", "root", work.childRunId, work.scope],
		);
		assert.equal(error.message, refused.error);
		assert.deepEqual(await c.queued(), [], "a refused claim queues nothing");

		const accepted = await c.command({ kind: "enqueue", descriptor: work, boundary, claimSessions: [claim("copy")] });
		assert.equal(accepted.error, undefined, accepted.error);
		const queued = (accepted.value as { readonly work: { readonly id: string } }).work;
		assert.equal((await c.owner("copy"))?.work, queued.id, "the child's work owns the fork's copy");
	} finally {
		await c.close();
	}
});

test("a coordinator queues a child without claims and gives it no session (#4321)", async () => {
	const c = await coordinator();
	try {
		await c.stageCopy("copy");
		const reply = await c.command({ kind: "enqueue", descriptor: work, boundary });
		assert.equal(reply.error, undefined, reply.error);
		assert.equal((await c.queued()).length, 1);
		assert.equal(await c.owner("copy"), undefined);
	} finally {
		await c.close();
	}
});

test("a coordinator's failure outside the fork family still reaches the root as its message only (#4321)", async () => {
	const c = await coordinator();
	try {
		const reply = await c.command({ kind: "enqueue", descriptor: { ...work, childRunId: "unrelated" }, boundary });
		assert.equal(reply.forkError, undefined);
		const error = coordinatorReplyError(reply);
		assert.equal(error.constructor, Error);
		assert.match(error.message, /boundary identity mismatch/);
	} finally {
		await c.close();
	}
});
