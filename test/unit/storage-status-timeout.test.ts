import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { SqliteDatabase } from "../../packages/coding-agent/src/core/storage/database.js";
import * as provider from "../../packages/coding-agent/src/core/storage/provider.js";
import {
	collectStorageStatus,
	STORAGE_PROBE_TIMEOUT_MS,
} from "../../packages/coding-agent/src/core/storage/storage-status.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

test("status finishes when both the adapter query and close stall (#3856)", async () => {
	const root = makeTempDirectory("storage-timeout-");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ storage: { adapter: "stalled-adapter" } }));
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
	])
		vi.stubEnv(name, "");
	const stalled = new Promise<never>(() => {});
	const get = vi.fn(() => stalled);
	const close = vi.fn(() => stalled);
	const database: SqliteDatabase = {
		descriptor: { adapter: "stalled", location: "fixture" },
		exec: () => stalled,
		run: () => stalled,
		all: () => stalled,
		transaction: () => stalled,
		get,
		close,
	};
	vi.spyOn(provider, "loadStorageAdapter").mockResolvedValue({
		atomicStorageAdapter: 1,
		openDatabase: async () => database,
	});
	vi.useFakeTimers();
	try {
		let settled = false;
		const pending = collectStorageStatus({ cwd: root, agentDir, probe: true }).then((status) => {
			settled = true;
			return status;
		});
		await vi.waitFor(() => assert.equal(get.mock.calls.length, 1));
		await vi.advanceTimersByTimeAsync(STORAGE_PROBE_TIMEOUT_MS);
		assert.equal(close.mock.calls.length, 1);
		await vi.advanceTimersByTimeAsync(STORAGE_PROBE_TIMEOUT_MS * 4);
		assert.equal(settled, true, "database.close must not hold status open forever");
		const status = await pending;
		assert.ok(status.domains.every((domain) => domain.probe?.connection.status === "failed"));
	} finally {
		removeTempDirectory(root);
	}
});
