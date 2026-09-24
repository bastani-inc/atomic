import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_POSTGRES_LOGGING_TIMEOUT_MS = 120_000;

test(
	"managed PostgreSQL writes a weekday collector log",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		try {
			const client = home.client(listener.port);
			await client.request("ensure");
			assert.deepEqual(await client.request("query", "SHOW logging_collector"), [{ logging_collector: "on" }]);
			const rows = await client.request<{ log_filename: string }[]>(
				"query",
				"SELECT pg_current_logfile() AS log_filename",
			);
			assert.equal(rows.length, 1);
			assert.match(rows[0].log_filename, /^log\/postgresql-(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.log$/);
			assert.ok(existsSync(join(home.path, ".atomic", "postgres", "v18", rows[0].log_filename)));
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_POSTGRES_LOGGING_TIMEOUT_MS,
);
