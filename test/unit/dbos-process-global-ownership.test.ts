/**
 * #2022 / #2462: DBOS lifecycle and wrappers live outside the reloadable bundle.
 * Re-evaluate the durability graph over one process-global SDK; each fixed
 * operation registers once, with no in-memory fallback.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { extensionLoaderTestHooks } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.ts";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import {
	DbosShutdownError,
	dbosLifecycleState,
	launchDbosOnce,
	resetDbosLifecycleForTests,
} from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import type { DbosStatic } from "../../packages/workflows/src/durable/dbos-sdk-handle.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import type { WorkflowSerializableValue } from "../../packages/workflows/src/shared/types.js";

const DBOS_PROCESS_OWNER_KEY = Symbol.for("atomic-workflows/dbos-process-owner@1");
const DURABILITY_MODULE_GRAPH_RELOAD_TIMEOUT_MS = 120_000;
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const durableGraph = join(repoRoot, "test/unit/dbos-process-global-ownership-graph.ts");

type DurableGraph = typeof import("./dbos-process-global-ownership-graph.ts");
type RegisteredWrapper = (...args: readonly WorkflowSerializableValue[]) => Promise<WorkflowSerializableValue>;
type SharedFakeDbos = DbosStatic & {
	readonly registeredNames: () => readonly string[];
	readonly wrapperFor: (name: string) => RegisteredWrapper | undefined;
	readonly shutdownCount: () => number;
	readonly setConfigCount: () => number;
};

interface ProcessOwnerView {
	readonly version: 1;
	readonly state: string;
	readonly wrappers?: { readonly mainWorkflow: RegisteredWrapper; readonly checkpointWorkflow: RegisteredWrapper };
}

let graphGeneration = 0;
let originalDatabaseUrl: string | undefined;
const emptyHandle = { getStatus: async () => null, getResult: async () => null };

function createSharedFakeDbos(): SharedFakeDbos {
	const wrappers = new Map<string, RegisteredWrapper>();
	const registeredNames: string[] = [];
	let shutdowns = 0;
	let launched = false;
	let setConfigs = 0;
	const sdk: SharedFakeDbos = {
		registeredNames: () => registeredNames,
		wrapperFor: (name) => wrappers.get(name),
		shutdownCount: () => shutdowns,
		setConfigCount: () => setConfigs,
		setConfig() {
			if (launched) throw new Error("Cannot call DBOS.setConfig after DBOS.launch");
			setConfigs += 1;
		},
		async launch() {
			launched = true;
		},
		async shutdown() {
			shutdowns += 1;
		},
		registerWorkflow(fn, config) {
			const name = config?.name ?? fn.name;
			registeredNames.push(name);
			if (wrappers.has(name)) throw new Error(`Operation (Name: .${name}) is already registered.`);
			const wrapper: RegisteredWrapper = async (...args) => await (fn as RegisteredWrapper)(...args);
			wrappers.set(name, wrapper);
			return wrapper;
		},
		startWorkflow() {
			return async () => emptyHandle;
		},
		retrieveWorkflow() {
			return emptyHandle;
		},
		async resumeWorkflow(workflowId) {
			return sdk.retrieveWorkflow(workflowId);
		},
		async cancelWorkflow() {},
		async listWorkflows() {
			return [];
		},
		async deleteWorkflows() {},
	};
	return sdk;
}

function processOwner(): ProcessOwnerView | undefined {
	const value = (globalThis as typeof globalThis & Record<symbol, ProcessOwnerView | undefined>)[
		DBOS_PROCESS_OWNER_KEY
	];
	return value?.version === 1 && typeof value.state === "string" ? value : undefined;
}

async function evaluateDurabilityGraph(sdk: SharedFakeDbos): Promise<DurableGraph> {
	const atomic = await import("@bastani/atomic");
	graphGeneration += 1;
	const aliases = { ...extensionLoaderTestHooks.getAliases() };
	delete aliases["@bastani/atomic"];
	const url = pathToFileURL(durableGraph);
	url.searchParams.set("atomicExtensionCache", `${graphGeneration}:${Date.now()}:${Math.random()}`);
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		fsCache: extensionLoaderTestHooks.getTranspileCacheDir(),
		alias: aliases,
		virtualModules: { "@bastani/atomic": atomic, "@dbos-inc/dbos-sdk": { DBOS: sdk } },
	});
	return (await jiti.import(url.href)) as DurableGraph;
}

beforeEach(() => {
	originalDatabaseUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
	process.env.DBOS_SYSTEM_DATABASE_URL = "postgresql://atomic-dbos-ownership-probe/dbos";
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

afterEach(() => {
	if (originalDatabaseUrl === undefined) delete process.env.DBOS_SYSTEM_DATABASE_URL;
	else process.env.DBOS_SYSTEM_DATABASE_URL = originalDatabaseUrl;
	setDurableBackend(undefined);
	resetDbosLifecycleForTests();
});

describe("process-global DBOS ownership", () => {
	test.sequential(
		"registers each fixed operation once across repeated durability-graph evaluation",
		async () => {
			const sdk = createSharedFakeDbos();
			const warnings: string[] = [];
			const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
				warnings.push(args.map(String).join(" "));
			});
			try {
				const first = await evaluateDurabilityGraph(sdk);
				const firstBackend = await first.initializeDurableBackend();

				assert.equal(first.dbosLifecycleState(), "ready");
				assert.equal(firstBackend.persistent, true);
				assert.equal(firstBackend instanceof InMemoryDurableBackend, false);
				assert.deepEqual(sdk.registeredNames(), ["atomicWorkflowHandle", "atomicWorkflowCheckpoint"]);

				const handleWrapper = sdk.wrapperFor("atomicWorkflowHandle");
				const checkpointWrapper = sdk.wrapperFor("atomicWorkflowCheckpoint");
				assert.ok(handleWrapper);
				assert.ok(checkpointWrapper);

				const second = await evaluateDurabilityGraph(sdk);
				assert.equal(second.dbosLifecycleState(), "ready", "re-evaluation must observe the original lifecycle");

				const secondConfigured = await second.configureDbosDurableBackend();
				const secondBackend = await second.initializeDurableBackend();

				assert.equal(sdk.setConfigCount(), 1);
				assert.deepEqual(sdk.registeredNames(), ["atomicWorkflowHandle", "atomicWorkflowCheckpoint"]);
				assert.equal(secondBackend.persistent, true);
				assert.equal(secondBackend instanceof InMemoryDurableBackend, false);
				assert.equal(secondBackend, firstBackend);
				assert.equal(warnings.filter((message) => message.includes("NON-DURABLY")).length, 0);

				const owner = processOwner();
				assert.ok(owner, "owner must live on globalThis[Symbol.for(...@1)]");
				assert.equal(owner.version, 1);
				assert.equal(owner.state, "ready");
				assert.equal(owner.wrappers?.mainWorkflow, handleWrapper);
				assert.equal(owner.wrappers?.checkpointWorkflow, checkpointWrapper);
				assert.ok(secondConfigured.backend.persistent);
			} finally {
				consoleSpy.mockRestore();
			}
		},
		DURABILITY_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
	);

	test.sequential(
		"quit still flushes and shuts DBOS down exactly once",
		async () => {
			const sdk = createSharedFakeDbos();
			const first = await evaluateDurabilityGraph(sdk);
			await first.initializeDurableBackend();
			const second = await evaluateDurabilityGraph(sdk);
			await second.initializeDurableBackend();

			await Promise.all([first.shutdownDbos(), second.shutdownDbos()]);
			assert.equal(sdk.shutdownCount(), 1);
			assert.equal(first.dbosLifecycleState(), "shut_down");
			assert.equal(second.dbosLifecycleState(), "shut_down");
			assert.equal(dbosLifecycleState(), "shut_down");

			await assert.rejects(first.launchDbosOnce(), first.DbosShutdownError);
			await assert.rejects(second.launchDbosOnce(), second.DbosShutdownError);
			await assert.rejects(launchDbosOnce(), DbosShutdownError);
			await assert.rejects(first.initializeDurableBackend(), first.DbosShutdownError);
			await assert.rejects(second.initializeDurableBackend(), second.DbosShutdownError);
		},
		DURABILITY_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
	);

	test.sequential(
		"resetDbosLifecycleForTests clears the process-global slot",
		async () => {
			const sdk = createSharedFakeDbos();
			const first = await evaluateDurabilityGraph(sdk);
			await first.initializeDurableBackend();
			assert.equal(processOwner()?.state, "ready");
			assert.ok(processOwner()?.wrappers);

			first.resetDbosLifecycleForTests();
			assert.equal(processOwner()?.state, "uninitialized");
			assert.equal(processOwner()?.wrappers, undefined);
			assert.equal(first.dbosLifecycleState(), "uninitialized");
			assert.equal(dbosLifecycleState(), "uninitialized");
		},
		DURABILITY_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
	);
});
