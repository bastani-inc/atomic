import assert from "node:assert/strict";
import { test } from "vitest";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";

const REAL_CROSS_CWD_SESSION_TIMEOUT_MS = 180_000;
const REAL_CROSS_CWD_HOST_TIMEOUT_MS = 120_000;

test(
	"durable workflows survive last-session disposal followed by a different cwd (#3577)",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		try {
			const { url } = await home.client(listener.port).request<ManagedResult>("ensure");
			const sessionHost = home.client(listener.port, {}, "dbos-cross-cwd-session.ts");
			const result = await sessionHost.request<{ first: { status: string }; second: { status: string } }>(
				"run",
				url,
				REAL_CROSS_CWD_HOST_TIMEOUT_MS,
			);
			assert.equal(result.first.status, "completed");
			assert.equal(result.second.status, "completed");
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_CROSS_CWD_SESSION_TIMEOUT_MS,
);
