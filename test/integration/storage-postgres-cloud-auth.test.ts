import assert from "node:assert/strict";
import { inspect } from "node:util";
import { afterEach, describe, test, vi } from "vitest";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

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

afterEach(() => {
	vi.doUnmock("google-auth-library");
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
						domain: "journal",
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

	test("a cloud auth that issues no token fails to open, with the SDK's reason and no credential (#4793)", async () => {
		await withPostgresDatabase(async ({ url }) => {
			const { adapter } = await adapterWithGoogleAuth(() =>
				Promise.reject(new Error("Could not load the default credentials")),
			);
			const error = await adapter
				.openDatabase({ url, auth: "gcp-iam" }, { agentDir: "/nonexistent", domain: "journal" })
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
