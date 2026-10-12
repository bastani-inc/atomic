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
			interface PersistedRun {
				status: string;
				runId: string;
				toolCheckpoint: { workflowId: string; checkpointId: string; name: string; output: string };
			}
			const result = await sessionHost.request<{ first: PersistedRun; second: PersistedRun }>(
				"run",
				url,
				REAL_CROSS_CWD_HOST_TIMEOUT_MS,
			);
			assert.equal(result.first.status, "completed");
			assert.equal(result.second.status, "completed");
			assert.notEqual(result.first.runId, result.second.runId);
			for (const run of [result.first, result.second]) {
				assert.ok(run.toolCheckpoint, `run ${run.runId} must persist its tool checkpoint`);
				assert.match(run.toolCheckpoint.checkpointId, /^tool:/);
				assert.equal(run.toolCheckpoint.workflowId, `${run.runId}:checkpoint:${run.toolCheckpoint.checkpointId}`);
				assert.equal(run.toolCheckpoint.name, "step");
				assert.equal(run.toolCheckpoint.output, "ok");
			}
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
