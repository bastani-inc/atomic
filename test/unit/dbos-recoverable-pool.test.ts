import assert from "node:assert/strict";
import { Client, Pool, type PoolClient } from "pg";
import { test, vi } from "vitest";
import { isDbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import {
	PostgresHealth,
	type PostgresHealthIdentity,
} from "../../packages/workflows/src/durable/dbos-postgres-health.js";
import { createRecoverablePostgresPool } from "../../packages/workflows/src/durable/dbos-recoverable-pool.js";

const initialUrl = "postgresql://fixture:unused@127.0.0.1:1/isolated?connect_timeout=3&sslmode=disable";
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function client() {
	return Object.assign(new Client(), { release: vi.fn() });
}
function fixture() {
	const physical: {
		pool: Pool;
		client: PoolClient;
		release: ReturnType<typeof vi.fn>;
		connect: ReturnType<typeof vi.fn<() => Promise<PoolClient>>>;
		end: ReturnType<typeof vi.fn<() => Promise<void>>>;
	}[] = [];
	const createPool = (url: string) => {
		const pool = new Pool({ connectionString: url });
		const borrowed = client();
		const release = borrowed.release;
		const connect = vi.fn(async () => {
			// pg assigns a fresh release function for each checkout, including reborrows.
			borrowed.release = release;
			return borrowed;
		});
		const end = vi.fn(async () => {});
		pool.connect = connect as Pool["connect"];
		pool.end = end as Pool["end"];
		physical.push({ pool, client: borrowed, release, connect, end });
		return pool;
	};
	return { physical, createPool };
}

// #3074: an old borrow must not prevent existing SDK consumers from reconnecting.
test("invalidation rotates physical pools without waiting for an obsolete pool to drain", async () => {
	const f = fixture();
	const draining = deferred<void>();
	const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool });
	const first = await pool.connect();
	f.physical[0].end.mockReturnValue(draining.promise);
	invalidate();
	const next = await pool.connect();
	assert.notEqual(next, first);
	assert.equal(f.physical[0].end.mock.calls.length, 1);
	assert.equal(f.physical.length, 2);
	first.release();
	next.release();
	draining.resolve();
	await pool.end();
	assert.equal(pool.ended, true);
});

// #3074: both public pg connect forms must borrow only from the current generation.
for (const operation of ["invalidate", "end"] as const) {
	test(`a connection acquired after ${operation} is destroyed rather than returned`, async () => {
		const f = fixture();
		const onEnd = vi.fn();
		const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool, onEnd });
		const pending = deferred<PoolClient>();
		f.physical[0].connect.mockReturnValue(pending.promise);
		const result = new Promise<Error | undefined>((resolve) => {
			pool.connect((error, borrowed, done) => {
				assert.equal(borrowed, undefined);
				done();
				resolve(error);
			});
		});
		if (operation === "end") await pool.end();
		else invalidate();
		pending.resolve(f.physical[0].client);
		assert.match((await result)?.message ?? "", /pool changed/);
		assert.deepEqual(vi.mocked(f.physical[0].client.release).mock.calls, [[true]]);
		await pool.end();
		assert.equal(onEnd.mock.calls.length, 1);
	});
}

test("health-selected endpoint replaces the pool without changing its public object", async () => {
	const f = fixture();
	let url = initialUrl;
	const beforeConnect = vi.fn(async () => url);
	const { pool } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool, beforeConnect });
	(await pool.connect()).release();
	url = initialUrl.replace(":1/", ":2/");
	await new Promise<void>((resolve, reject) => {
		pool.connect((error, borrowed, done) => {
			if (error) return reject(error);
			assert.equal(borrowed, f.physical[1].client);
			done();
			resolve();
		});
	});
	assert.equal(pool.options.connectionString, url);
	assert.equal(beforeConnect.mock.calls.length, 2);
	assert.equal(f.physical[0].end.mock.calls.length, 1);
	await pool.end();
});

test("end during a health check cannot open a late physical connection", async () => {
	const f = fixture();
	const check = deferred<string>();
	const { pool } = createRecoverablePostgresPool(initialUrl, {
		createPool: f.createPool,
		beforeConnect: () => check.promise,
	});
	const pending = pool.connect();
	await new Promise<void>((resolve) => pool.end(resolve));
	check.resolve(initialUrl);
	await assert.rejects(pending, /after calling end/);
	assert.equal(f.physical[0].connect.mock.calls.length, 0);
	assert.equal(f.physical.length, 1);
});

