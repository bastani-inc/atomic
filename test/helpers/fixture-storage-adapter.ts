import { join } from "node:path";
import { loadStorageAdapter, type StorageAdapterModule } from "@bastani/atomic/storage";
import { ENV_WORKFLOW_ARTIFACT_DIR } from "../../packages/workflows/src/shared/workflow-artifact-env.js";
import { moduleDir } from "./runtime.js";
import { temporaryAgentDir } from "./temporary-agent-dir.js";

let loaded: Promise<StorageAdapterModule> | undefined;

/**
 * `test/fixtures/storage-adapter.ts` loaded through `loadStorageAdapter`, the path a module-selected adapter takes,
 * once per test file. Each load transforms the fixture and its imports afresh, which under load costs seconds; a
 * suite that opens a connection per store would spend its time budget loading the same stateless module. Callers pass
 * their own `context` to `openDatabase`.
 */
export function loadFixtureStorageAdapter(): Promise<StorageAdapterModule> {
	loaded ??= loadStorageAdapter(join(moduleDir(import.meta.url), "../fixtures/storage-adapter.ts"), {
		agentDir: temporaryAgentDir(process.env[ENV_WORKFLOW_ARTIFACT_DIR]),
		domain: "sessions",
	});
	return loaded;
}
