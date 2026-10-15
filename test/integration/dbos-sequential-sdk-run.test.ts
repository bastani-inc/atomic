import assert from "node:assert/strict";
import { test } from "vitest";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_SEQUENTIAL_SDK_RUN_TIMEOUT_MS = 180_000;
const REAL_SEQUENTIAL_SDK_HOST_TIMEOUT_MS = 120_000;

test(
	"three sequential durable SDK run() calls complete in one process (#3614)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const sdk = home.client(listener.port, {}, "dbos-sequential-sdk-run.ts");
			const results = await sdk.request<{ status: string; result?: { greeting: string }; error?: string }[]>(
				"run",
				url,
				REAL_SEQUENTIAL_SDK_HOST_TIMEOUT_MS,
			);
			assert.equal(results.length, 3);
			for (const [index, name] of ["first", "second", "third"].entries()) {
				assert.equal(results[index].status, "completed", `run ${index + 1}: ${results[index].error}`);
				assert.deepEqual(results[index].result, { greeting: `hello ${name}` });
			}
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_SEQUENTIAL_SDK_RUN_TIMEOUT_MS,
);
