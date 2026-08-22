/**
 * Real second evaluation of the workflows module graph over one shared host
 * scope. `/reload` re-evaluates that graph through jiti (`tryNative: false`,
 * `atomicExtensionCache` bust, `moduleCache: false`) while the session event
 * bus stays put; this file drives that same host loader, not a stub of it.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentSession } from "@bastani/atomic";
import { createJiti } from "jiti/static";
import { beforeEach, test } from "vitest";
import { createEventBus, type EventBusController } from "../../packages/coding-agent/src/core/event-bus.ts";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader-core.ts";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.ts";
import { extensionLoaderTestHooks } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.ts";
import type {
	Extension,
	ExtensionFactory,
	ExtensionRuntime,
} from "../../packages/coding-agent/src/core/extensions/types.ts";
import { dbosLifecycleState } from "../../packages/workflows/src/durable/dbos-lifecycle.ts";
import type { ToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.ts";
import type { CancellationRegistry } from "../../packages/workflows/src/runs/background/cancellation-registry.ts";
import type { JobTracker } from "../../packages/workflows/src/runs/background/job-tracker.ts";
import type {
	StageControlHandle,
	StageControlRegistry,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.ts";
import { resetSessionScopedSingletonPreAdoptionForTests } from "../../packages/workflows/src/shared/session-scoped-singleton.ts";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.ts";
import type { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.ts";
import type { Store } from "../../packages/workflows/src/shared/store.ts";
import { readText } from "../helpers/runtime.ts";

beforeEach(() => {
	resetSessionScopedSingletonPreAdoptionForTests();
});

/** Full transformed re-evaluation of the workflows graph, twice, through the host loader. */
const WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS = 120_000;
const EARLY_FAILURE_REPORT_ENV = "ATOMIC_REAL_RELOAD_EARLY_FAILURE_REPORT";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowsSrc = join(repoRoot, "packages/workflows/src");
const graphEntry = join(repoRoot, "test/helpers/workflow-graph-generation.ts");

const SINGLETON_SOURCES = {
	store: join(workflowsSrc, "shared/store-factory.ts"),
	stageControl: join(workflowsSrc, "runs/foreground/stage-control-registry.ts"),
	cancellation: join(workflowsSrc, "runs/background/cancellation-registry.ts"),
	toolControl: join(workflowsSrc, "engine/run-tool-control-registry.ts"),
	jobTracker: join(workflowsSrc, "runs/background/job-tracker.ts"),
	stageUi: join(workflowsSrc, "shared/stage-ui-broker.ts"),
} as const;

interface WorkflowGeneration {
	readonly store: Store;
	readonly stageControlRegistry: StageControlRegistry;
	readonly cancellationRegistry: CancellationRegistry;
	readonly toolControlRegistry: ToolControlRegistry;
	readonly jobTracker: JobTracker;
	readonly stageUiBroker: StageUiBroker;
	readonly factory: ExtensionFactory;
	readonly adoptWorkflowSessionRunState?: (scope: object | undefined) => void;
}

type SessionHandler = (event: unknown, context?: unknown) => Promise<unknown> | unknown;

async function emitSessionEvent(
	extension: Extension,
	event: string,
	payload: unknown,
	context?: unknown,
): Promise<void> {
	for (const handler of extension.handlers.get(event) ?? []) {
		await (handler as SessionHandler)(payload, context);
	}
}

interface WidgetCall {
	readonly key: string;
	readonly factory?: (tui: unknown, theme: unknown) => { render(width: number): string[] };
	readonly placement?: string;
}

function createWidgetUi(): { readonly ui: object; readonly calls: WidgetCall[]; readonly renders: { count: number } } {
	const calls: WidgetCall[] = [];
	const renders = { count: 0 };
	return {
		calls,
		renders,
		ui: {
			setWidget(key: string, factory: WidgetCall["factory"], options?: { readonly placement?: string }): void {
				calls.push({ key, factory, placement: options?.placement });
			},
			requestRender(): void {
				renders.count += 1;
			},
			notify(): void {},
		},
	};
}

function createTrackedEventBus(): {
	readonly bus: EventBusController;
	readonly listenerCount: () => number;
} {
	const underlying = createEventBus();
	let listeners = 0;
	return {
		bus: {
			emit: underlying.emit,
			on(channel, handler) {
				listeners += 1;
				const unsubscribe = underlying.on(channel, handler);
				let active = true;
				return () => {
					if (!active) return;
					active = false;
					listeners -= 1;
					unsubscribe();
				};
			},
			clear() {
				listeners = 0;
				underlying.clear();
			},
		},
		listenerCount: () => listeners,
	};
}

