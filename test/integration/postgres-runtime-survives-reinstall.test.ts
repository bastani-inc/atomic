import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { loadEmbeddedPostgresBinaries } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { readText, removeTempDirectory } from "../helpers/runtime.js";

const REAL_RUNTIME_REINSTALL_TIMEOUT_MS = 120_000;

test(
	"managed PostgreSQL preserves queries and paused workflow checkpoints after its source installation is deleted",
	async () => {
		const home = new RealPostgresHome();
		const listener = await reserveListener();
		try {
			const binaries = await loadEmbeddedPostgresBinaries({ readOnly: true });
			const source = join(home.path, "disposable-worktree", "node_modules", "postgres", "native");
			await cp(dirname(dirname(binaries.postgres)), source, { recursive: true, verbatimSymlinks: true });
			const workflowClient = home.client(
				listener.port,
				{
					ATOMIC_POSTGRES_RUNTIME_DIR: source,
					ATOMIC_WORKFLOW_ARTIFACT_DIR: join(home.path, "workflow-artifacts"),
				},
				"managed-dbos-fault-client.ts",
			);
			const before = await workflowClient.request<ManagedResult & { runId: string }>("warm");
			const launch = await readText(join(home.path, ".atomic", "postgres", "v18", "postmaster.opts"));
			assert.ok(!launch.includes(source), "the server must not execute from the disposable installation");
			assert.ok(launch.includes("pg-runtime"), "the server uses the persistent runtime generation");
			removeTempDirectory(join(home.path, "disposable-worktree"));
			const reader = home.client(listener.port);
			const attached = await reader.request<ManagedResult>("ensure");
			assert.equal(attached.metadata.server.pid, before.metadata.server.pid);
			const rows = await reader.request<{ names: string; abbreviations: string }[]>(
				"query",
				"SELECT (SELECT count(*) FROM pg_timezone_names) AS names, (SELECT count(*) FROM pg_timezone_abbrevs) AS abbreviations",
			);
			assert.ok(Number(rows[0]?.names) > 0);
			assert.ok(Number(rows[0]?.abbreviations) > 0);
			const resumed = await workflowClient.request<ManagedResult & { runId: string; completedCalls: number }>(
				"resume",
			);
			assert.equal(resumed.runId, before.runId);
			assert.equal(resumed.completedCalls, 1);
			assert.equal(resumed.metadata.clusterId, before.metadata.clusterId);
			assert.equal(resumed.metadata.server.systemIdentifier, before.metadata.server.systemIdentifier);
			assert.equal(resumed.metadata.server.pid, before.metadata.server.pid);
		} finally {
			try {
				await home.cleanup();
			} finally {
				await listener.close();
			}
		}
	},
	REAL_RUNTIME_REINSTALL_TIMEOUT_MS,
);
