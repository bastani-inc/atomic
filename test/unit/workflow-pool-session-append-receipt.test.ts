import assert from "node:assert/strict";
import type { SessionStore } from "@bastani/atomic/storage";
import { test } from "vitest";
import type { DurableWorkflowBackend } from "../../packages/workflows/src/durable/backend.js";
import type { PoolMutation } from "../../packages/workflows/src/durable/journal/pool-mutations.js";
import type { PoolCommitReceipt } from "../../packages/workflows/src/durable/journal/sql-pool-queue.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { poolWorkerCommit } from "../../packages/workflows/src/workers/pool-commit.js";
import { workerSessionStore } from "../../packages/workflows/src/workers/session-store.js";

function signal(): { readonly fired: Promise<void>; fire(): void } {
	let fire = () => {};
	const fired = new Promise<void>((resolve) => {
		fire = resolve;
	});
	return { fired, fire };
}

/**
 * A coordinator that commits at once, and a root-journal catch-up that reports when it starts and then stays
 * held until the test releases it, standing in for a catch-up slowed by journal contention.
 */
function heldCatchUp() {
	const sent: PoolMutation[] = [];
	const started = signal();
	const released = signal();
	let catchUps = 0;
	const commit = poolWorkerCommit({
		send: async (mutation): Promise<PoolCommitReceipt> => {
			sent.push(mutation);
			return mutation.kind === "session-append" ? { at: 1, lastSeq: 7 } : { seq: 3, at: 1 };
		},
		catchUp: async () => {
			catchUps++;
			started.fire();
			await released.fired;
		},
	});
	return { sent, started, released, commit, catchUps: () => catchUps };
}

test("a pooled session append is acknowledged once the coordinator commits it, without a root-journal catch-up (#3983)", async () => {
	const pool = heldCatchUp();
	const sessions = workerSessionStore({
		reader: { descriptor: { adapter: "sqlite", location: "pool" } } as SessionStore,
		backend: {} as DurableWorkflowBackend,
		store: createStore(),
		root: "root",
		commit: pool.commit,
	});
	try {
		// An Intercom inbox save is a session append, and the broker waits a bounded time for its confirmation.
		const appended = sessions.append("session", [], { expectSeq: 6 });
		const first = await Promise.race([appended, pool.started.fired.then(() => "waiting on catch-up" as const)]);
		assert.deepEqual(first, { lastSeq: 7 });
		assert.equal(pool.catchUps(), 0);
		assert.deepEqual(
			pool.sent.map((mutation) => mutation.kind),
			["session-append"],
		);
	} finally {
		pool.released.fire();
	}
});

test("a pooled checkpoint commit still waits for the root-journal catch-up before it resolves (#3983)", async () => {
	const pool = heldCatchUp();
	let resolved = false;
	const committed = pool
		.commit({
			kind: "checkpoint",
			checkpoint: {
				kind: "tool",
				workflowId: "root",
				checkpointId: "checkpoint",
				name: "tool",
				argsHash: "hash",
				output: null,
				completedAt: 1,
			},
		})
		.then((receipt) => {
			resolved = true;
			return receipt;
		});
	await pool.started.fired;
	assert.equal(resolved, false);
	pool.released.fire();
	assert.deepEqual(await committed, { seq: 3, at: 1 });
	assert.equal(pool.catchUps(), 1);
});