test("idle connection errors invalidate only the current pool and remain handled without SDK listeners", async () => {
	const f = fixture();
	const onConnectionError = vi.fn();
	const { pool } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool, onConnectionError });
	const error = new Error("Connection terminated unexpectedly");
	f.physical[0].pool.emit("error", error, f.physical[0].client);
	assert.deepEqual(onConnectionError.mock.calls, [[error]]);
	(await pool.connect()).release();
	f.physical[0].pool.emit("error", error, f.physical[0].client);
	assert.equal(onConnectionError.mock.calls.length, 1);
	assert.equal(f.physical[1].end.mock.calls.length, 0);
	await pool.end();
});

test("failed connects retire their generation without retrying the operation", async () => {
	const f = fixture();
	const onConnectionError = vi.fn();
	const { pool } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool, onConnectionError });
	const failure = new Error("isolated connection refusal");
	f.physical[0].connect.mockRejectedValue(failure);
	await assert.rejects(pool.connect(), (error) => error === failure);
	assert.deepEqual(onConnectionError.mock.calls, [[failure]]);
	assert.equal(f.physical.length, 1);
	(await pool.connect()).release();
	assert.equal(f.physical.length, 2);
	await pool.end();
});

// #3072: the stable facade uses pg's query routing, not a retry wrapper around SQL.
test("promise and callback queries route through connect and never replay a failed mutation", async () => {
	const f = fixture();
	const { pool } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool });
	const result = { command: "SELECT", rowCount: 1, oid: 0, fields: [], rows: [{ value: 1 }] };
	const failure = new Error("mutation outcome unknown");
	const query = vi.spyOn(f.physical[0].client, "query").mockImplementation((_text, _values, callback) => {
		Reflect.apply(callback, undefined, [undefined, result]);
	});
	assert.deepEqual(await pool.query("SELECT 1"), result);
	await new Promise<void>((resolve, reject) => {
		pool.query("SELECT $1", [1], (error, value) => {
			if (error) return reject(error);
			assert.deepEqual(value, result);
			resolve();
		});
	});
	query.mockImplementation((_text, _values, callback) => {
		callback(failure, result);
	});
	await assert.rejects(pool.query("INSERT INTO effects VALUES (1)"), (error) => error === failure);
	assert.equal(query.mock.calls.length, 3);
	assert.equal(f.physical[0].connect.mock.calls.length, 3);
	assert.equal(f.physical.length, 1);
	assert.deepEqual(f.physical[0].release.mock.calls, [[undefined], [undefined], [failure]]);
	await pool.end();
});

test("configured pool keeps connection timeout and endpoint without opening a socket", async () => {
	const { pool } = createRecoverablePostgresPool(initialUrl);
	assert.equal(pool.options.connectionString, initialUrl);
	assert.equal(pool.options.connectionTimeoutMillis, 3000);
	assert.equal(pool.totalCount, 0);
	await pool.end();
});

test("health rejection fails callback acquisition without borrowing or feeding back connection failure", async () => {
	const f = fixture();
	const failure = new Error("managed identity mismatch");
	const onConnectionError = vi.fn();
	const { pool } = createRecoverablePostgresPool(initialUrl, {
		createPool: f.createPool,
		beforeConnect: async () => {
			throw failure;
		},
		onConnectionError,
	});
	await new Promise<void>((resolve) => {
		pool.connect((error, borrowed, done) => {
			assert.equal(error, failure);
			assert.equal(borrowed, undefined);
			done();
			resolve();
		});
	});
	assert.equal(f.physical[0].connect.mock.calls.length, 0);
	assert.equal(onConnectionError.mock.calls.length, 0);
	await pool.end();
});

test("invalidation evicts a held LISTEN client and notifies its error listener exactly once", async () => {
	const f = fixture();
	const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool });
	const held = await pool.connect();
	const released = deferred<void>();
	f.physical[0].release.mockImplementation(() => released.resolve());
	f.physical[0].end.mockReturnValue(released.promise);
	const reconnect = vi.fn((error: Error) => {
		assert.match(error.message, /dependency.*invalidated/i);
		held.release(true);
	});
	held.on("error", reconnect);
	invalidate();
	assert.equal(reconnect.mock.calls.length, 1);
	assert.deepEqual(f.physical[0].release.mock.calls, [[true]]);
	held.release();
	invalidate();
	assert.equal(f.physical[0].release.mock.calls.length, 1);
	const next = await pool.connect();
	assert.notEqual(next, held);
	next.release();
	await pool.end();
});

