/**
 * Local DBOS database resolution: explicit env URL, embedded Postgres from
 * npm binaries, Docker as the final fallback.
 */

import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { RetainedPostgres } from "@bastani/atomic-natives";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { effectiveSystemDatabaseUrl } from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	EMBEDDED_DBOS_SYSTEM_DATABASE_URL,
	embeddedPostgresTestHooks,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	dockerFallbackEndpoint,
	provisionResolvedLocalDbos,
	resetLocalDbosProvisioningForTests,
	resolveDbosSystemDatabaseUrl,
	shouldProvisionLocalDbos,
	shutdownResolvedLocalDbos,
	waitForPostgresProtocolReadiness,
} from "../../packages/workflows/src/durable/dbos-local-postgres.js";

const originalUrl = process.env.DBOS_SYSTEM_DATABASE_URL;

afterEach(() => {
	resetLocalDbosProvisioningForTests();
	if (originalUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
	else process.env.DBOS_SYSTEM_DATABASE_URL = originalUrl;
});

test.sequential("invalid fallback port refuses Docker before provisioning (#3246)", async () => {
	const previous = process.env.PGPORT;
	delete process.env.DBOS_SYSTEM_DATABASE_URL;
	process.env.PGPORT = "0";
	resetLocalDbosProvisioningForTests(async () => {
		throw new Error("embedded unavailable");
	});
	try {
		await assert.rejects(
			resolveDbosSystemDatabaseUrl(),
			/Docker fallback: PostgreSQL readiness port .* must be an integer/,
		);
	} finally {
		if (previous === undefined) delete process.env.PGPORT;
		else process.env.PGPORT = previous;
	}
});

describe("resolveDbosSystemDatabaseUrl", () => {
	test.sequential("defers to an explicit DBOS_SYSTEM_DATABASE_URL without provisioning", async () => {
		process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://user:pw@db.example:5432/dbos";
		let provisioned = 0;
		resetLocalDbosProvisioningForTests(
			async () => {
				provisioned += 1;
			},
			async () => {
				provisioned += 1;
			},
		);

		assert.equal(await resolveDbosSystemDatabaseUrl(), undefined);
		await provisionResolvedLocalDbos();
		await shutdownResolvedLocalDbos();
		assert.equal(provisioned, 0);
	});

	test.sequential("prefers the embedded instance and memoizes one resolution", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let embeddedCalls = 0;
		resetLocalDbosProvisioningForTests(
			async () => {
				embeddedCalls += 1;
			},
			async () => {
				throw new Error("docker must not run");
			},
		);

		const [first, second] = await Promise.all([resolveDbosSystemDatabaseUrl(), resolveDbosSystemDatabaseUrl()]);

		assert.equal(first, EMBEDDED_DBOS_SYSTEM_DATABASE_URL);
		assert.equal(second, EMBEDDED_DBOS_SYSTEM_DATABASE_URL);
		assert.equal(embeddedCalls, 1);
	});

	test.sequential("falls back to Docker after an embedded provisioning failure with no retained lease", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let dockerCalls = 0;
		resetLocalDbosProvisioningForTests(
			async () => {
				throw new Error("unsupported platform");
			},
			async () => {
				dockerCalls += 1;
			},
		);

		assert.equal(await resolveDbosSystemDatabaseUrl(), undefined);
		assert.equal(dockerCalls, 1);
	});

	test.sequential("combines both failures into one actionable error and allows retry", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let attempts = 0;
		resetLocalDbosProvisioningForTests(
			async () => {
				attempts += 1;
				throw new Error("no binaries");
			},
			async () => {
				throw new Error("no docker");
			},
		);

		await assert.rejects(resolveDbosSystemDatabaseUrl(), /no binaries.*no docker.*DBOS_SYSTEM_DATABASE_URL/s);
		await assert.rejects(resolveDbosSystemDatabaseUrl(), /no binaries/);
		assert.equal(attempts, 2, "a failed resolution must not be memoized");
	});

	test.sequential("does not replace a failed-cleanup embedded lease with the Docker fallback", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let cleanupAttempts = 0;
		let releaseCalls = 0;
		let dockerCalls = 0;
		const lease = {
			pid: 4242,
			interruptAndWait: async () => {
				cleanupAttempts += 1;
				if (cleanupAttempts === 1) throw new Error("rollback timed out");
				return { exited: true, signaled: false };
			},
			wait: async () => ({ exited: true, signaled: false }),
			release: () => {
				releaseCalls += 1;
			},
		} satisfies RetainedPostgres;
		embeddedPostgresTestHooks.setEnsureOperation(async () => {
			const cluster = embeddedPostgresTestHooks.setActiveCluster(lease);
			await embeddedPostgresTestHooks.waitForClusterReadiness(
				"/postgres.log",
				cluster,
				async () => false,
				1,
				async () => {},
			);
		});
		resetLocalDbosProvisioningForTests(
			embeddedPostgresTestHooks.ensure,
			async () => {
				dockerCalls += 1;
			},
			shutdownEmbeddedDbosPostgres,
		);
		try {
			await assert.rejects(resolveDbosSystemDatabaseUrl(), /retained process could not be stopped/i);
			assert.equal(dockerCalls, 0, "a second database must not hide ownership of the failed-cleanup child");

			await shutdownResolvedLocalDbos();
			assert.equal(cleanupAttempts, 2, "local shutdown retries the same native lease");
			assert.equal(releaseCalls, 1);
		} finally {
			embeddedPostgresTestHooks.setEnsureOperation(undefined);
			embeddedPostgresTestHooks.setActiveCluster(undefined);
		}
	});

	test.sequential("launch-retry reprovisions the provider that was actually resolved", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		const calls: string[] = [];
		resetLocalDbosProvisioningForTests(
			async () => {
				calls.push("embedded");
				throw new Error("unsupported");
			},
			async () => {
				calls.push("docker");
			},
		);

		await resolveDbosSystemDatabaseUrl();
		await provisionResolvedLocalDbos();

		assert.deepEqual(calls, ["embedded", "docker", "docker"]);
	});

	test.sequential("shuts down exactly the embedded provider that was resolved", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let shutdownCalls = 0;
		resetLocalDbosProvisioningForTests(
			async () => {},
			async () => {
				throw new Error("docker must not run");
			},
			async () => {
				shutdownCalls += 1;
			},
		);

		await resolveDbosSystemDatabaseUrl();
		await Promise.all([shutdownResolvedLocalDbos(), shutdownResolvedLocalDbos()]);

		assert.equal(shutdownCalls, 1);
	});

	test.sequential("a failed embedded shutdown retains provider ownership for retry", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let shutdownCalls = 0;
		resetLocalDbosProvisioningForTests(
			async () => {},
			async () => {
				throw new Error("docker must not run");
			},
			async () => {
				shutdownCalls += 1;
				if (shutdownCalls === 1) throw new Error("retained lease timed out");
			},
		);

		await resolveDbosSystemDatabaseUrl();
		await assert.rejects(shutdownResolvedLocalDbos(), /retained lease timed out/);
		await shutdownResolvedLocalDbos();

		assert.equal(shutdownCalls, 2);
	});

	test.sequential("does not route Docker provider shutdown through embedded teardown", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let shutdownCalls = 0;
		resetLocalDbosProvisioningForTests(
			async () => {
				throw new Error("embedded unavailable");
			},
			async () => {},
			async () => {
				shutdownCalls += 1;
			},
		);

		await resolveDbosSystemDatabaseUrl();
		await shutdownResolvedLocalDbos();

		assert.equal(shutdownCalls, 0);
	});
});

