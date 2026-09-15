import assert from "node:assert/strict";
import { DBOSClient } from "@dbos-inc/dbos-sdk";
import { Client, Pool } from "pg";
import { afterEach, test, vi } from "vitest";
import {
	boundedAdmission,
	DbosDependencyError,
	dbosAdmissionContext,
} from "../../packages/workflows/src/durable/dbos-admission.js";
import { fenceDbosAdmissionPool } from "../../packages/workflows/src/durable/dbos-admission-pool.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// #3072: schema/authentication failures must retain actionable non-outage diagnostics.
for (const failureAt of ["connect", "query"] as const) {
	for (const [code, message] of [
		["42703", 'column "connection_id" does not exist'],
		["28P01", 'password authentication failed for user "test"'],
		["42501", 'permission denied for table "connections"'],
		["23505", 'duplicate key violates constraint "connection_key"'],
		["42601", 'syntax error near "connect"'],
		["22023", "invalid timeout parameter"],
		["40001", "serialization failure updating connection"],
		[undefined, "invalid timeout option"],
	] as const) {
		test(`${failureAt} preserves non-outage ${code ?? "code-less"} error identity and code`, async () => {
			const failure = Object.assign(new Error(message), { code });
			const pool = new Pool();
			const client = Object.assign(new Client(), { release: vi.fn() });
			vi.spyOn(client, "query").mockImplementation((...args: unknown[]) => {
				const callback = args.at(-1);
				assert.ok(typeof callback === "function");
				callback(failure);
			});
			vi.spyOn(pool, "connect").mockImplementation(async () => {
				if (failureAt === "connect") throw failure;
				return client;
			});
			fenceDbosAdmissionPool(pool);
			try {
				await assert.rejects(
					dbosAdmissionContext.run(new AbortController().signal, async () => {
						const acquired = await pool.connect();
						try {
							await acquired.query("SELECT 1");
						} finally {
							acquired.release();
						}
					}),
					(error) => {
						assert.equal(error, failure);
						assert.equal(failure.code, code);
						assert.equal(failure.message, message);
						return true;
					},
				);
				assert.deepEqual(client.release.mock.calls, failureAt === "query" ? [[undefined]] : []);
			} finally {
				await pool.end();
			}
		});
	}
}

// #3072: use the installed SDK's actual dbRetry path, but no socket or database.
for (const failureAt of ["connect", "query", "wrapped-connect", "wrapped-query"] as const) {
	test.each([
		["ECONNREFUSED", "connect ECONNREFUSED secret-endpoint"],
		["ECONNRESET", "socket reset"],
		["ECONNABORTED", "socket aborted"],
		["EHOSTUNREACH", "host unreachable"],
		["ENETUNREACH", "network unreachable"],
		["ETIMEDOUT", "socket timed out"],
		["ENOTFOUND", "DNS lookup failed"],
		["EAI_AGAIN", "DNS lookup temporarily failed"],
		["EPIPE", "broken pipe"],
		["08001", "SQL-client unable to establish SQL-connection"],
		["08006", "connection failure"],
		["53300", "too many clients"],
		["57P01", "administrator shutdown"],
		["57014", "canceling statement due to user request"],
		["40003", "statement completion unknown"],
		[undefined, "Connection terminated unexpectedly"],
		[undefined, "Connection terminated due to connection timeout"],
		[undefined, "Client has encountered a connection error and is not queryable"],
		[undefined, "timeout exceeded when trying to connect"],
	])(`SDK admission stops retrying after ${failureAt} failure: %s %s`, async (code, message) => {
		vi.useFakeTimers();
		const pool = new Pool();
		const refused = Object.assign(new Error(message), { code });
		const failure = failureAt.startsWith("wrapped") ? new AggregateError([refused], "wrapped") : refused;
		const client = Object.assign(new Client(), { release: vi.fn() });
		const query = vi.spyOn(client, "query").mockImplementation((...args: unknown[]) => {
			const callback = args.at(-1);
			assert.ok(typeof callback === "function", "the fenced pool uses pg's callback query overload");
			callback(failure);
		});
		const connect = vi.spyOn(pool, "connect").mockImplementation(async () => {
			if (failureAt.endsWith("connect")) throw failure;
			return client;
		});
		const sdk = await DBOSClient.create({
			systemDatabaseUrl: "postgresql://unused:unused@127.0.0.1:1/disposable",
			systemDatabasePool: fenceDbosAdmissionPool(pool),
		});
		try {
			await assert.rejects(
				boundedAdmission((signal) =>
					dbosAdmissionContext.run(signal, () =>
						sdk.enqueue({ workflowName: "isolated", queueName: "isolated", workflowID: "same-root" }),
					),
				),
				(error) => {
					assert.ok(error instanceof DbosDependencyError);
					assert.doesNotMatch(error.stack ?? "", /secret-endpoint|ECONNREFUSED/);
					assert.equal(error.cause, undefined);
					return true;
				},
			);
			const calls = query.mock.calls.length;
			await vi.advanceTimersByTimeAsync(120_000);
			assert.equal(connect.mock.calls.length, 1, "SDK must not retain a retry timer");
			assert.equal(query.mock.calls.length, calls);
		} finally {
			await sdk.destroy();
		}
	});
}

