import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { StorageConfigError } from "@bastani/atomic/storage";
import { afterEach, describe, test, vi } from "vitest";
import adapter from "../../packages/storage-postgres/postgres.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";

/** A fake GCP metadata server that issues `token()` as the access token, and counts what it issued. */
async function fakeMetadataServer(
	token: () => string | undefined,
): Promise<{ host: string; issued(): number; close(): Promise<void> }> {
	let issued = 0;
	const server: Server = createServer((request, response) => {
		const value = token();
		if (value === undefined || request.headers["metadata-flavor"] !== "Google") {
			response.writeHead(403, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "access_denied" }));
			return;
		}
		issued++;
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ access_token: value, expires_in: 3600, token_type: "Bearer" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		host: `127.0.0.1:${port}`,
		issued: () => issued,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(postgresSkipReason !== undefined)("Postgres cloud IAM auth (#4793)", () => {
	test("a cloud auth selection connects with the platform's token and never reads a password secret (#4793)", async () => {
		await withPostgresDatabase(async ({ admin, url, name }) => {
			const role = `${name}_iam`;
			const token = "fixture-iam-token-for-role";
			const metadata = await fakeMetadataServer(() => token);
			vi.stubEnv("GCE_METADATA_HOST", metadata.host);
			vi.stubEnv("PATH", "");
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
					assert.equal(metadata.issued(), 1);
				} finally {
					await database.close();
				}
			} finally {
				await metadata.close();
				await admin.run("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ?", role);
				await admin.exec(`REVOKE ALL ON DATABASE ${name} FROM ${role}`).catch(() => {});
				await admin.exec(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
			}
		});
	});

	test("a cloud auth that issues no token fails to open, naming the sources and not a credential (#4793)", async () => {
		await withPostgresDatabase(async ({ url }) => {
			const metadata = await fakeMetadataServer(() => undefined);
			vi.stubEnv("GCE_METADATA_HOST", metadata.host);
			vi.stubEnv("PATH", "");
			try {
				const error = await adapter
					.openDatabase({ url, auth: "gcp-iam" }, { agentDir: "/nonexistent", domain: "journal" })
					.then(
						(database) => database.close().then(() => assert.fail("expected the open to fail")),
						(caught: Error) => caught,
					);
				const rendered = inspect(error, { depth: null });
				let config: Error | undefined = error;
				while (config !== undefined && !(config instanceof StorageConfigError))
					config = config.cause as Error | undefined;
				assert.ok(config instanceof StorageConfigError, rendered);
				assert.equal(config.reason, "auth-unavailable");
				assert.match(
					config.message,
					/metadata server: HTTP 403: access_denied; gcloud CLI: `gcloud` was not found on PATH/,
				);
			} finally {
				await metadata.close();
			}
		});
	});
});
