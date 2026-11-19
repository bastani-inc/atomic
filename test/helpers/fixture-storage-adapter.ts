import { join } from "node:path";
import { loadStorageAdapter, type StorageAdapterModule } from "@bastani/atomic/storage";
import { beforeAll } from "vitest";
import { moduleDir } from "./runtime.js";
import { temporaryAgentDir } from "./temporary-agent-dir.js";

/**
 * Budget for a test file's first `loadStorageAdapter`. That load imports the adapter loader's own modules (settings
 * and package-manager resolution among them), which vitest transforms from source on first use: about 6 s on an idle
 * machine, and past the 30 s default per-test budget on a loaded one. Later loads reuse those modules and take
 * milliseconds.
 */
const FIRST_ADAPTER_LOAD_TIMEOUT_MS = 180_000;

/**
 * Loads `test/fixtures/storage-adapter.ts` through `loadStorageAdapter`, the path a module-selected adapter takes,
 * once before the calling file's tests, so the one-time cost of the first load is not charged to whichever test opens
 * the first connection. Returns the loaded module; callers pass their own `context` to `openDatabase`.
 */
export function useFixtureStorageAdapter(): () => StorageAdapterModule {
	let adapter: StorageAdapterModule | undefined;
	beforeAll(async () => {
		adapter = await loadStorageAdapter(join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"), {
			agentDir: temporaryAgentDir(process.env.ATOMIC_TEST_RUN_DIR),
			domain: "sessions",
		});
	}, FIRST_ADAPTER_LOAD_TIMEOUT_MS);
	return () => {
		if (adapter === undefined) throw new Error("the fixture storage adapter loads in beforeAll");
		return adapter;
	};
}
