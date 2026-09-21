import assert from "node:assert/strict";
import { Client } from "pg";
import { afterEach, test, vi } from "vitest";
import {
	dockerFallbackEndpoint,
	resetLocalDbosProvisioningForTests,
	resolveDbosSystemDatabaseUrl,
	shouldProvisionLocalDbos,
	waitForPostgresProtocolReadiness,
} from "../../packages/workflows/src/durable/dbos-local-postgres.js";
import * as localCommand from "../../packages/workflows/src/durable/local-command.js";

afterEach(() => {
	resetLocalDbosProvisioningForTests();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

for (const port of [99999, -1, 65536, 0, Number.NaN, 1.5]) {
	test(`invalid readiness port ${port} rejects before pg can arm a connection timer`, async () => {
		vi.useFakeTimers();
		const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(() => {
			throw new Error("unexpected connection attempt");
		});
		await assert.rejects(
			waitForPostgresProtocolReadiness({ host: "127.0.0.1", port }),
			/port.*integer between 1 and 65535/i,
		);
		assert.equal(connect.mock.calls.length, 0);
		await vi.runAllTimersAsync();
		assert.equal(vi.getTimerCount(), 0);
	});
}

for (const port of ["99999", "abc", "-1", "0", "65536", "1.5", "1e3", " "]) {
	test(`invalid PGPORT ${JSON.stringify(port)} fails before provisioning readiness`, () => {
		vi.stubEnv("PGPORT", port);
		assert.throws(dockerFallbackEndpoint, /port.*integer between 1 and 65535/i);
	});
}

test("connection failures in nested or string causes still allow local provisioning", () => {
	vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
	for (const cause of [new Error("connect ECONNREFUSED"), "connect ECONNREFUSED", new Error("read ECONNRESET")]) {
		assert.equal(shouldProvisionLocalDbos(new Error("DBOS launch failed", { cause })), true);
	}
	assert.equal(
		shouldProvisionLocalDbos(
			new Error("wrapped", {
				cause: new Error("connection failed", { cause: Object.assign(new Error("socket"), { code: "ETIMEDOUT" }) }),
			}),
		),
		true,
	);
	const cyclic = new Error("unrelated");
	cyclic.cause = cyclic;
	assert.equal(shouldProvisionLocalDbos(cyclic), false);
});

for (const message of [
	"canceling statement due to statement timeout",
	"Migration failed: lock timeout acquiring advisory lock",
	"Query read timeout",
	"migration failed for postgresql://postgres:***@localhost:5432/atomic_dbos_sys?connect_timeout=10",
]) {
	test(`unrelated failure does not provision locally: ${message}`, () => {
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
		assert.equal(shouldProvisionLocalDbos(new Error(message)), false);
	});
}

for (const message of [
	"timeout expired",
	"Connection terminated unexpectedly",
	"Connection terminated due to connection timeout",
	"timeout exceeded when trying to connect",
]) {
	test(`connection-phase failure remains recoverable: ${message}`, () => {
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
		assert.equal(shouldProvisionLocalDbos(new Error(message)), true);
	});
}

for (const scenario of [
	{ host: "localhost", mode: undefined, ssl: false },
	{ host: "127.0.0.1", mode: undefined, ssl: {} },
	{ host: "localhost", mode: "verify-full", ssl: {} },
]) {
	test(`readiness honors DBOS TLS selection for ${scenario.host} / ${scenario.mode ?? "default"}`, async () => {
		vi.stubEnv("PGSSLMODE", scenario.mode);
		const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(function (this: Client) {
			assert.deepEqual(this.ssl, scenario.ssl);
			throw new Error("probe stopped before network access");
		});
		await assert.rejects(
			waitForPostgresProtocolReadiness({ host: scenario.host, port: 15432 }),
			/probe stopped before network access/,
		);
		assert.equal(connect.mock.calls.length, 1);
	});
}

test("a code-bearing dual-stack connection failure retries before readiness", async () => {
	vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
	vi.spyOn(performance, "now").mockReturnValue(0);
	const failure = Object.assign(
		new AggregateError([
			Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" }),
			Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }),
		]),
		{ code: "ECONNREFUSED" },
	);
	assert.equal(shouldProvisionLocalDbos(failure), true);
	let probes = 0;
	await waitForPostgresProtocolReadiness({
		host: "localhost",
		port: 15432,
		wait: async () => {},
		isReady: async () => {
			if (++probes === 1) throw failure;
			return true;
		},
	});
	assert.equal(probes, 2);
});

for (const port of ["5432", "55432"]) {
	test(`new Docker fallback publishes the selected PGPORT ${port} (#3158)`, async () => {
		vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
		vi.stubEnv("PGPORT", port);
		resetLocalDbosProvisioningForTests(async () => {
			throw new Error("embedded unavailable");
		});
		const command = vi.spyOn(localCommand, "runLocalCommand").mockImplementation(async (_command, args) => {
			if (args[0] === "version") return { exitCode: 0, stdout: "29", stderr: "" };
			if (args[0] === "inspect") return { exitCode: 1, stdout: "", stderr: "missing" };
			throw new Error("stop before creating a real container");
		});
		await assert.rejects(resolveDbosSystemDatabaseUrl(), /stop before creating a real container/);
		const creation = command.mock.calls.find((call) => call[1][0] === "run");
		assert.ok(creation);
		assert.equal(creation[0], "docker");
		assert.equal(creation[1][creation[1].indexOf("-p") + 1], `127.0.0.1:${port}:5432`);
	});
}

test("invalid PGPORT rejects before Docker commands run (#3158)", async () => {
	vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
	vi.stubEnv("PGPORT", "99999");
	resetLocalDbosProvisioningForTests(async () => {
		throw new Error("embedded unavailable");
	});
	const command = vi.spyOn(localCommand, "runLocalCommand").mockImplementation(async () => {
		throw new Error("must not run Docker");
	});
	await assert.rejects(resolveDbosSystemDatabaseUrl(), /PGPORT.*integer between 1 and 65535/);
	assert.equal(command.mock.calls.length, 0);
});

test("startup failure normalization preserves non-Error inputs without trusting arbitrary fields (#3158)", () => {
	vi.stubEnv("DBOS_SYSTEM_DATABASE_URL", "");
	assert.equal(shouldProvisionLocalDbos("read ECONNRESET"), true);
	for (const value of [
		null,
		undefined,
		42,
		{ code: "ECONNRESET" },
		Object.assign(new Error("schema failed"), { code: 42 }),
	]) {
		assert.equal(shouldProvisionLocalDbos(value), false);
	}
});
