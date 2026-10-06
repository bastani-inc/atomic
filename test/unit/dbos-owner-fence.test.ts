import assert from "node:assert/strict";
import { Client, Pool, type PoolClient, type QueryResult } from "pg";
import { test, vi } from "vitest";
import { DbosOwnerFence } from "../../packages/workflows/src/durable/dbos-owner-fence.js";

test("failed owner acquisition retires the generation so explicit recovery can create a successor (#3419)", async () => {
	const pool = new Pool();
	const connect = vi.spyOn(pool, "connect").mockRejectedValue(new Error("connection refused"));
	const fence = new DbosOwnerFence(
		() => pool,
		"atomic-db-11111111-1111-4111-8111-111111111111",
		() => pool.end(),
	);
	try {
		await assert.rejects(
			fence.write("run", async () => {}),
			/connection refused/,
		);
		assert.equal(fence.invalidated, true);
		await assert.rejects(
			fence.write("run", async () => {}),
			/ownership connection was lost/,
		);
		assert.equal(connect.mock.calls.length, 1);
	} finally {
		connect.mockRestore();
		await fence.close();
	}
});

async function acquiredOwnerFence(initialize = true) {
	const owner = Object.assign(new Client(), { release: vi.fn() });
	const guard = Object.assign(new Client(), { release: vi.fn() });
	for (const client of [owner, guard]) {
		vi.spyOn(client, "query").mockImplementation(
			async (): Promise<QueryResult<{ held: boolean }>> => ({
				rows: [{ held: true }],
				rowCount: 1,
				command: "SELECT",
				oid: 0,
				fields: [],
			}),
		);
	}
	const pool = new Pool();
	vi.spyOn(pool, "connect")
		.mockImplementation(async (): Promise<PoolClient> => guard)
		.mockImplementationOnce(async (): Promise<PoolClient> => owner)
		.mockImplementationOnce(async (): Promise<PoolClient> => guard);
	const endPool = vi.fn(async () => {});
	const fence = new DbosOwnerFence(() => pool, "atomic-db-11111111-1111-4111-8111-111111111111", endPool);
	if (initialize) await fence.write("run", async () => {});
	return { owner, guard, pool, endPool, fence };
}

test("close waits for owner connection termination before allowing recovery (#3489)", async () => {
	const { owner, pool, endPool, fence } = await acquiredOwnerFence();
	let closed = false;
	const closing = fence.close().then(() => {
		closed = true;
	});
	try {
		assert.equal(fence.invalidated, true);
		assert.equal(fence.close(), fence.close());
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(owner.release.mock.calls, [[true]]);
		assert.equal(closed, false, "close must not resolve while the owner backend is still terminating");
	} finally {
		owner.emit("end");
		await closing;
		await pool.end();
	}
	assert.equal(closed, true);
	assert.equal(endPool.mock.calls.length, 1);
});

test.each(["ended", "errored", "synchronous"])("close handles an %s owner connection (#3489)", async (state) => {
	const { owner, pool, endPool, fence } = await acquiredOwnerFence();
	if (state === "ended") owner.emit("end");
	if (state === "errored") owner.emit("error", new Error("connection lost"));
	owner.release.mockImplementation(() => {
		if (state === "synchronous") owner.emit("end");
		if (state === "errored") queueMicrotask(() => owner.emit("end"));
	});
	try {
		await fence.close();
		assert.deepEqual(owner.release.mock.calls, [[true]]);
		assert.equal(endPool.mock.calls.length, 1);
		assert.equal(owner.listenerCount("end"), 1);
	} finally {
		await pool.end();
	}
});

test("close rejects if owner termination cannot be confirmed and still closes the pool (#3489)", async () => {
	const { owner, pool, endPool, fence } = await acquiredOwnerFence();
	vi.useFakeTimers();
	try {
		const closing = fence.close();
		const rejected = assert.rejects(closing, /ownership connection did not terminate within 5000ms/);
		await vi.runAllTimersAsync();
		await rejected;
		assert.equal(fence.close(), closing);
		assert.equal(endPool.mock.calls.length, 1);
		assert.equal(owner.listenerCount("end"), 1);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		vi.useRealTimers();
		owner.emit("end");
		await pool.end();
	}
});

