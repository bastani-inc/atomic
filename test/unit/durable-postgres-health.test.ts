import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { test, vi } from "vitest";
import { isDbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";
import { PostgresHealth } from "../../packages/workflows/src/durable/dbos-postgres-health.js";

test("transient monitoring connection timeout preserves live consumers (#3246)", async () => {
	let probes = 0;
	let invalidations = 0;
	let recoveries = 0;
	const health = new PostgresHealth({
		probe: async () => {
			if (++probes === 2) throw new Error("timeout expired");
			return { url: "managed", identity: "same" };
		},
		recover: async () => {
			recoveries++;
		},
	});
	health.subscribe(() => invalidations++);
	assert.equal(await health.check(), "managed");
	assert.deepEqual(await Promise.all([health.check(), health.check()]), ["managed", "managed"]);
	assert.equal(probes, 3);
	assert.equal(invalidations, 0);
	assert.equal(recoveries, 0);
	await health.stop();
});

test("persistent monitoring connection failure still recovers an outage (#3246)", async () => {
	let probes = 0;
	let recoveries = 0;
	let invalidations = 0;
	const health = new PostgresHealth({
		probe: async () => {
			probes++;
			if (recoveries === 0) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
			return { url: "managed", identity: "same" };
		},
		recover: async () => {
			recoveries++;
		},
	});
	health.subscribe(() => invalidations++);
	assert.equal(await health.check(), "managed");
	assert.equal(probes, 3);
	assert.equal(recoveries, 1);
	assert.equal(invalidations, 1);
	await health.stop();
});

test.each([
	new Error("identity mismatch"),
	Object.assign(new Error("authentication failed"), { code: "28P01" }),
	Object.assign(new Error("statement timeout"), { code: "57014" }),
])("monitoring does not retry authoritative failure: %s (#3246)", async (failure) => {
	let probes = 0;
	let recoveries = 0;
	const health = new PostgresHealth({
		probe: async () => {
			probes++;
			throw failure;
		},
		recover: async () => {
			recoveries++;
		},
	});
	await assert.rejects(health.check(), (error) => error === failure);
	assert.equal(probes, 1);
	assert.equal(recoveries, 0);
	await health.stop();
});
test("a monitoring probe repeats once after a query read timeout without invalidating or recovering", async () => {
	let probes = 0;
	let recoveries = 0;
	let invalidations = 0;
	const health = new PostgresHealth({
		probe: async () => {
			if (++probes === 2) throw new Error("Query read timeout");
			return { url: "managed", identity: "same" };
		},
		recover: async () => {
			recoveries++;
		},
	});
	health.subscribe(() => invalidations++);
	assert.equal(await health.check(), "managed");
	assert.equal(await health.check(), "managed");
	assert.equal(probes, 3);
	assert.equal(recoveries, 0);
	assert.equal(invalidations, 0);
	assert.equal(health.lastFailure, undefined);
	await health.stop();
});

test("a persistent monitoring read timeout is a dependency failure that never invalidates or recovers", async () => {
	let slow = false;
	let probes = 0;
	let recoveries = 0;
	let invalidations = 0;
	let identity = "same";
	const health = new PostgresHealth({
		probe: async () => {
			probes++;
			if (slow) throw new Error("Query read timeout");
			return { url: "managed", identity };
		},
		recover: async () => {
			recoveries++;
		},
		wait: async () => {},
	});
	health.subscribe(() => invalidations++);
	assert.equal(await health.check(), "managed");
	slow = true;
	probes = 0;
	for (let round = 0; round < 3; round++) {
		const failure = await health.check().then(
			() => undefined,
			(error: unknown) => error,
		);
		assert.equal(isDbosDependencyError(failure), true);
	}
	assert.equal(probes, 6, "each check repeats the read-only probe exactly once");
	assert.match(health.lastFailure?.message ?? "", /did not answer a health check/);
	assert.equal(recoveries, 0);
	assert.equal(invalidations, 0);
	slow = false;
	assert.equal(await health.check(), "managed");
	assert.equal(recoveries, 0);
	assert.equal(invalidations, 0);
	slow = true;
	await assert.rejects(health.check());
	slow = false;
	identity = "restarted";
	assert.equal(await health.check(), "managed");
	assert.equal(invalidations, 1, "the identity known before the timeouts is still compared");
	assert.equal(recoveries, 0);
	await health.stop();
});

// #3074: health loss is shared by concurrent consumers, not a fresh startup per caller.
test("health loss invalidates before a single shared recovery and reconnects", async () => {
	let healthy = true;
	let recoveries = 0;
	const events: string[] = [];
	const health = new PostgresHealth({
		probe: async () => (healthy ? { url: "managed", identity: "1" } : undefined),
		recover: async () => {
			recoveries++;
			events.push("recover");
			healthy = true;
		},
		wait: async () => {},
	});
	health.subscribe(() => events.push("invalidate"));
	assert.equal(await health.check(), "managed");
	healthy = false;
	assert.deepEqual(await Promise.all([health.check(), health.check(), health.check()]), [
		"managed",
		"managed",
		"managed",
	]);
	assert.equal(recoveries, 1);
	assert.deepEqual(events, ["invalidate", "recover"]);
	assert.match(health.lastFailure?.message ?? "", /live health check/);
	await health.stop();
});

// A repaired installation must be retried automatically on the next bounded health check.
test("exhausted recovery retries after installation repair without a manual command", async () => {
	let healthy = false;
	let now = 0;
	let recoveries = 0;
	const waits: number[] = [];
	const health = new PostgresHealth({
		probe: async () => (healthy ? { url: "managed", identity: "1" } : undefined),
		recover: async () => {
			recoveries++;
			throw new Error("owned restart failed");
		},
		wait: async (ms) => {
			waits.push(ms);
		},
		now: () => now,
	});
	await assert.rejects(health.check(), /unavailable after bounded recovery/);
	assert.equal(health.lastFailure?.message, "owned restart failed");
	assert.equal(recoveries, 3);
	assert.deepEqual(waits, [250, 500]);
	await assert.rejects(health.check(), /cooling down/);
	assert.equal(recoveries, 3);
	now += 5_000;
	await assert.rejects(health.check(), /unavailable after bounded recovery/);
	assert.equal(recoveries, 6);
	healthy = true;
	assert.equal(await health.check(), "managed");
	assert.equal(health.lastFailure?.message, "owned restart failed");
	await health.stop();
});

test("identity failure invalidates but never grants recovery authority", async () => {
	let recoveries = 0,
		invalidations = 0;
	const health = new PostgresHealth({
		probe: async () => {
			throw new Error("identity mismatch");
		},
		recover: async () => {
			recoveries++;
		},
	});
	health.subscribe(() => invalidations++);
	await assert.rejects(health.check(), /identity mismatch/);
	assert.equal(recoveries, 0);
	assert.equal(invalidations, 1);
	await health.stop();
});

test("peer recovery on the same port invalidates the previous process generation", async () => {
	let identity = "old",
		invalidations = 0;
	const health = new PostgresHealth({
		probe: async () => ({ url: "same-port", identity }),
		recover: async () => {
			throw new Error("peer already recovered");
		},
	});
	health.subscribe(() => invalidations++);
	await health.check();
	identity = "new";
	assert.equal(await health.check(), "same-port");
	assert.equal(invalidations, 1);
	await health.stop();
});

test("stop during backoff prevents another recovery attempt", async () => {
	let release!: () => void;
	let waiting!: () => void;
	const entered = new Promise<void>((resolve) => {
		waiting = resolve;
	});
	let recoveries = 0;
	const health = new PostgresHealth({
		probe: async () => undefined,
		recover: async () => {
			recoveries++;
		},
		wait: async () => {
			waiting();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		},
	});
	const check = assert.rejects(health.check());
	await entered;
	const stop = health.stop();
	release();
	await Promise.all([check, stop]);
	assert.equal(recoveries, 1);
	await assert.rejects(health.check(), /stopped/);
});

test("idle monitoring is serialized and stops with its owner", async () => {
	vi.useFakeTimers();
	let probes = 0;
	const health = new PostgresHealth({
		probe: async () => {
			probes++;
			return { url: "managed", identity: "1" };
		},
		recover: async () => {
			throw new Error("healthy");
		},
	});
	try {
		health.start();
		health.start();
		await vi.advanceTimersByTimeAsync(15_000);
		assert.equal(probes, 3);
		await health.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		assert.equal(probes, 3);
	} finally {
		await health.stop();
		vi.useRealTimers();
	}
});

test("a validation that never gets an answer is a bounded transient failure that spares other checkouts", async () => {
	const timeout = new Error("Query read timeout");
	const validate = vi.fn(async () => {
		throw timeout;
	});
	let invalidations = 0;
	const health = new PostgresHealth({
		probe: async () => ({ url: "managed", identity: "same" }),
		recover: async () => {
			throw new Error("a slow query must not restart PostgreSQL");
		},
		validate,
	});
	health.subscribe(() => invalidations++);
	const failure = await health.validate({} as PoolClient).then(
		() => undefined,
		(error: unknown) => error,
	);
	assert.equal(isDbosDependencyError(failure), true);
	assert.equal(validate.mock.calls.length, 2);
	assert.equal(invalidations, 0);
	assert.equal(health.lastFailure?.message, timeout.message);
	await health.stop();
});

test("refreshes a missing-identity outage after a successful probe without replacing recovery errors during cooldown (#3413)", async () => {
	let now = 0;
	let healthy = true;
	let recoveries = 0;
	const health = new PostgresHealth({
		probe: async () => (healthy ? { url: "managed", identity: "1" } : undefined),
		recover: async () => {
			recoveries++;
			if (recoveries <= 3) throw new Error("previous recovery failure");
		},
		wait: async () => {},
		now: () => now,
	});
	try {
		await health.check();
		healthy = false;
		await assert.rejects(health.check(), /unavailable after bounded recovery/);
		assert.match(health.lastFailure?.message ?? "", /previous recovery failure/);
		await assert.rejects(health.check(), /cooling down/);
		assert.match(health.lastFailure?.message ?? "", /previous recovery failure/);
		healthy = true;
		assert.equal(await health.check(), "managed");
		healthy = false;
		now += 5_000;
		await assert.rejects(health.check(), /unavailable after bounded recovery/);
		assert.match(health.lastFailure?.message ?? "", /live health check/);
		assert.doesNotMatch(health.lastFailure?.message ?? "", /previous recovery failure/);
		await assert.rejects(health.check(), /cooling down/);
		assert.match(health.lastFailure?.message ?? "", /live health check/);
		assert.equal(recoveries, 6);
	} finally {
		await health.stop();
	}
});

test("short secrets redact only credential values in diagnostic contexts (#3413)", async () => {
	const { redactedDatabaseMessage } = await import(
		"../../packages/workflows/src/durable/dbos-database-diagnostics.js"
	);
	const url = "postgresql://u:a@127.0.0.1/db?token=t&sslpassword=s";
	const message = "Managed Postgres runtime missing; password=a token=t sslpassword=s; user=u; [redacted]";
	assert.equal(
		redactedDatabaseMessage(message, url),
		"Managed Postgres runtime missing; password=[redacted] token=[redacted] sslpassword=[redacted]; user=[redacted]; [redacted]",
	);
	assert.equal(
		redactedDatabaseMessage(`authentication failed for user "u" at postgresql://u:a@127.0.0.1/db?token=t`, url),
		'authentication failed for user "[redacted]" at postgresql://127.0.0.1/db',
	);
});
test("retained recovery refusal survives cooldown and redacts underlying credentials (#3413)", async () => {
	const url = "postgresql://private-user:p%40ssword@127.0.0.1:5439/workflows?token=private-token";
	let now = 0;
	let recoveries = 0;
	const health = new PostgresHealth({
		url: () => url,
		probe: async () => undefined,
		recover: async () => {
			recoveries++;
			throw new Error(`Owned runtime missing: ${url}; password=p@ssword token=private-token`, {
				cause: new Error("private-token"),
			});
		},
		wait: async () => {},
		now: () => now,
	});
	try {
		for (const expected of [/bounded recovery/, /cooling down/]) {
			await assert.rejects(health.check(), (error: Error) => {
				assert.equal(isDbosDependencyError(error), true);
				assert.match(error.message, expected);
				assert.match(error.message, /Provider: managed; endpoint: postgresql:\/\/127\.0\.0\.1:5439\/workflows/);
				assert.match(error.message, /Owned runtime missing/);
				assert.doesNotMatch(error.stack ?? "", /private-user|p%40ssword|p@ssword|private-token/);
				assert.equal(error.cause, undefined);
				return true;
			});
			assert.match(health.lastFailure?.message ?? "", /Owned runtime missing/);
			assert.doesNotMatch(health.lastFailure?.stack ?? "", /private-user|p%40ssword|p@ssword|private-token/);
			assert.equal(health.lastFailure?.cause, undefined);
		}
		assert.equal(recoveries, 3);
		now += 5_000;
		await assert.rejects(health.check(), /Owned runtime missing/);
		assert.equal(recoveries, 6);
	} finally {
		await health.stop();
	}
});

test("hard managed health probe reports why recovery is refused without restart authority (#3413)", async () => {
	let recoveries = 0;
	const health = new PostgresHealth({
		url: () => "postgresql://postgres:atomic@127.0.0.1:5439/workflows",
		probe: async () => {
			throw new Error("Managed Postgres system identity mismatch. Preserve the existing data.");
		},
		recover: async () => {
			recoveries++;
		},
	});
	try {
		await assert.rejects(health.check(), (error: Error) => {
			assert.equal(isDbosDependencyError(error), true);
			assert.match(error.message, /recovery refused.*system identity mismatch/);
			assert.match(error.message, /Provider: managed; endpoint:/);
			return true;
		});
		assert.equal(recoveries, 0);
	} finally {
		await health.stop();
	}
});
test("hard probe failure is not replaced by a missing-identity outage (#3413)", async () => {
	let probe = 0;
	const health = new PostgresHealth({
		probe: async () => {
			probe++;
			if (probe === 2) throw new Error("managed system identity validation failed");
			if (probe >= 3) return undefined;
			return { url: "managed", identity: "same" };
		},
		recover: async () => {},
		wait: async () => {},
	});
	try {
		await health.check();
		await assert.rejects(health.check(), /managed system identity validation failed/);
		await assert.rejects(health.check(), /unavailable after bounded recovery/);
		assert.match(health.lastFailure?.message ?? "", /managed system identity validation failed/);
	} finally {
		await health.stop();
	}
});

test("redacts unquoted user values and configured secrets without corrupting prose (#3413)", async () => {
	const { redactedDatabaseMessage } = await import(
		"../../packages/workflows/src/durable/dbos-database-diagnostics.js"
	);
	const url = "postgresql://private-user:p%40ssword@127.0.0.1/db?token=private-token";
	assert.equal(
		redactedDatabaseMessage(
			`could not connect: user private-user; token was private-token; runtime missing; alphabet; encoded ${url}`,
			url,
		),
		"could not connect: user [redacted]; token was [redacted]; runtime missing; alphabet; encoded postgresql://127.0.0.1/db",
	);
	assert.equal(
		redactedDatabaseMessage("unlabelled private-token was rejected; password p@ssword (p@ssword)", url),
		"unlabelled [redacted] was rejected; password [redacted] ([redacted])",
	);
	assert.equal(
		redactedDatabaseMessage("authentication failed for user private-user"),
		"authentication failed for user [redacted]",
	);
});
