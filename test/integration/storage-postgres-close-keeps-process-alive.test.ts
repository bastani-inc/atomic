import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, test } from "vitest";
import {
	postgresAdapterPath,
	postgresSkipReason,
	postgresTestPassword,
	withPostgresDatabase,
} from "../helpers/postgres-database.js";

const run = promisify(execFile);

const script = `
const { openPostgresDatabase } = await import(process.env.ADAPTER);
const database = await openPostgresDatabase({
	url: process.env.URL,
	...(process.env.PASSWORD ? { password: process.env.PASSWORD } : {}),
});
await database.get("SELECT 1 AS one");
await database.close();
console.log("closed");
`;

describe.skipIf(postgresSkipReason !== undefined)(
	"closing a PostgreSQL database in a process with nothing else to do (#6742)",
	() => {
		test("close() keeps the process alive until its connections have closed, so code after it runs", async () => {
			await withPostgresDatabase(async ({ url }) => {
				const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
					env: {
						...process.env,
						ADAPTER: postgresAdapterPath,
						URL: url,
						PASSWORD: postgresTestPassword ?? "",
					},
					timeout: 30_000,
				});
				assert.equal(stdout.trim(), "closed", "the process exited inside close(), before the line after it ran");
			});
		});
	},
);