test("close waits for a partially initialized owner to terminate (#3489)", async () => {
	const { owner, pool, fence } = await acquiredOwnerFence(false);
	const successfulQuery = async (): Promise<QueryResult<{ held: boolean }>> => ({
		rows: [{ held: true }],
		rowCount: 1,
		command: "SELECT",
		oid: 0,
		fields: [],
	});
	vi.mocked(owner.query)
		.mockImplementationOnce(successfulQuery)
		.mockImplementationOnce(successfulQuery)
		.mockImplementationOnce(successfulQuery)
		.mockImplementationOnce(async () => {
			throw new Error("initialization failed after lock acquisition");
		});
	const writing = assert.rejects(
		fence.write("run", async () => {}),
		/initialization failed/,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	let closed = false;
	const closing = fence.close().then(() => {
		closed = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(owner.release.mock.calls, [[true]]);
		assert.equal(closed, false, "failed initialization must not hide a terminating owner");
	} finally {
		owner.emit("end");
		await Promise.all([writing, closing]);
		await pool.end();
	}
});

test("close waits for destroyed protected SQL clients holding executor locks (#3489)", async () => {
	const { owner, guard, pool, fence } = await acquiredOwnerFence();
	const sqlPool = new Pool();
	vi.spyOn(sqlPool, "connect").mockImplementation(async (): Promise<PoolClient> => guard);
	fence.protectPool(sqlPool);
	await fence.write("run", async () => {
		const client = await sqlPool.connect();
		client.release();
	});
	owner.release.mockImplementation(() => {
		owner.emit("end");
	});
	let closed = false;
	const closing = fence.close().then(() => {
		closed = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closed, false, "protected SQL backend termination must precede close completion");
	} finally {
		guard.emit("end");
		await closing;
		await Promise.all([pool.end(), sqlPool.end()]);
	}
});

test.each([1, 2])("close terminates protected SQL while shared lock %s is pending (#3489)", async (pendingLock) => {
	const { owner, pool, fence } = await acquiredOwnerFence();
	const sql = Object.assign(new Client(), { release: vi.fn() });
	const sqlPool = new Pool();
	vi.spyOn(sqlPool, "connect").mockImplementation(async (): Promise<PoolClient> => sql);
	fence.protectPool(sqlPool);
	let resumeLock = () => {};
	let lockStarted = () => {};
	const started = new Promise<void>((resolve) => {
		lockStarted = resolve;
	});
	const resumed = new Promise<void>((resolve) => {
		resumeLock = resolve;
	});
	let locks = 0;
	vi.spyOn(sql, "query").mockImplementation(async (text: string): Promise<QueryResult<{ held: boolean }>> => {
		if (text.includes("pg_try_advisory_lock_shared") && ++locks === pendingLock) {
			lockStarted();
			await resumed;
		}
		return { rows: [{ held: true }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
	});
	owner.release.mockImplementation(() => owner.emit("end"));
	const writing = assert.rejects(
		fence.write("run", async () => {
			await sqlPool.connect();
		}),
		/ownership connection was lost/,
	);
	await started;
	let closed = false;
	const closing = fence.close().then(() => {
		closed = true;
	});
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closed, false, "pending lock SQL must not escape the close termination barrier");
		assert.deepEqual(sql.release.mock.calls, [[true]]);
		sql.emit("end");
		await closing;
		assert.equal(closed, true, "close must not depend on delivery of the pending lock result");
	} finally {
		resumeLock();
		sql.emit("end");
		await Promise.all([writing, closing]);
		await Promise.all([pool.end(), sqlPool.end()]);
	}
	assert.deepEqual(sql.release.mock.calls, [[true]], "late acquisition failure must not release twice");
});
