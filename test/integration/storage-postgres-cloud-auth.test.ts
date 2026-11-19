import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, test, vi } from "vitest";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/**
 * Replaces `google-auth-library` with a GoogleAuth whose tokens come from `issue`, and loads the adapter with it.
 * Returns the adapter and how many tokens were asked for.
 */
async function adapterWithGoogleAuth(issue: () => Promise<string | null>) {
	let requested = 0;
	vi.doMock("google-auth-library", () => ({
		GoogleAuth: class {
			getAccessToken() {
				requested++;
				return issue();
			}
		},
	}));
	vi.resetModules();
	const { default: adapter } = await import("../../packages/storage-postgres/postgres.js");
	return { adapter, requested: () => requested };
}

/**
 * Replaces `@azure/identity` with a DefaultAzureCredential whose tokens come from `issue`, each reused for an hour, as
 * Azure's are, and loads the adapter with it.
 */
async function adapterWithAzureIdentity(issue: () => string) {
	let requested = 0;
	vi.doMock("@azure/identity", () => ({
		DefaultAzureCredential: class {
			async getToken() {
				requested++;
				return { token: issue(), expiresOnTimestamp: Date.now() + 3_600_000 };
			}
		},
	}));
	vi.resetModules();
	const { default: adapter } = await import("../../packages/storage-postgres/postgres.js");
	return { adapter, requested: () => requested };
}

afterEach(() => {
	vi.doUnmock("google-auth-library");
	vi.doUnmock("@azure/identity");
	vi.resetModules();
});

describe.skipIf(postgresSkipReason !== undefined)("Postgres cloud IAM auth (#4793)", () => {
	test("a cloud auth selection connects with the SDK's token and never reads a password secret (#4793)", async () => {
		await withPostgresDatabase(async ({ admin, url, name }) => {
			const role = `${name}_iam`;
			const token = "fixture-iam-token-for-role";
			const { adapter, requested } = await adapterWithGoogleAuth(async () => token);
			try {
				await admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${token}'`);
				await admin.exec(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
				const roleUrl = new URL(url);
				roleUrl.username = role;
				const database = await adapter.openDatabase(
					{ url: roleUrl.href, auth: "gcp-iam", maxConnections: 2 },
					{
						agentDir: "/nonexistent",
						domain: "sessions",
						secret: () => Promise.reject(new Error("cloud auth read the password secret")),
					},
				);
				try {
					const reads = await Promise.all([1, 2, 3, 4].map(() => database.get("SELECT current_user AS who")));
					assert.deepEqual(reads, Array(4).fill({ who: role }));
					// One token per new connection, and the pool opens at most two.
					assert.ok(requested() >= 1 && requested() <= 2, `asked for ${requested()} tokens`);
				} finally {
					await database.close();
				}
			} finally {
				await admin.run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ?", role);
				await admin.exec(`REVOKE ALL ON DATABASE ${name} FROM ${role}`).catch(() => {});
				await admin.exec(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
			}
		});
	});

	test("a cached Entra token the server refuses is dropped, and the next connection signs in with a fresh one (#5218)", async () => {
		await withPostgresDatabase(async ({ admin, url, name }) => {
			const role = `${name}_entra`;
			let token = "first-entra-token-fixture";
			const { adapter, requested } = await adapterWithAzureIdentity(() => token);
			try {
				await admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${token}'`);
				await admin.exec(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
				const roleUrl = new URL(url);
				roleUrl.username = role;
				const database = await adapter.openDatabase(
					{ url: roleUrl.href, auth: "azure-entra", maxConnections: 1 },
					{ agentDir: "/nonexistent", domain: "sessions" },
				);
				try {
					assert.deepEqual(await database.get("SELECT current_user AS who"), { who: role });
					assert.equal(requested(), 1);
					// The cached token stops working before the cache says it expires, as with a clock that runs behind.
					token = "second-entra-token-fixture";
					await admin.exec(`ALTER ROLE ${role} PASSWORD '${token}'`);
					await admin.run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ?", role);
					// The pool may first hand out the connection the server just ended, which fails as lost.
					await database.get("SELECT 1 AS one").catch((error: Error) => {
						assert.equal((error as Error & { code?: string }).code, "connection-lost", inspect(error));
					});
					assert.deepEqual(await database.get("SELECT current_user AS who"), { who: role });
					assert.equal(requested(), 2, "one fresh token after the refusal");
				} finally {
					await database.close();
				}
			} finally {
				await admin.run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ?", role);
				await admin.exec(`REVOKE ALL ON DATABASE ${name} FROM ${role}`).catch(() => {});
				await admin.exec(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
			}
		});
	});

	test("@azure/identity installed among the user packages is found by an adapter installed from a local path (#5218)", async () => {
		await withPostgresDatabase(async ({ admin, url, name }) => {
			const role = `${name}_local`;
			const token = "user-package-entra-token";
			const agentDir = makeTempDirectory("storage-postgres-sdk-");
			try {
				// What `atomic install npm:@azure/identity` leaves: the package under <agentDir>/npm/node_modules.
				const sdk = join(agentDir, "npm", "node_modules", "@azure", "identity");
				mkdirSync(sdk, { recursive: true });
				writeFileSync(
					join(sdk, "package.json"),
					JSON.stringify({ name: "@azure/identity", version: "4.14.1", main: "index.cjs" }),
				);
				writeFileSync(
					join(sdk, "index.cjs"),
					`exports.DefaultAzureCredential = class { async getToken() { return { token: ${JSON.stringify(token)}, expiresOnTimestamp: Date.now() + 3600000 }; } };`,
				);
				await admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${token}'`);
				await admin.exec(`GRANT CONNECT ON DATABASE ${name} TO ${role}`);
				vi.resetModules();
				const { default: adapter } = await import("../../packages/storage-postgres/postgres.js");
				const roleUrl = new URL(url);
				roleUrl.username = role;
				const database = await adapter.openDatabase(
					{ url: roleUrl.href, auth: "azure-entra" },
					{ agentDir, domain: "sessions" },
				);
				try {
					assert.deepEqual(await database.get("SELECT current_user AS who"), { who: role });
				} finally {
					await database.close();
				}
			} finally {
				removeTempDirectory(agentDir);
				await admin.run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ?", role);
				await admin.exec(`REVOKE ALL ON DATABASE ${name} FROM ${role}`).catch(() => {});
				await admin.exec(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
			}
		});
	});

	test("a cloud auth that issues no token fails to open, with the SDK's reason and no credential (#4793)", async () => {
		await withPostgresDatabase(async ({ url }) => {
			const { adapter } = await adapterWithGoogleAuth(() =>
				Promise.reject(new Error("Could not load the default credentials")),
			);
			const error = await adapter
				.openDatabase({ url, auth: "gcp-iam" }, { agentDir: "/nonexistent", domain: "sessions" })
				.then(
					(database) => database.close().then(() => assert.fail("expected the open to fail")),
					(caught: Error) => caught,
				);
			let config: Error | undefined = error;
			while (config !== undefined && config.name !== "StorageConfigError")
				config = config.cause as Error | undefined;
			assert.ok(config !== undefined, inspect(error, { depth: null }));
			assert.equal((config as Error & { reason?: string }).reason, "auth-unavailable");
			assert.match(config.message, /gcp-iam found no token \(Could not load the default credentials\)/);
		});
	});
});
