/**
 * Local DBOS database resolution: explicit env URL, embedded Postgres from
 * npm binaries, Docker as the final fallback.
 */

import assert from "node:assert/strict";
import type { RetainedPostgres } from "@bastani/atomic-natives";
import { afterEach, describe, test } from "vitest";
import { effectiveSystemDatabaseUrl } from "../../packages/workflows/src/durable/dbos-backend.js";
import {
	EMBEDDED_DBOS_SYSTEM_DATABASE_URL,
	embeddedPostgresTestHooks,
	shutdownEmbeddedDbosPostgres,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	provisionResolvedLocalDbos,
	resetLocalDbosProvisioningForTests,
	resolveDbosSystemDatabaseUrl,
	shouldProvisionLocalDbos,
	shutdownResolvedLocalDbos,
} from "../../packages/workflows/src/durable/dbos-local-postgres.js";
import { applyWorkflowDurabilitySetting } from "../../packages/workflows/src/extension/extension-factory.js";

const originalUrl = process.env.DBOS_SYSTEM_DATABASE_URL;

afterEach(() => {
	resetLocalDbosProvisioningForTests();
	if (originalUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
	else process.env.DBOS_SYSTEM_DATABASE_URL = originalUrl;
});

describe("resolveDbosSystemDatabaseUrl", () => {
	test.sequential("defers to an explicit DBOS_SYSTEM_DATABASE_URL without provisioning", async () => {
		process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://db.example:5432/dbos";
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

	test.sequential("a non-empty settings URL disables local provisioning", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let provisioned = 0;
		resetLocalDbosProvisioningForTests(
			async () => {
				provisioned += 1;
			},
			async () => {
				provisioned += 1;
			},
			undefined,
			"  postgresql://settings.example/workflows  ",
		);

		assert.equal(await resolveDbosSystemDatabaseUrl(), "postgresql://settings.example/workflows");
		assert.equal(provisioned, 0);
		assert.equal(shouldProvisionLocalDbos(new Error("connection refused")), false);
	});

	test.sequential("the workflow extension applies the host settings selection", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let provisioned = 0;
		resetLocalDbosProvisioningForTests(async () => {
			provisioned += 1;
		});
		applyWorkflowDurabilitySetting({ dbosSystemDatabaseUrl: " postgresql://settings.example/workflows " });

		assert.equal(await resolveDbosSystemDatabaseUrl(), "postgresql://settings.example/workflows");
		assert.equal(provisioned, 0);
	});

	test.sequential("an explicit empty setting keeps embedded PostgreSQL", async () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		let embeddedCalls = 0;
		resetLocalDbosProvisioningForTests(
			async () => {
				embeddedCalls += 1;
			},
			async () => {
				throw new Error("docker must not run");
			},
			undefined,
			"",
		);

		assert.equal(await resolveDbosSystemDatabaseUrl(), EMBEDDED_DBOS_SYSTEM_DATABASE_URL);
		assert.equal(embeddedCalls, 1);
	});
});

describe("shouldProvisionLocalDbos", () => {
	test.sequential("matches connection-refused failures only without an explicit URL", () => {
		delete process.env.DBOS_SYSTEM_DATABASE_URL;
		assert.equal(shouldProvisionLocalDbos(new Error("connect ECONNREFUSED 127.0.0.1:5439")), true);
		assert.equal(
			shouldProvisionLocalDbos(new Error("Unable to connect to system database at postgresql://...")),
			true,
		);
		assert.equal(shouldProvisionLocalDbos(new Error("password authentication failed")), false);

		process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://db.example:5432/dbos";
		assert.equal(shouldProvisionLocalDbos(new Error("connect ECONNREFUSED db.example:5432")), false);
	});
});

describe("effectiveSystemDatabaseUrl", () => {
	test("the environment variable wins over the settings URL", () => {
		assert.equal(
			effectiveSystemDatabaseUrl("postgresql://settings.example/one", "postgresql://env.example/two"),
			"postgresql://env.example/two",
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
