/**
 * W8 under the real `/reload` ordering, not a simulated one.
 *
 * `AgentSession.reload()` emits `session_shutdown` on the old extension
 * runner, invalidates it (which stales every per-extension API facade and
 * auto-unsubscribes its event-bus subscriptions), then reloads the resource
 * loader — which re-evaluates every file extension's module graph through
 * jiti with `moduleCache: false` — and finally emits `session_start` with
 * reason `"reload"` on the freshly created extensions. The suite's other
 * replacement tests reuse one module graph and inject a raw bus as
 * `pi.events`; this file replays the host's ordering with the real loader
 * runtime, real `createExtensionAPI` facades, the real workflows extension
 * factory, and a genuine re-evaluation of the workflows module graph
 * (`vi.resetModules()`), so a run started before `/reload` must survive it
 * exactly the way it has to in production (#2247).
 */

import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createEventBus, type EventBusController } from "../../packages/coding-agent/src/core/event-bus.js";
import { createExtensionAPI } from "../../packages/coding-agent/src/core/extensions/loader-api.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import type { Extension, ExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/types.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import {
	getWorkflowLifecycleBridgeSnapshot,
	isWorkflowLifecycleBridgeEvent,
	resetWorkflowLifecycleBridgeSnapshot,
	WORKFLOW_LIFECYCLE_EVENT,
	type WorkflowLifecycleBridgeEvent,
} from "../../packages/coding-agent/src/core/workflow-lifecycle-events.js";
import * as atomicHost from "../../packages/coding-agent/src/index.js";
import type { ExtensionAPI as WorkflowsExtensionAPI } from "../../packages/workflows/src/extension/public-types.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

/**
 * Structural: each generation re-evaluates the whole workflows module graph
 * through the vite transform pipeline, the way jiti re-evaluates it on a real
 * `/reload`.
 */
const REAL_RELOAD_GRAPH_REEVALUATION_TIMEOUT_MS = 120_000;

const RUN_ID = "real-reload-survivor";

interface WorkflowsGeneration {
	readonly api: WorkflowsExtensionAPI;
	readonly runtime: ExtensionRuntime;
	readonly sentNotices: Array<{ customType: string; content: string }>;
	readonly store: typeof import("../../packages/workflows/src/shared/store.js")["store"];
	readonly stageControlRegistry: typeof import("../../packages/workflows/src/runs/foreground/stage-control-registry.js")["stageControlRegistry"];
	emitSession(type: "session_start" | "session_shutdown", reason: string): Promise<void>;
}

/**
 * Load one generation of the workflows extension the way the host loader
 * does: a fresh throwing-stub `ExtensionRuntime`, a fresh `createExtensionAPI`
 * facade over the shared bus, and the package's real factory.
 */
async function loadWorkflowsGeneration(bus: EventBusController): Promise<WorkflowsGeneration> {
	const runtime = createExtensionRuntime();
	const sentNotices: Array<{ customType: string; content: string }> = [];
	// bindCore substitutes: the host actions this test's flows reach.
	runtime.sendMessage = (message) => {
		sentNotices.push({ customType: String(message.customType), content: String(message.content) });
	};
	runtime.appendEntry = () => {};
	runtime.getActiveTools = () => [];
	runtime.getAllTools = () => [];
	runtime.setActiveTools = () => {};
	runtime.getCommands = () => [];
	const extension: Extension = {
		path: "<workflows>",
		resolvedPath: "<workflows>",
		sourceInfo: createSyntheticSourceInfo("<workflows>", { source: "builtin" }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const api = createExtensionAPI(extension, runtime, process.cwd(), bus) as unknown as WorkflowsExtensionAPI & {
		disableAsyncDiscovery?: boolean;
	};
	api.disableAsyncDiscovery = true;
	const factoryModule = (await import("../../packages/workflows/src/extension/extension-factory.js")) as {
		default: (pi: WorkflowsExtensionAPI) => void | Promise<void>;
	};
	await factoryModule.default(api);
	const storeModule = await import("../../packages/workflows/src/shared/store.js");
	const registryModule = await import("../../packages/workflows/src/runs/foreground/stage-control-registry.js");
	return {
		api,
		runtime,
		sentNotices,
		store: storeModule.store,
		stageControlRegistry: registryModule.stageControlRegistry,
		async emitSession(type, reason) {
			for (const handler of extension.handlers.get(type) ?? []) {
				await handler({ type, reason }, { hasUI: false });
			}
		},
	};
}

async function waitForRunningRun(store: WorkflowsGeneration["store"], runId: string): Promise<RunSnapshot> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const run = store.runs().find((candidate) => candidate.id === runId);
		if (run !== undefined && run.status === "running") return run;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`run ${runId} did not start`);
}