test("callback checkout release stays idempotent without disabling a future reborrow", async () => {
	const f = fixture();
	const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool });
	const done = await new Promise<(error?: Error | boolean) => void>((resolve, reject) => {
		pool.connect((error, borrowed, release) => {
			if (error) return reject(error);
			assert.equal(borrowed, f.physical[0].client);
			resolve(release);
		});
	});
	done();
	done(true);
	assert.equal(f.physical[0].release.mock.calls.length, 1);
	const reborrowed = await pool.connect();
	done(true);
	assert.equal(f.physical[0].release.mock.calls.length, 1);
	// No error listener: eviction must not throw an unhandled EventEmitter error.
	assert.doesNotThrow(invalidate);
	reborrowed.release();
	assert.deepEqual(f.physical[0].release.mock.calls, [[undefined], [true]]);
	await pool.end();
});

for (const mode of ["promise", "callback"] as const) {
	test(`invalidation rejects an active ${mode} mutation without replay`, async () => {
		const f = fixture();
		const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool });
		const started = deferred<void>();
		const query = vi.spyOn(f.physical[0].client, "query").mockImplementation(() => {
			started.resolve();
		});
		const pending =
			mode === "promise"
				? pool.query("INSERT INTO effects VALUES (1)")
				: new Promise((resolve, reject) => {
						pool.query("INSERT INTO effects VALUES (1)", (error, result) => {
							if (error) reject(error);
							else resolve(result);
						});
					});
		const rejected = assert.rejects(pending, /dependency.*invalidated/i);
		await started.promise;
		invalidate();
		await rejected;
		assert.deepEqual(f.physical[0].release.mock.calls, [[true]]);
		assert.equal(query.mock.calls.length, 1);
		assert.equal(f.physical.length, 1);
		(await pool.connect()).release();
		assert.equal(f.physical.length, 2);
		await pool.end();
	});
}

test("invalidation destroys every checkout including callback clients with no error listener", async () => {
	const f = fixture();
	const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool });
	const first = await pool.connect();
	const second = client();
	const secondRelease = second.release;
	f.physical[0].connect.mockResolvedValueOnce(second);
	const done = await new Promise<(error?: Error | boolean) => void>((resolve, reject) => {
		pool.connect((error, borrowed, release) => {
			if (error) return reject(error);
			assert.equal(borrowed, second);
			resolve(release);
		});
	});
	assert.doesNotThrow(invalidate);
	first.release();
	second.release();
	done(true);
	assert.deepEqual(f.physical[0].release.mock.calls, [[true]]);
	assert.deepEqual(secondRelease.mock.calls, [[true]]);
	await pool.end();
});

test("rejected socket identity releases the checkout without executing caller SQL", async () => {
	const f = fixture();
	const validate = vi.fn(async () => {
		throw new Error("foreign socket identity");
	});
	const { pool } = createRecoverablePostgresPool(initialUrl, { createPool: f.createPool, afterConnect: validate });
	const query = vi.spyOn(f.physical[0].client, "query");
	await assert.rejects(pool.query("INSERT INTO effects VALUES (1)"), /foreign socket identity/);
	assert.equal(validate.mock.calls.length, 1);
	assert.equal(query.mock.calls.length, 0);
	assert.deepEqual(f.physical[0].release.mock.calls, [[true]]);
	await pool.end();
});

test("invalidation during socket validation rejects its late checkout", async () => {
	const f = fixture();
	const validation = deferred<void>();
	const entered = deferred<void>();
	const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, {
		createPool: f.createPool,
		afterConnect: async () => {
			entered.resolve();
			await validation.promise;
		},
	});
	const pending = pool.connect();
	await entered.promise;
	invalidate();
	validation.resolve();
	await assert.rejects(pending, /pool changed during validation/);
	assert.deepEqual(f.physical[0].release.mock.calls, [[true]]);
	await pool.end();
});

test("socket errors during validation reject safely before the caller installs listeners", async () => {
	const f = fixture();
	const failure = new Error("socket failed during identity query");
	const { pool } = createRecoverablePostgresPool(initialUrl, {
		createPool: f.createPool,
		afterConnect: async (client) => {
			assert.doesNotThrow(() => client.emit("error", failure));
		},
	});
	await assert.rejects(pool.connect(), (error) => error === failure);
	assert.equal(f.physical[0].client.listenerCount("error"), 0);
	assert.deepEqual(f.physical[0].release.mock.calls, [[true]]);
	await pool.end();
});