// #3074: DBOS survives /reload, so teardown must retain the original provider closure.
test("a reloaded bundle releases the original provider once and clears its resolution memo", async () => {
	delete process.env.DBOS_SYSTEM_DATABASE_URL;
	let starts = 0;
	let stops = 0;
	resetLocalDbosProvisioningForTests(
		async () => {
			starts++;
		},
		async () => {
			throw new Error("must not use Docker");
		},
		async () => {
			stops++;
		},
	);
	await resolveDbosSystemDatabaseUrl();
	vi.resetModules();
	const reloaded = await import("../../packages/workflows/src/durable/dbos-local-postgres.js");
	assert.notEqual(reloaded.shutdownResolvedLocalDbos, shutdownResolvedLocalDbos);
	await Promise.all([reloaded.shutdownResolvedLocalDbos(), shutdownResolvedLocalDbos()]);
	assert.equal(stops, 1);
	await reloaded.resolveDbosSystemDatabaseUrl();
	assert.equal(starts, 2);
	await reloaded.shutdownResolvedLocalDbos();
	assert.equal(stops, 2);
});

describe("shouldProvisionLocalDbos", () => {
	test.sequential("matches connection-refused failures only without an explicit URL", () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		assert.equal(shouldProvisionLocalDbos(new Error("connect ECONNREFUSED 127.0.0.1:5439")), true);
		assert.equal(
			shouldProvisionLocalDbos(new Error("Unable to connect to system database at postgresql://...")),
			true,
		);
		assert.equal(shouldProvisionLocalDbos(new Error("read ECONNRESET")), true);
		assert.equal(shouldProvisionLocalDbos(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })), true);
		assert.equal(shouldProvisionLocalDbos(new Error("Connection terminated unexpectedly")), true);
		assert.equal(shouldProvisionLocalDbos(new Error("password authentication failed")), false);

		process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://user:pw@db.example:5432/dbos";
		assert.equal(shouldProvisionLocalDbos(new Error("connect ECONNREFUSED db.example:5432")), false);
		assert.equal(shouldProvisionLocalDbos(new Error("read ECONNRESET")), false);
		assert.equal(shouldProvisionLocalDbos(new Error("Connection terminated unexpectedly")), false);
	});
});