let graphGeneration = 0;

function hostAliases(): Record<string, string> {
	const aliases = { ...extensionLoaderTestHooks.getAliases() };
	delete aliases["@bastani/atomic"];
	return aliases;
}

function cacheBustedHref(file: string, cacheKey: string): string {
	const url = pathToFileURL(file);
	url.searchParams.set("atomicExtensionCache", cacheKey);
	return url.href;
}

async function evaluateWorkflowGraph(): Promise<WorkflowGeneration> {
	// Live host module: both generations must share the layer-1 WeakMap. The
	// binary loader injects the same object via virtualModules; /reload must
	// not re-evaluate `@bastani/atomic` into a second primitive.
	const atomic = await import("@bastani/atomic");
	graphGeneration += 1;
	const cacheKey = `${graphGeneration}:${Date.now()}:${Math.random()}`;
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		fsCache: extensionLoaderTestHooks.getTranspileCacheDir(),
		alias: hostAliases(),
		virtualModules: { "@bastani/atomic": atomic },
	});

	const loaded = (await jiti.import(cacheBustedHref(graphEntry, cacheKey))) as WorkflowGeneration;
	return loaded;
}

/**
 * The installed Node package uses the loader's on-disk alias for
 * `@bastani/atomic`, so jiti evaluates a host-module copy alongside the native
 * loader that created `pi.events`. This is the release-0.9.15 path; using a
 * virtual module here would conceal the split that lost canonical bus identity.
 */
async function evaluateInstalledWorkflowGraph(): Promise<WorkflowGeneration> {
	graphGeneration += 1;
	const cacheKey = `installed:${graphGeneration}:${Date.now()}:${Math.random()}`;
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false,
		fsCache: extensionLoaderTestHooks.getTranspileCacheDir(),
		alias: extensionLoaderTestHooks.getAliases(),
	});
	return (await jiti.import(cacheBustedHref(graphEntry, cacheKey))) as WorkflowGeneration;
}

interface GlobalIncidentStateEntry {
	siblingExecutions: number;
	watcherExecutions: number;
	watcherRunning: boolean;
}

type GlobalIncidentState = Record<string, GlobalIncidentStateEntry>;

interface WorkflowDispatchDetails {
	readonly action: string;
	readonly runId: string;
	readonly status: string;
	readonly error?: string;
}

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.equal(predicate(), true, `timed out waiting for ${label}`);
}

function globalIncidentSource(): string {
	return `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

const stateDir = process.env.ATOMIC_GLOBAL_RELOAD_STATE_DIR;
if (!stateDir) throw new Error("ATOMIC_GLOBAL_RELOAD_STATE_DIR is required");
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, "state.json");
const readState = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const update = (label, change) => {
  const state = readState();
  const current = state[label] ?? { siblingExecutions: 0, watcherExecutions: 0, watcherRunning: false };
  change(current);
  state[label] = current;
  writeFileSync(statePath, JSON.stringify(state), "utf8");
  return current;
};

export default workflow({
  name: "global-publish-watch",
  description: "User-global zero-stage publish watcher used by the reload lifecycle regression.",
  inputs: { label: Type.String() },
  outputs: { sibling: Type.String(), watcher: Type.String() },
  run: async (ctx) => {
    const label = ctx.inputs.label;
    const sibling = await ctx.tool("cached-sibling", { label }, async () => {
      const state = update(label, (current) => { current.siblingExecutions += 1; });
      return "cached-" + state.siblingExecutions;
    });
    const watcher = await ctx.tool("publish-watcher", { label }, async (toolContext) => {
      update(label, (current) => { current.watcherExecutions += 1; current.watcherRunning = true; });
      const releasePath = join(stateDir, label + ".release");
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          if (!existsSync(releasePath)) return;
          clearInterval(timer);
          resolve(undefined);
        }, 10);
        const signal = toolContext?.signal;
        signal?.addEventListener("abort", () => {
          clearInterval(timer);
          reject(new Error("publish-watcher aborted"));
        }, { once: true });
      });
      update(label, (current) => { current.watcherRunning = false; });
      return "published-" + label;
    });
    return { sibling, watcher };
  },
});
`;
}