afterEach(() => {
	vi.doUnmock("@bastani/atomic");
	vi.resetModules();
});

test(
	"an in-flight run survives the real /reload ordering into the successor session",
	async () => {
		const bus = createEventBus();
		resetWorkflowLifecycleBridgeSnapshot(bus);
		const busEvents: WorkflowLifecycleBridgeEvent[] = [];
		bus.on(WORKFLOW_LIFECYCLE_EVENT, (payload) => {
			if (typeof payload === "object" && payload !== null && isWorkflowLifecycleBridgeEvent(payload)) {
				busEvents.push(payload);
			}
		});

		// Both generations must share the one live host module instance, exactly
		// as production extensions share the host baked into the process while
		// jiti re-evaluates only the extension's own modules.
		vi.doMock("@bastani/atomic", () => ({ ...atomicHost }));

		const gen1 = await loadWorkflowsGeneration(bus);
		const gen1Durable = await import("../../packages/workflows/src/durable/factory.js");
		gen1Durable.setDurableBackend(gen1Durable.createInMemoryTestBackend());
		await gen1.emitSession("session_start", "startup");

		const { workflow } = await import("../../packages/workflows/src/authoring/workflow.js");
		const { run } = await import("../../packages/workflows/src/runs/foreground/executor.js");
		const { makePersistencePort } = await import("../../packages/workflows/src/extension/workflow-ports.js");

		let releaseGate = (): void => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const definition = workflow({
			name: "reload-survivor",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.tool("wait-for-reload", {}, async () => {
					await gate;
					return { ok: true };
				});
				return {};
			},
		});
		const controller = new AbortController();
		// The predecessor's own persistence port: after `/reload` invalidates its
		// API, run-end transcript appends from the still-running graph must not
		// fail the run.
		const persistence = makePersistencePort(gen1.api, true);
		const execution = run(
			definition,
			{},
			{
				runId: RUN_ID,
				store: gen1.store,
				signal: controller.signal,
				stageControlRegistry: gen1.stageControlRegistry,
				...(persistence === undefined ? {} : { persistence }),
			},
		);
		await waitForRunningRun(gen1.store, RUN_ID);

		// --- the real /reload ordering (agent-session-extension-bindings.reload) ---
		await gen1.emitSession("session_shutdown", "reload");
		gen1.runtime.invalidate();
		vi.resetModules();
		const gen2 = await loadWorkflowsGeneration(bus);
		await gen2.emitSession("session_start", "reload");

		// The successor observes the in-flight run through its own module graph:
		// this is what `/workflow status` resolves against ("run not found" when
		// the graph re-evaluation loses the store).
		const successorRun = gen2.store.runs().find((candidate) => candidate.id === RUN_ID);
		assert.ok(successorRun !== undefined, "successor session must still observe the in-flight run after /reload");
		assert.equal(successorRun.status, "running");
		assert.equal(successorRun.endedAt, undefined);

		// The successor's bridge kept the run's neutral working contribution
		// instead of dropping it as unobservable (the Herdr pane's idle symptom).
		const workingSnapshot = getWorkflowLifecycleBridgeSnapshot(bus);
		assert.ok(
			workingSnapshot.some((event) => event.runKey === RUN_ID),
			"the neutral lifecycle snapshot must retain the live run across /reload",
		);

		// Completion in the orphaned predecessor graph reaches the successor.
		releaseGate();
		await execution;
		const endedRun = gen2.store.runs().find((candidate) => candidate.id === RUN_ID);
		assert.equal(endedRun?.status, "completed");
		assert.ok(
			busEvents.some((event) => event.runKey === RUN_ID && event.kind === "completed"),
			"the successor must publish the completed bridge event",
		);
		assert.ok(
			gen1.sentNotices.length + gen2.sentNotices.length > 0 &&
				gen2.sentNotices.some((notice) => notice.content.includes("completed")),
			"the completion notice must be delivered through the successor session",
		);
		assert.equal(
			getWorkflowLifecycleBridgeSnapshot(bus).some((event) => event.runKey === RUN_ID),
			false,
			"the completed run must leave the neutral snapshot",
		);
	},
	REAL_RELOAD_GRAPH_REEVALUATION_TIMEOUT_MS,
);
