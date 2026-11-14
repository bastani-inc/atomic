import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import * as provider from "../../packages/coding-agent/src/core/storage/provider.js";
import { collectStorageStatus } from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

test("the status probe opens an adapter with its live secrets read through the context (#4793)", async () => {
	const root = makeTempDirectory("storage-status-live-secrets-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			storage: {
				adapter: "live-adapter",
				options: { url: "postgres://example" },
				secrets: { password: { env: "ATOMIC_TEST_STATUS_PASSWORD_4793" } },
			},
		}),
	);
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
	])
		vi.stubEnv(name, "");
	vi.stubEnv("ATOMIC_TEST_STATUS_PASSWORD_4793", "pw");
	const opened: { options: provider.AdapterOptions; password: string }[] = [];
	vi.spyOn(provider, "loadStorageAdapter").mockResolvedValue({
		atomicStorageAdapter: 1,
		liveSecrets: ["password"],
		openDatabase: async (options, context) => {
			opened.push({ options, password: (await context.secret?.("password")) ?? "" });
			return openNodeSqliteDatabase(":memory:");
		},
	});
	try {
		const status = await collectStorageStatus({ cwd: root, agentDir, probe: true });
		assert.ok(opened.length > 0);
		for (const open of opened) assert.deepEqual(open, { options: { url: "postgres://example" }, password: "pw" });
		assert.ok(status.domains.some((domain) => domain.probe?.connection.status !== "failed"));
	} finally {
		removeTempDirectory(root);
	}
});