function readGlobalIncidentState(stateDir: string): GlobalIncidentState {
	const path = join(stateDir, "state.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as GlobalIncidentState) : {};
}

function workflowTool(extension: Extension) {
	const registration = extension.tools.get("workflow");
	assert.ok(registration, "the public workflow tool must be registered");
	return registration.definition;
}

async function executeWorkflowTool(
	extension: Extension,
	callId: string,
	args: Record<string, unknown>,
	context: Record<string, unknown>,
): Promise<WorkflowDispatchDetails> {
	const result = await workflowTool(extension).execute(callId, args, undefined, undefined, context as never);
	return result.details as WorkflowDispatchDetails;
}

function createHostRuntime(): ReturnType<typeof createExtensionRuntime> {
	const runtime = createExtensionRuntime();
	Object.assign(runtime, {
		sendMessage: () => undefined,
		sendMessages: () => undefined,
		sendUserMessage: () => undefined,
		appendEntry: () => `entry-${Date.now()}`,
		setSessionName: () => undefined,
		getSessionName: () => undefined,
		setLabel: () => undefined,
		getActiveTools: () => ["workflow"],
		getAllTools: () => [],
		setActiveTools: () => undefined,
		getCommands: () => [],
		getThinkingLevel: () => "off",
		setThinkingLevel: () => undefined,
	});
	return runtime;
}

function emitReloadEvidence(event: string, details: Record<string, unknown>): void {
	if (process.env.ATOMIC_RELOAD_EVIDENCE !== "1") return;
	console.log(`RELOAD-EVIDENCE ${event} ${JSON.stringify(details)}`);
}

function stageHandle(runId: string, stageId: string): StageControlHandle {
	return {
		runId,
		stageId,
		stageName: stageId,
		status: "running",
		sessionId: undefined,
		sessionFile: undefined,
		isStreaming: false,
		messages: [] as AgentSession["messages"],
		async ensureAttached() {},
		async prompt() {},
		async steer() {},
		async followUp() {},
		async pause() {},
		async resume() {
			return undefined;
		},
		subscribe: () => () => {},
	};
}

function recordGenerationState(
	generation: WorkflowGeneration,
	ids: {
		readonly runId: string;
		readonly stageId: string;
		readonly nodeId: string;
		readonly controller: AbortController;
		readonly toolController: AbortController;
	},
	settled: Promise<void> = Promise.resolve(),
): void {
	generation.store.recordRunStart({
		id: ids.runId,
		name: "reload-survive",
		inputs: {},
		status: "running",
		stages: [],
		startedAt: 1,
	});
	generation.store.recordToolNodeStart(ids.runId, {
		kind: "tool",
		id: ids.nodeId,
		name: "reload-tool",
		argsHash: "reload-tool-hash",
		ordinal: 0,
		parentIds: [],
		status: "pending",
		attachable: false,
	});
	generation.store.recordToolNodeRunning(ids.runId, ids.nodeId, 2);
	generation.stageControlRegistry.register(stageHandle(ids.runId, ids.stageId));
	generation.cancellationRegistry.register(ids.runId, ids.controller);
	generation.toolControlRegistry.register({
		runId: ids.runId,
		nodeId: ids.nodeId,
		name: "reload-tool",
		controller: ids.toolController,
		settled,
	});
	generation.jobTracker.register({
		runId: ids.runId,
		controller: ids.controller,
		promise: settled,
	});
	const adapter = buildStagePromptAdapter(
		"prompt-reload",
		"ask_user_question",
		{ questions: [{ question: "Keep going?", options: [{ label: "Yes" }, { label: "No" }] }] },
		1,
	);
	assert.ok(adapter);
	generation.stageUiBroker.provideStagePrompt(ids.runId, ids.stageId, adapter);
	void generation.stageUiBroker.requestCustomUi(ids.runId, ids.stageId, () => ({
		render: () => [],
		invalidate: () => {},
	}));
}

function assertGenerationSeesRun(
	generation: WorkflowGeneration,
	ids: {
		readonly runId: string;
		readonly stageId: string;
		readonly nodeId: string;
		readonly controller: AbortController;
		readonly toolController: AbortController;
	},
	label: string,
): void {
	assert.equal(generation.store.runs()[0]?.id, ids.runId, `${label}: store`);
	assert.equal(generation.stageControlRegistry.get(ids.runId, ids.stageId)?.stageId, ids.stageId, `${label}: stage`);
	assert.equal(generation.cancellationRegistry.isAborted(ids.runId), false, `${label}: cancellation`);
	assert.equal(generation.toolControlRegistry.get(ids.runId, ids.nodeId)?.name, "reload-tool", `${label}: tool`);
	assert.equal(
		generation.store.runs()[0]?.toolNodes?.find((node) => node.id === ids.nodeId)?.status,
		"running",
		`${label}: live tool node`,
	);
	assert.equal(generation.jobTracker.has(ids.runId), true, `${label}: job`);
	assert.equal(generation.stageUiBroker.peekStagePrompt(ids.runId, ids.stageId)?.id, "prompt-reload", `${label}: ui`);
	assert.equal("abort" in generation.cancellationRegistry, true, `${label}: has`);
}

test(
	"a second evaluation of the workflows module graph over one host scope sees and controls the first generation's run state",
	async () => {
		const bus = createEventBus();
		const widget = createWidgetUi();
		let resolveCallback: (() => void) | undefined;
		let callbackSettlements = 0;
		const callbackSettled = new Promise<void>((resolve) => {
			resolveCallback = resolve;
		}).then(() => {
			callbackSettlements += 1;
		});
		const first = await evaluateWorkflowGraph();
		const firstExtension = await loadExtensionFromFactory(first.factory, repoRoot, bus, createExtensionRuntime());
		await emitSessionEvent(firstExtension, "session_start", { reason: "startup" }, { hasUI: true, ui: widget.ui });
		const ids = {
			runId: "reload-run",
			stageId: "reload-stage",
			nodeId: "reload-node",
			controller: new AbortController(),
			toolController: new AbortController(),
		};
		recordGenerationState(first, ids, callbackSettled);
		const firstFactory = widget.calls.findLast((call) => call.factory !== undefined);
		assert.ok(firstFactory?.factory, "the initial active tool-only run must mount the widget");
		assert.equal(firstFactory.placement, "belowEditor");
		assert.match(firstFactory.factory(undefined, undefined).render(120).join("\n"), /reload-tool · running/);

		await emitSessionEvent(firstExtension, "session_shutdown", { reason: "reload" });
		const second = await evaluateWorkflowGraph();
		assert.notEqual(second.store, first.store, "each evaluation holds its own facade");
		const secondExtension = await loadExtensionFromFactory(second.factory, repoRoot, bus, createExtensionRuntime());
		await emitSessionEvent(secondExtension, "session_start", { reason: "reload" }, { hasUI: true, ui: widget.ui });
		const secondFactory = widget.calls.findLast((call) => call.factory !== undefined);
		assert.ok(secondFactory?.factory, "the replacement generation must remount the active run");
		assert.notEqual(secondFactory, firstFactory);
		assert.match(secondFactory.factory(undefined, undefined).render(120).join("\n"), /reload-tool · running/);
		assert.deepEqual(secondFactory.factory(undefined, undefined).render(60), [" ▾  1 background · 1 ● · 1 tool"]);

		assertGenerationSeesRun(second, ids, "second generation");
		assert.ok(resolveCallback);
		resolveCallback();
		await callbackSettled;
		assert.equal(callbackSettlements, 1, "the adopted in-flight callback settles exactly once");
		assert.equal(
			first.store.recordToolNodeEnd(ids.runId, ids.nodeId, {
				status: "completed",
				endedAt: 3,
				resultSummary: '"published"',
			}),
			true,
		);
		assert.equal(second.store.runs()[0]?.toolNodes?.[0]?.status, "completed");
		assert.doesNotMatch(secondFactory.factory(undefined, undefined).render(120).join("\n"), /reload-tool · running/);
		assert.equal(second.cancellationRegistry.abort(ids.runId), true);
		assert.equal(ids.controller.signal.aborted, true);
		assert.equal(second.toolControlRegistry.get(ids.runId, ids.nodeId)?.abort("node").scope, "node");
		assert.equal(ids.toolController.signal.aborted, true);
		assert.equal(second.stageControlRegistry.get(ids.runId, ids.stageId)?.status, "running");
		assert.equal(second.jobTracker.get(ids.runId)?.controller, ids.controller);
		assert.equal(second.stageUiBroker.answerStagePrompt(ids.runId, ids.stageId, { text: "Yes" }), true);
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test.sequential(
	"user-global agent launch keeps its real publish watcher through resource and installed full reload",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-global-reload-"));
		const earlyFailureReportPath = process.env[EARLY_FAILURE_REPORT_ENV];
		if (earlyFailureReportPath !== undefined) writeFileSync(earlyFailureReportPath, root, "utf8");
		const agentDir = join(root, "agent");
		const stateDir = join(root, "state");
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(agentDir, "workflows", "global-publish-watch.ts"), globalIncidentSource(), "utf8");
		const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
		const previousStateDir = process.env.ATOMIC_GLOBAL_RELOAD_STATE_DIR;
		process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
		process.env.ATOMIC_GLOBAL_RELOAD_STATE_DIR = stateDir;
		const trackedBus = createTrackedEventBus();
		const runtimes: ExtensionRuntime[] = [];
		const trackedJobs = new Set<Promise<void>>();
		const trackedRunIds = new Set<string>();
		let firstGeneration: WorkflowGeneration | undefined;
		let secondGeneration: WorkflowGeneration | undefined;
		let firstExtension: Extension | undefined;
		let secondExtension: Extension | undefined;
		let listenersAfterCleanup: number | undefined;
		let dbosStateAfterCleanup: ReturnType<typeof dbosLifecycleState> | undefined;

		try {
			const bus = trackedBus.bus;
			const widget = createWidgetUi();
			const context = { hasUI: true, sessionId: "active-chat-turn", ui: widget.ui };
			const first = await evaluateInstalledWorkflowGraph();
			firstGeneration = first;
			const firstRuntime = createHostRuntime();
			runtimes.push(firstRuntime);
			firstExtension = await loadExtensionFromFactory(first.factory, repoRoot, bus, firstRuntime);
			await emitSessionEvent(firstExtension, "session_start", { reason: "startup" }, context);
			await emitSessionEvent(firstExtension, "turn_start", { type: "turn_start" }, context);

			const beforeLaunchReload = await executeWorkflowTool(
				firstExtension,
				"reload-before",
				{ action: "reload" },
				context,
			);
			assert.equal(beforeLaunchReload.action, "reload");
			assert.equal(beforeLaunchReload.status, "ok", beforeLaunchReload.error);

			const widgetCallStart = widget.calls.length;
			const launched = await executeWorkflowTool(
				firstExtension,
				"agent-run",
				{ action: "run", workflow: "global-publish-watch", inputs: { label: "agent" } },
				context,
			);
			trackedRunIds.add(launched.runId);
			const jobOwner = first.jobTracker.get(launched.runId);
			if (jobOwner !== undefined) trackedJobs.add(jobOwner.promise);
			if (earlyFailureReportPath !== undefined) throw new Error("injected failure after agent launch tracking");
			assert.equal(launched.action, "run");
			assert.notEqual(launched.runId, "", launched.error);
			assert.equal(launched.status, "running", JSON.stringify(launched));
			await waitForCondition(
				() =>
					readGlobalIncidentState(stateDir).agent?.watcherRunning === true ||
					first.store.runs().find((run) => run.id === launched.runId)?.status !== "running",
				"the agent-origin publish watcher to start or terminate",
			);
			assert.equal(
				readGlobalIncidentState(stateDir).agent?.watcherRunning,
				true,
				JSON.stringify(first.store.runs().find((run) => run.id === launched.runId)),
			);

			const initial = first.store.runs().find((run) => run.id === launched.runId);
			assert.ok(initial, "the public workflow tool must publish the run to the session store");
			assert.equal(initial.origin, "agent");
			assert.deepEqual(initial.stages, []);
			assert.deepEqual(
				initial.toolNodes?.map((node) => [node.name, node.status]),
				[
					["cached-sibling", "completed"],
					["publish-watcher", "running"],
				],
			);
			assert.deepEqual(first.stageControlRegistry.forRun(launched.runId), []);
			const initialWidget = widget.calls.slice(widgetCallStart).findLast((call) => call.factory !== undefined);
			assert.ok(initialWidget?.factory, "run-start invalidation must mount the host widget before any stage exists");
			assert.equal(initialWidget.placement, "belowEditor");
			assert.match(initialWidget.factory(undefined, undefined).render(120).join("\n"), /BACKGROUND/);
			emitReloadEvidence("agent-start", {
				head: process.env.ATOMIC_RELOAD_EVIDENCE_HEAD,
				origin: initial.origin,
				stages: initial.stages.length,
				tools: initial.toolNodes?.map((node) => [node.name, node.status]),
				widget120: initialWidget.factory(undefined, undefined).render(120).join(" | "),
			});

			const liveNode = initial.toolNodes?.find((node) => node.name === "publish-watcher");
			assert.ok(liveNode);
			const toolOwner = first.toolControlRegistry.get(launched.runId, liveNode.id);
			assert.ok(toolOwner);
			assert.ok(jobOwner);

			const activeReload = await executeWorkflowTool(firstExtension, "reload-active", { action: "reload" }, context);
			assert.equal(activeReload.action, "reload");
			assert.equal(activeReload.status, "ok", activeReload.error);
			assert.equal(first.toolControlRegistry.get(launched.runId, liveNode.id), toolOwner);
			assert.equal(first.jobTracker.get(launched.runId), jobOwner);
			assert.deepEqual(readGlobalIncidentState(stateDir).agent, {
				siblingExecutions: 1,
				watcherExecutions: 1,
				watcherRunning: true,
			});
			emitReloadEvidence("resource-reload-active", {
				status: activeReload.status,
				toolOwnerPreserved: first.toolControlRegistry.get(launched.runId, liveNode.id) === toolOwner,
				jobOwnerPreserved: first.jobTracker.get(launched.runId) === jobOwner,
				state: readGlobalIncidentState(stateDir).agent,
			});

			// `/reload` is a same-process DBOS boundary: shutdown flushes durable writes
			// without stopping the process executor, and startup deliberately does not
			// hydrate/replay live work. The identity assertions below distinguish that
			// handoff from a fresh executor silently replacing the callback.
			const reloadWidgetCallStart = widget.calls.length;
			await emitSessionEvent(firstExtension, "session_shutdown", { reason: "reload" });
			firstRuntime.invalidate();
			const second = await evaluateInstalledWorkflowGraph();
			secondGeneration = second;
			const secondRuntime = createHostRuntime();
			runtimes.push(secondRuntime);
			secondExtension = await loadExtensionFromFactory(second.factory, repoRoot, bus, secondRuntime);
			await emitSessionEvent(secondExtension, "session_start", { reason: "reload" }, context);

			const adopted = second.store.runs().find((run) => run.id === launched.runId);
			assert.ok(adopted, "the installed replacement must adopt the user-global agent run");
			assert.equal(adopted.status, "running");
			assert.equal(adopted.resumable, undefined);
			assert.deepEqual(adopted.stages, []);
			assert.deepEqual(
				adopted.toolNodes?.map((node) => [node.name, node.status]),
				[
					["cached-sibling", "completed"],
					["publish-watcher", "running"],
				],
			);
			assert.equal(second.toolControlRegistry.get(launched.runId, liveNode.id), toolOwner);
			assert.equal(second.jobTracker.get(launched.runId), jobOwner);
			assert.equal(readGlobalIncidentState(stateDir).agent?.watcherExecutions, 1);

			const replacementWidget = widget.calls
				.slice(reloadWidgetCallStart)
				.findLast((call) => call.factory !== undefined);
			assert.ok(replacementWidget?.factory, "the host must remount the adopted active run below the editor");
			assert.match(replacementWidget.factory(undefined, undefined).render(120).join("\n"), /BACKGROUND/);
			assert.deepEqual(replacementWidget.factory(undefined, undefined).render(60), [
				" ▾  1 background · 1 ● · 1 tool",
			]);
			emitReloadEvidence("full-reload-adopted", {
				status: adopted.status,
				resumable: adopted.resumable ?? false,
				tools: adopted.toolNodes?.map((node) => [node.name, node.status]),
				toolOwnerPreserved: second.toolControlRegistry.get(launched.runId, liveNode.id) === toolOwner,
				jobOwnerPreserved: second.jobTracker.get(launched.runId) === jobOwner,
				watcherExecutions: readGlobalIncidentState(stateDir).agent?.watcherExecutions,
				widget120: replacementWidget.factory(undefined, undefined).render(120).join(" | "),
				widget60: replacementWidget.factory(undefined, undefined).render(60),
			});

			writeFileSync(join(stateDir, "agent.release"), "release", "utf8");
			await waitForCondition(
				() => second.store.runs().find((run) => run.id === launched.runId)?.status === "completed",
				"the original callback owner to settle through the adopted store",
			);
			assert.equal(readGlobalIncidentState(stateDir).agent?.watcherExecutions, 1);
			emitReloadEvidence("callback-settled", {
				status: second.store.runs().find((run) => run.id === launched.runId)?.status,
				watcherExecutions: readGlobalIncidentState(stateDir).agent?.watcherExecutions,
			});

			const slashCommand = secondExtension.commands.get("workflow");
			assert.ok(slashCommand, "the /workflow command must be registered beside the public tool");
			const rendersBeforeSlash = widget.renders.count;
			await slashCommand.handler("global-publish-watch label=slash --no-picker", context as never);
			await waitForCondition(
				() => readGlobalIncidentState(stateDir).slash?.watcherRunning === true,
				"the slash-command publish watcher to start",
			);
			const slashRun = second.store
				.runs()
				.find((run) => run.name === "global-publish-watch" && run.inputs.label === "slash");
			assert.ok(slashRun);
			const slashJobOwner = second.jobTracker.get(slashRun.id);
			assert.ok(slashJobOwner);
			trackedRunIds.add(slashRun.id);
			trackedJobs.add(slashJobOwner.promise);
			assert.equal(slashRun.origin, "user");
			assert.deepEqual(slashRun.stages, []);
			assert.deepEqual(second.stageControlRegistry.forRun(slashRun.id), []);
			assert.ok(
				widget.renders.count > rendersBeforeSlash,
				"slash and agent launches must both invalidate the mounted host widget",
			);
			assert.match(
				replacementWidget.factory(undefined, undefined).render(120).join("\n"),
				/publish-watcher · running/,
			);
			writeFileSync(join(stateDir, "slash.release"), "release", "utf8");
			await waitForCondition(
				() => second.store.runs().find((run) => run.id === slashRun.id)?.status === "completed",
				"the slash-command comparison run to settle",
			);
			assert.deepEqual(readGlobalIncidentState(stateDir).slash, {
				siblingExecutions: 1,
				watcherExecutions: 1,
				watcherRunning: false,
			});
			emitReloadEvidence("agent-vs-slash", {
				agentOrigin: initial.origin,
				slashOrigin: slashRun.origin,
				agentStages: initial.stages.length,
				slashStages: slashRun.stages.length,
				slashState: readGlobalIncidentState(stateDir).slash,
			});
			await emitSessionEvent(secondExtension, "session_shutdown", { reason: "quit" });
			if (dbosLifecycleState() !== "shut_down") {
				await emitSessionEvent(secondExtension, "session_shutdown", { reason: "quit" });
			}
		} finally {
			try {
				try {
					for (const label of ["agent", "slash"]) {
						try {
							writeFileSync(join(stateDir, `${label}.release`), "release", "utf8");
						} catch {}
					}
					const activeGeneration = secondGeneration ?? firstGeneration;
					if (activeGeneration !== undefined) {
						for (const runId of trackedRunIds) {
							if (activeGeneration.store.runs().find((run) => run.id === runId)?.status === "running") {
								activeGeneration.cancellationRegistry.abort(runId);
							}
						}
					}
					await Promise.allSettled(trackedJobs);
					const cleanupExtension = secondExtension ?? firstExtension;
					if (cleanupExtension !== undefined && dbosLifecycleState() !== "shut_down") {
						await emitSessionEvent(cleanupExtension, "session_shutdown", { reason: "quit" });
					}
				} finally {
					for (const runtime of runtimes) runtime.invalidate();
					listenersAfterCleanup = trackedBus.listenerCount();
					dbosStateAfterCleanup = dbosLifecycleState();
				}
			} finally {
				if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
				else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
				if (previousStateDir === undefined) delete process.env.ATOMIC_GLOBAL_RELOAD_STATE_DIR;
				else process.env.ATOMIC_GLOBAL_RELOAD_STATE_DIR = previousStateDir;
				rmSync(root, { recursive: true, force: true });
			}
		}
		assert.equal(listenersAfterCleanup, 0, "both extension generations must release event-bus listeners");
		assert.equal(dbosStateAfterCleanup, "shut_down", "final quit must close DBOS client pools and executor handles");
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test.sequential(
	"an early post-launch failure still settles the agent job and removes fixture state",
	() => {
		const probeRoot = mkdtempSync(join(tmpdir(), "atomic-global-reload-probe-"));
		const reportPath = join(probeRoot, "fixture-root.txt");
		try {
			const childEnv: NodeJS.ProcessEnv = { ...process.env, [EARLY_FAILURE_REPORT_ENV]: reportPath };
			delete childEnv.VITEST_POOL_ID;
			delete childEnv.VITEST_WORKER_ID;
			const child = spawnSync(
				process.execPath,
				[
					join(repoRoot, "node_modules", "vitest", "vitest.mjs"),
					"--run",
					"--project",
					"unit",
					"test/unit/workflow-run-state-real-reload.test.ts",
					"-t",
					"user-global agent launch keeps its real publish watcher through resource and installed full reload",
				],
				{ cwd: repoRoot, encoding: "utf8", env: childEnv, timeout: WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS },
			);
			const output = `${child.stdout}\n${child.stderr}`;
			assert.equal(child.status, 1, output);
			assert.match(output, /injected failure after agent launch tracking/);
			const fixtureRoot = readFileSync(reportPath, "utf8");
			assert.equal(existsSync(fixtureRoot), false, "failure cleanup must remove the temporary fixture root");
		} finally {
			rmSync(probeRoot, { recursive: true, force: true });
		}
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test(
	"without a host scope every singleton stays module-local",
	async () => {
		const first = await evaluateWorkflowGraph();
		const second = await evaluateWorkflowGraph();
		first.adoptWorkflowSessionRunState?.(undefined);
		second.adoptWorkflowSessionRunState?.(undefined);
		const controller = new AbortController();
		recordGenerationState(first, {
			runId: "local-run",
			stageId: "local-stage",
			nodeId: "local-node",
			controller,
			toolController: new AbortController(),
		});
		assert.equal(second.store.runs().length, 0);
		assert.equal(second.stageControlRegistry.get("local-run", "local-stage"), undefined);
		assert.equal(second.cancellationRegistry.abort("local-run"), false);
		assert.equal(second.toolControlRegistry.get("local-run", "local-node"), undefined);
		assert.equal(second.jobTracker.has("local-run"), false);
		assert.equal(second.stageUiBroker.peekStagePrompt("local-run", "local-stage"), undefined);
		assert.equal(controller.signal.aborted, false);
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test(
	"two distinct host scopes stay isolated from each other",
	async () => {
		const scopeA = createEventBus();
		const scopeB = createEventBus();
		const first = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(first.factory, repoRoot, scopeA, createExtensionRuntime());
		recordGenerationState(first, {
			runId: "scope-a",
			stageId: "stage-a",
			nodeId: "node-a",
			controller: new AbortController(),
			toolController: new AbortController(),
		});

		const second = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(second.factory, repoRoot, scopeB, createExtensionRuntime());
		assert.equal(second.store.runs().length, 0, "scope B must not see scope A's run");
		assert.equal(second.jobTracker.has("scope-a"), false);

		const rebound = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(rebound.factory, repoRoot, scopeA, createExtensionRuntime());
		assert.equal(rebound.store.runs()[0]?.id, "scope-a");
		assert.equal(rebound.jobTracker.has("scope-a"), true);
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test(
	"facade-forwarded methods keep their class receiver",
	async () => {
		const bus = createEventBus();
		const first = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(first.factory, repoRoot, bus, createExtensionRuntime());
		const controller = new AbortController();
		first.cancellationRegistry.register("receiver-run", controller);
		first.jobTracker.register({
			runId: "receiver-run",
			controller,
			promise: Promise.resolve(),
		});
		const second = await evaluateWorkflowGraph();
		await loadExtensionFromFactory(second.factory, repoRoot, bus, createExtensionRuntime());
		const { register, isAborted, abort } = second.cancellationRegistry;
		const { has, get } = second.jobTracker;
		assert.equal(isAborted("receiver-run"), false);
		assert.equal(has("receiver-run"), true);
		assert.equal(get("receiver-run")?.controller, controller);
		assert.equal(abort("receiver-run"), true);
		assert.equal(controller.signal.aborted, true);
		assert.doesNotThrow(() => register("receiver-run-2", new AbortController()));
	},
	WORKFLOW_MODULE_GRAPH_RELOAD_TIMEOUT_MS,
);

test("every run-scoped singleton key carries an explicit version suffix", async () => {
	const keyPattern = /["']workflows:[a-z0-9-]+:v\d+["']/;
	for (const [name, path] of Object.entries(SINGLETON_SOURCES)) {
		assert.match(await readText(path), keyPattern, `${name} must declare a versioned session key`);
	}
	const factorySource = await readText(join(workflowsSrc, "extension/extension-factory.ts"));
	assert.match(
		factorySource,
		/function factory\(pi: ExtensionAPI\): void \{\n\tadoptWorkflowSessionRunState\(pi\.events\);/,
		"factory must adopt session run state before building adapters",
	);
});
