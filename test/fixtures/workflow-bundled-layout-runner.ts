import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";

type Sdk = typeof import("./workflow-bundled-layout-entry.js");

const [bundlePath = "", scenario = ""] = process.argv.slice(2);
const FIXTURES = dirname(fileURLToPath(import.meta.url));
const sdk: Sdk = await import(pathToFileURL(bundlePath).href);

const poolModule = (): { readonly pool: WorkflowDefinition; readonly child: WorkflowDefinition } =>
	sdk.loadWorkflowModule(join(FIXTURES, "workflow-bundled-user-pool.ts")) as never;
const healthyDefinition = (): WorkflowDefinition =>
	(sdk.loadWorkflowModule(join(FIXTURES, "workflow-bundled-user-healthy.ts")) as { healthy: WorkflowDefinition })
		.healthy;

const options = (definitions: WorkflowDefinition[]) => ({
	registry: sdk.createRegistry(definitions),
	store: sdk.createStore(),
	journal: new sdk.MemoryRunJournal(),
	adapters: {
		prompt: {
			prompt: async (): Promise<string> => "unused",
		},
	},
});

function failInsideBundle(): void {
	void (async () => {
		sdk.createRegistry(null as never);
	})();
}

const summary = (result: { readonly status: string; readonly error?: string }) => ({
	status: result.status,
	error: result.error,
});

if (scenario === "author-pool") {
	const { pool, child } = poolModule();
	const healthy = healthyDefinition();
	const poolRun = sdk.run(pool, {}, options([pool, child, healthy]));
	const healthyRun = sdk.run(healthy, {}, options([healthy]));
	const poolResult = await poolRun;
	const healthyResult = await healthyRun;
	await delay(100);
	console.log(JSON.stringify({ pool: summary(poolResult), healthy: summary(healthyResult) }));
} else if (scenario === "host-rejection-live") {
	const healthy = healthyDefinition();
	setTimeout(failInsideBundle, 100);
	const healthyResult = await sdk.run(healthy, {}, options([healthy]));
	console.log(JSON.stringify({ healthy: summary(healthyResult) }));
} else if (scenario === "host-rejection-after-runs") {
	const healthy = healthyDefinition();
	const healthyResult = await sdk.run(healthy, {}, options([healthy]));
	console.log(JSON.stringify({ healthy: summary(healthyResult) }));
	await delay(100);
	failInsideBundle();
	await delay(300);
} else if (scenario === "host-rejection-no-run") {
	failInsideBundle();
	await delay(300);
} else if (scenario === "unnamed") {
	const loaded = sdk.loadWorkflowModule(join(FIXTURES, "workflow-bundled-user-unnamed.ts")) as {
		default: WorkflowDefinition;
	};
	console.log(JSON.stringify({ name: loaded.default.name, source: sdk.workflowSource(loaded.default) }));
} else {
	throw new Error(`unknown scenario "${scenario}"`);
}