for (const pendingAt of ["connect", "query"] as const) {
	test(`abort fences late ${pendingAt} completion and releases only its client`, async () => {
		const pool = new Pool();
		const client = Object.assign(new Client(), { release: vi.fn() });
		const query = vi.spyOn(client, "query").mockImplementation(() => {});
		const connecting = Promise.withResolvers<typeof client>();
		vi.spyOn(pool, "connect").mockImplementation(async () => (pendingAt === "connect" ? connecting.promise : client));
		fenceDbosAdmissionPool(pool);
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const pending = dbosAdmissionContext.run(controller.signal, async () => {
			const acquiring = pool.connect();
			if (pendingAt === "connect") entered.resolve();
			const acquired = await acquiring;
			try {
				const querying = acquired.query("SELECT 1");
				entered.resolve();
				await querying;
			} finally {
				acquired.release();
			}
		});
		const rejected = assert.rejects(pending, DbosDependencyError);
		await entered.promise;
		controller.abort(new Error("ECONNRESET in caller cancellation must not reenter SDK retries"));
		await rejected;
		connecting.resolve(client);
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (pendingAt === "query") {
			const callback = query.mock.calls[0]?.at(-1);
			assert.equal(typeof callback, "function");
			if (typeof callback === "function")
				callback(new Error("late query rejection"), {
					command: "SELECT",
					rowCount: 0,
					oid: 0,
					fields: [],
					rows: [],
				});
		}
		assert.deepEqual(client.release.mock.calls, [[true]]);
		assert.equal(query.mock.calls.length, pendingAt === "query" ? 1 : 0);
		await pool.end();
	});
}

test("unscoped clients and successful admission leases remain usable after caller cancellation", async () => {
	const pool = new Pool();
	const client = Object.assign(new Client(), { release: vi.fn() });
	vi.spyOn(pool, "connect").mockImplementation(async () => client);
	fenceDbosAdmissionPool(pool);
	const caller = new AbortController();
	await boundedAdmission(
		(signal) =>
			dbosAdmissionContext.run(signal, async () => {
				const scoped = await pool.connect();
				scoped.release();
			}),
		caller.signal,
	);
	const unscoped = await pool.connect();
	assert.equal(unscoped, client, "another run's client must not inherit the completed admission fence");
	caller.abort();
	assert.deepEqual(client.release.mock.calls, [[undefined]], "released leases detach abort listeners");
	unscoped.release();
	await pool.end();
});

// #3072: deadline expiry must stop the real SDK before a late socket failure arrives.
test("admission deadline stops SDK retries after a late query failure", async () => {
	vi.useFakeTimers();
	const pool = new Pool();
	const client = Object.assign(new Client(), { release: vi.fn() });
	const query = vi.spyOn(client, "query").mockImplementation(() => {});
	const connect = vi.spyOn(pool, "connect").mockImplementation(async () => client);
	const sdk = await DBOSClient.create({
		systemDatabaseUrl: "postgresql://unused:unused@127.0.0.1:1/disposable",
		systemDatabasePool: fenceDbosAdmissionPool(pool),
	});
	try {
		const pending = boundedAdmission(
			(signal) =>
				dbosAdmissionContext.run(signal, () =>
					sdk.enqueue({ workflowName: "isolated", queueName: "isolated", workflowID: "same-root" }),
				),
			undefined,
			10,
		);
		const rejected = assert.rejects(pending, /admission timed out/);
		await vi.advanceTimersByTimeAsync(0);
		assert.equal(query.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(10);
		await rejected;
		assert.deepEqual(client.release.mock.calls, [[true]]);
		const callback = query.mock.calls[0]?.at(-1);
		assert.ok(typeof callback === "function", "the fenced pool uses pg's callback query overload");
		callback(Object.assign(new Error("late socket reset"), { code: "ECONNRESET" }), {
			command: "SELECT",
			rowCount: 0,
			oid: 0,
			fields: [],
			rows: [],
		});
		await vi.advanceTimersByTimeAsync(120_000);
		assert.equal(connect.mock.calls.length, 1, "SDK must not retry after the caller's deadline");
		assert.equal(query.mock.calls.length, 1);
		assert.deepEqual(client.release.mock.calls, [[true]]);
	} finally {
		await sdk.destroy();
	}
});