test("a validation timeout destroys only the unanswered checkout and keeps concurrent ones", async () => {
	const held = client();
	const unanswered = client();
	const borrowed = [held, unanswered];
	const end = vi.fn(async () => {});
	const health = new PostgresHealth({
		probe: async () => ({ url: initialUrl, identity: "same" }),
		recover: async () => {},
		validate: async (candidate) => {
			if (candidate === unanswered) throw new Error("Query read timeout");
		},
	});
	const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, {
		afterConnect: (candidate) => health.validate(candidate),
		createPool: (url) => {
			const physical = new Pool({ connectionString: url });
			physical.connect = vi.fn(async () => borrowed.shift()!) as Pool["connect"];
			physical.end = end as Pool["end"];
			return physical;
		},
	});
	health.subscribe(invalidate);
	const heldRelease = held.release;
	const unansweredRelease = unanswered.release;
	const active = await pool.connect();
	const failure = await pool.connect().then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isDbosDependencyError(failure), true);
	assert.deepEqual(unansweredRelease.mock.calls, [[true]]);
	assert.equal(heldRelease.mock.calls.length, 0, "a healthy concurrent checkout must stay usable");
	assert.equal(end.mock.calls.length, 0, "the physical pool must not be retired for a slow query");
	active.release();
	assert.deepEqual(heldRelease.mock.calls, [[undefined]]);
	await health.stop();
	await pool.end();
});

const healthy: PostgresHealthIdentity = { url: initialUrl, identity: "same" };
test.each([
	{
		name: "a monitoring query read timeout",
		degraded: async (): Promise<PostgresHealthIdentity | undefined> => {
			throw new Error("Query read timeout");
		},
		releases: false,
	},
	...[
		new Error("timeout expired"),
		new Error("Connection terminated due to connection timeout"),
		Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
	].map((error) => ({
		name: `a monitoring connection timeout (${error.message})`,
		degraded: async (): Promise<PostgresHealthIdentity | undefined> => {
			throw error;
		},
		releases: false,
	})),
	{ name: "a lost monitoring answer", degraded: async () => undefined, releases: true },
	{
		name: "ECONNREFUSED",
		degraded: async (): Promise<PostgresHealthIdentity | undefined> => {
			throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
		},
		releases: true,
	},
	{
		name: "a 57P01 shutdown",
		degraded: async (): Promise<PostgresHealthIdentity | undefined> => {
			throw Object.assign(new Error("terminating connection"), { code: "57P01" });
		},
		releases: true,
	},
	{ name: "a changed server identity", degraded: async () => ({ ...healthy, identity: "new" }), releases: true },
])("$name during monitoring keeps held checkouts only when it is a timeout", async ({ degraded, releases }) => {
	const f = fixture();
	let outage = false;
	let recoveries = 0;
	let clock = 0;
	const health = new PostgresHealth({
		probe: async () => (outage ? degraded() : healthy),
		recover: async () => {
			recoveries++;
			outage = false;
		},
		now: () => clock,
		wait: async (ms) => {
			clock += ms;
		},
	});
	const { pool, invalidate } = createRecoverablePostgresPool(initialUrl, {
		createPool: f.createPool,
		beforeConnect: () => health.check(),
	});
	health.subscribe(invalidate);
	await pool.connect();
	outage = true;
	const next = await pool.connect().then(
		(borrowed) => ({ borrowed, error: undefined }),
		(error: unknown) => ({ borrowed: undefined, error }),
	);
	if (releases) {
		assert.notEqual(next.borrowed, undefined);
		assert.deepEqual(f.physical[0].release.mock.calls, [[true]]);
		assert.equal(f.physical.length, 2);
	} else {
		assert.equal(isDbosDependencyError(next.error), true);
		assert.equal(f.physical[0].release.mock.calls.length, 0, "a healthy held checkout must stay usable");
		assert.equal(f.physical[0].end.mock.calls.length, 0, "the physical pool must not be retired");
		assert.equal(recoveries, 0);
		outage = false;
		await pool.connect();
		assert.equal(f.physical.length, 1);
		assert.equal(f.physical[0].release.mock.calls.length, 0);
	}
	await health.stop();
	await pool.end();
});
