import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { runStorageCommand } from "../../packages/coding-agent/src/cli/storage-command.js";
import {
	POSTGRES_ADAPTER_PACKAGE,
	STORAGE_TOKEN_FILE,
} from "../../packages/coding-agent/src/core/storage/selection.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { postgresSkipReason, withPostgresDatabase } from "../helpers/postgres-database.js";
import { makeTempDirectory, moduleDir, removeTempDirectory } from "../helpers/runtime.js";

/** Loading the Postgres package adapter through jiti and connecting, several times. */
const POSTGRES_CLI_TIMEOUT_MS = 60_000;

const postgresPackage = resolve(moduleDir(import.meta.url), "../../packages/storage-postgres");

async function inMachine<T>(
	body: (machine: {
		readonly agentDir: string;
		readonly root: string;
		readonly storage: (args: string[]) => Promise<{ code: number; out: string; err: string }>;
	}) => Promise<T>,
): Promise<T> {
	const root = makeTempDirectory("storage-postgres-cli-");
	try {
		const agentDir = join(root, "agent");
		const project = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [postgresPackage] }));
		return await body({
			agentDir,
			root,
			storage: async (args) => {
				const out: string[] = [];
				const err: string[] = [];
				const code = await runStorageCommand(args, {
					cwd: project,
					agentDir,
					log: (line) => out.push(line),
					error: (line) => err.push(line),
					loadControl: async () => {
						throw new Error("no broker in this test");
					},
				});
				return { code, out: out.join("\n"), err: err.join("\n") };
			},
		});
	} finally {
		removeTempDirectory(root);
	}
}

describe.skipIf(postgresSkipReason !== undefined)("atomic storage join against PostgreSQL (#4793)", () => {
	test(
		"joins with a password file, then status answers, without the password anywhere on disk or in output (#4793)",
		async () => {
			await withPostgresDatabase(async ({ url: databaseUrl, name, admin }) => {
				// A role of its own, so the password is a string no output could hold by chance.
				const role = `${name}_cli`;
				const password = `pw-${randomUUID()}`;
				await admin.exec(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
				await admin.exec(`GRANT ALL ON DATABASE ${name} TO ${role}`);
				try {
					const address = new URL(databaseUrl);
					address.username = role;
					const url = address.href;
					await inMachine(async ({ agentDir, root, storage }) => {
						const passwordFile = join(root, "pg-password");
						writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
						const joined = await storage(["join", url, "--password-file", passwordFile]);
						assert.equal(joined.code, 0, joined.err);
						const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
						const [tokenName] = readdirSync(agentDir).filter((entry) => entry.startsWith(STORAGE_TOKEN_FILE));
						assert.ok(tokenName !== undefined);
						assert.deepEqual(JSON.parse(settings).storage, {
							adapter: POSTGRES_ADAPTER_PACKAGE,
							options: { url },
							secrets: { password: { file: `${tokenName}` } },
						});
						const status = await collectStorageStatus({ cwd: root, agentDir, probe: true });
						const sessions = status.domains.find((domain) => domain.domain === "sessions");
						assert.equal(sessions?.probe?.connection.status, "ok", sessions?.probe?.connection.detail);
						assert.match(sessions?.probe?.connection.detail ?? "", /PostgreSQL \d+.*; wake-ups: LISTEN\/NOTIFY$/);
						const printed = await storage(["status", "--json"]);
						for (const text of [settings, joined.out, joined.err, printed.out, printed.err])
							assert.ok(!text.includes(password));
					});
				} finally {
					await admin.exec(`REVOKE ALL ON DATABASE ${name} FROM ${role}`);
					await admin.exec(`DROP ROLE IF EXISTS ${role}`);
				}
			});
		},
		POSTGRES_CLI_TIMEOUT_MS,
	);

	test(
		"--auth azure without @azure/identity fails as auth-unavailable naming the install command, not as a connection failure (#5218)",
		async () => {
			await withPostgresDatabase(async ({ url }) =>
				inMachine(async ({ agentDir, storage }) => {
					const before = readFileSync(join(agentDir, "settings.json"), "utf8");
					const joined = await storage(["join", url, "--auth", "azure"]);
					assert.equal(joined.code, 1);
					assert.match(joined.err, /Could not sign in to the shared database/);
					assert.match(joined.err, /auth-unavailable/);
					assert.match(joined.err, /atomic install npm:@azure\/identity/);
					assert.doesNotMatch(joined.err, /connection-failed|team database/);
					assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
				}),
			);
		},
		POSTGRES_CLI_TIMEOUT_MS,
	);

	test(
		"a refused password changes nothing and is not printed (#4793)",
		async () => {
			await withPostgresDatabase(async ({ url }) =>
				inMachine(async ({ agentDir, root, storage }) => {
					const wrong = "wrong-password-4793-never-print";
					const passwordFile = join(root, "wrong");
					writeFileSync(passwordFile, wrong, { mode: 0o600 });
					const before = readFileSync(join(agentDir, "settings.json"), "utf8");
					const joined = await storage(["join", url, "--token-file", passwordFile]);
					assert.equal(joined.code, 1);
					assert.match(joined.err, /connection-failed/);
					assert.ok(!`${joined.out}${joined.err}`.includes(wrong));
					assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), before);
				}),
			);
		},
		POSTGRES_CLI_TIMEOUT_MS,
	);
});
