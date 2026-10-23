import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppHostModuleSpecifier } from "./app-host-modules.js";
import { installBrokerHostModules } from "./internal-intercom-broker.js";

export const INTERNAL_WORKFLOW_WORKER_ARG = "--internal-workflow-worker";

const WORKER_HOST_MODULE_SPECIFIERS: readonly AppHostModuleSpecifier[] = [
	"@bastani/atomic",
	"@bastani/atomic/storage",
	"@bastani/atomic-natives",
	"typebox",
	"typebox/compile",
	"typebox/value",
];

export function getBundledWorkflowWorkerPath(executablePath: string = process.execPath): string {
	return join(dirname(executablePath), "builtin", "workflows", "src", "local-worker-entry.mjs");
}

export async function importInternalWorkflowWorker(
	args: readonly string[],
	appPath: string,
	executablePath: string = process.execPath,
): Promise<void> {
	if (args.length !== 2) throw new Error(`${INTERNAL_WORKFLOW_WORKER_ARG} requires exactly one JSON argument`);
	if (typeof process.send !== "function") throw new Error(`${INTERNAL_WORKFLOW_WORKER_ARG} requires an IPC channel`);
	const workerPath = getBundledWorkflowWorkerPath(executablePath);
	if (!existsSync(workerPath)) throw new Error(`Atomic workflow worker entry not found at ${workerPath}`);
	process.argv.splice(2, 1);
	installBrokerHostModules(appPath, WORKER_HOST_MODULE_SPECIFIERS);
	await import(pathToFileURL(workerPath).href);
}