describe("dockerFallbackEndpoint", () => {
	test.sequential("uses PGHOST/PGPORT/PGUSER/PGPASSWORD the same way DBOS default URL does", () => {
		const previous = {
			PGHOST: process.env.PGHOST,
			PGPORT: process.env.PGPORT,
			PGUSER: process.env.PGUSER,
			PGPASSWORD: process.env.PGPASSWORD,
		};
		process.env.PGHOST = "fixture.invalid";
		process.env.PGPORT = "15432";
		process.env.PGUSER = "fixture";
		process.env.PGPASSWORD = "p@ss/word";
		try {
			assert.deepEqual(dockerFallbackEndpoint(), {
				host: "fixture.invalid",
				port: 15432,
				user: "fixture",
				password: "p@ss/word",
			});
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test.sequential("defaults to localhost:5432 postgres/dbos when PG* is unset", () => {
		const previous = {
			PGHOST: process.env.PGHOST,
			PGPORT: process.env.PGPORT,
			PGUSER: process.env.PGUSER,
			PGPASSWORD: process.env.PGPASSWORD,
		};
		delete process.env.PGHOST;
		delete process.env.PGPORT;
		delete process.env.PGUSER;
		delete process.env.PGPASSWORD;
		try {
			assert.deepEqual(dockerFallbackEndpoint(), {
				host: "localhost",
				port: 5432,
				user: "postgres",
				password: "dbos",
			});
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
describe("waitForPostgresProtocolReadiness", () => {
	beforeEach(() => {
		vi.spyOn(performance, "now").mockReturnValue(0);
	});
	afterEach(() => vi.restoreAllMocks());

	test.sequential("a TCP-published port that resets is not PostgreSQL-ready", async () => {
		const listener = await listenResettingPort();
		try {
			await assert.rejects(
				waitForPostgresProtocolReadiness({
					host: "127.0.0.1",
					port: listener.port,
					attempts: 2,
					delayMs: 1,
					wait: async () => {},
				}),
				/did not become ready/,
			);
		} finally {
			await listener.close();
		}
	});

	test.sequential("a TCP-published port that FINs is retried until the deadline", async () => {
		const listener = await listenClosingPort("fin");
		try {
			await assert.rejects(
				waitForPostgresProtocolReadiness({
					host: "127.0.0.1",
					port: listener.port,
					attempts: 2,
					delayMs: 1,
					wait: async () => {},
				}),
				/did not become ready/,
			);
		} finally {
			await listener.close();
		}
	});
	test.sequential("recovers after a transient startup reset then becomes ready", async () => {
		let probes = 0;
		await waitForPostgresProtocolReadiness({
			host: "127.0.0.1",
			port: 1,
			attempts: 3,
			delayMs: 1,
			wait: async () => {},
			isReady: async () => {
				probes += 1;
				if (probes === 1) {
					throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
				}
				return true;
			},
		});
		assert.equal(probes, 2);
	});

	test.sequential("recovers after FATAL 57P03 then becomes ready", async () => {
		let probes = 0;
		await waitForPostgresProtocolReadiness({
			host: "127.0.0.1",
			port: 1,
			attempts: 3,
			delayMs: 1,
			wait: async () => {},
			isReady: async () => {
				probes += 1;
				if (probes === 1) {
					throw Object.assign(new Error("the database system is starting up"), { code: "57P03" });
				}
				return true;
			},
		});
		assert.equal(probes, 2);
	});

	test.sequential("recovers after a connect timeout then becomes ready", async () => {
		let probes = 0;
		await waitForPostgresProtocolReadiness({
			host: "127.0.0.1",
			port: 1,
			attempts: 3,
			delayMs: 1,
			wait: async () => {},
			isReady: async () => {
				probes += 1;
				if (probes === 1) throw new Error("timeout expired");
				return true;
			},
		});
		assert.equal(probes, 2);
	});

	test.sequential("exhausts the bounded attempts when PostgreSQL never becomes ready", async () => {
		let probes = 0;
		await assert.rejects(
			waitForPostgresProtocolReadiness({
				host: "127.0.0.1",
				port: 1,
				attempts: 2,
				delayMs: 1,
				wait: async () => {},
				isReady: async () => {
					probes += 1;
					return false;
				},
			}),
			/did not become ready within 0.002 seconds/,
		);
		assert.equal(probes, 2);
	});

	test("deadline exhaustion stops probes before the attempt limit", async () => {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		let probes = 0;
		await assert.rejects(
			waitForPostgresProtocolReadiness({
				host: "127.0.0.1",
				port: 1,
				attempts: 10,
				delayMs: 500,
				isReady: async () => {
					probes++;
					now = 5_001;
					return false;
				},
			}),
			/did not become ready within 5 seconds/,
		);
		assert.equal(probes, 1);
	});

	test.sequential("does not retry an authentication failure", async () => {
		let probes = 0;
		await assert.rejects(
			waitForPostgresProtocolReadiness({
				host: "127.0.0.1",
				port: 1,
				attempts: 5,
				delayMs: 1,
				wait: async () => {},
				isReady: async () => {
					probes += 1;
					throw new Error("password authentication failed");
				},
			}),
			/password authentication failed/,
		);
		assert.equal(probes, 1);
	});
});

async function listenClosingPort(mode: "rst" | "fin"): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createServer((socket) => {
		if (mode === "rst") socket.resetAndDestroy();
		else socket.destroy();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("closing listener did not bind a TCP port");
	}
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

const listenResettingPort = (): Promise<{ port: number; close: () => Promise<void> }> => listenClosingPort("rst");

describe("effectiveSystemDatabaseUrl", () => {
	test("explicit config wins over the environment variable", () => {
		assert.equal(
			effectiveSystemDatabaseUrl("postgresql://config@db/one", "postgresql://env@db/two"),
			"postgresql://config@db/one",
		);
	});

	test("falls back to DBOS_SYSTEM_DATABASE_URL when no config URL is given", () => {
		assert.equal(
			effectiveSystemDatabaseUrl(undefined, "postgresql://env@db.example:5432/dbos"),
			"postgresql://env@db.example:5432/dbos",
		);
	});

	test("trims env-injected whitespace and trailing newlines", () => {
		assert.equal(
			effectiveSystemDatabaseUrl(undefined, "postgresql://env@db.example:5432/dbos\n"),
			"postgresql://env@db.example:5432/dbos",
		);
		assert.equal(
			effectiveSystemDatabaseUrl("  postgresql://config@db/one  ", undefined),
			"postgresql://config@db/one",
		);
	});

	test("treats unset, empty, and whitespace-only values as not set", () => {
		assert.equal(effectiveSystemDatabaseUrl(undefined, undefined), undefined);
		assert.equal(effectiveSystemDatabaseUrl(undefined, ""), undefined);
		assert.equal(effectiveSystemDatabaseUrl(undefined, "  \n"), undefined);
	});
});
