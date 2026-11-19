/**
 * #5492: every workflow run a session launches publishes a pending-stage route for its invocation group, and the
 * session's Intercom extension opens one broker connection per invocation group for those routes. A session that kept
 * running workflows held one more connection for every run it had finished, for as long as it lived.
 *
 * One host session (the shipped Intercom extension over a real broker, the workflows route bridge and run runtime)
 * runs more workflows than it keeps finished invocations' routes for. The broker's own count of connected sessions is
 * what the test reads: it must stay within the host, the observer and the retained finished invocations.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { durableWorkflowRunSnapshots } from "../../packages/workflows/src/durable/completed-catalog.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	purgeSuppressedWorkflowRuns,
	resumeDurableWorkflow,
} from "../../packages/workflows/src/durable/resume-runtime.js";
import { run } from "../../packages/workflows/src/engine/run.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import {
	registerPendingStageIntercomBridge,
	TERMINAL_INVOCATION_ROUTE_RETENTION,
} from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createDurableResumeRuntime } from "../../packages/workflows/src/extension/runtime-durable-resume.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { claimExternalRunRoute } from "../../packages/workflows/src/shared/external-run-routes.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";

const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
/** Upper bound for anything the test waits on; a failure, not a pace, so it carries load headroom. */
const STATE_POLL_TIMEOUT_MS = 20_000;
const STATE_POLL_INTERVAL_MS = 25;
/** Finished runs past the retained ones: each would hold one more connection without the bound. */
const RUNS_PAST_RETENTION = 3;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "terminal-route-retention-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

// The client resolves the broker's socket from the agent directory when it loads, so it loads after the override.
const { default: intercom } = await import("../../packages/intercom/index.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");

type LifecycleHandler = (event: Record<string, object | string>, ctx: object) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

/** The smallest host the shipped Intercom extension runs in. */
function hostFixture(sessionId: string, sessionName: string) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext: { intercomGroup: "default" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: { confirm: async () => true, notify() {} },
	};
	let activeTools: string[] = [];
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			lifecycleHandlers.set(name, [...(lifecycleHandlers.get(name) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => sessionName,
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(name: string, handler: EventHandler) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
				return () =>
					eventHandlers.set(
						name,
						(eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of eventHandlers.get(name) ?? []) void handler(payload);
			},
		},
	};
	const fire = async (name: string, event: Record<string, object | string>): Promise<void> => {
		for (const handler of lifecycleHandlers.get(name) ?? []) await handler(event, context);
	};
	return {
		pi,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

async function until<T>(description: string, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = performance.now() + STATE_POLL_TIMEOUT_MS;
	for (;;) {
		const value = await probe();
		if (value !== undefined) return value;
		if (performance.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, STATE_POLL_INTERVAL_MS));
	}
}

let broker: ChildProcess | undefined;

async function startBroker(): Promise<void> {
	const child = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker = child;
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = "";
		const timer = setTimeout(
			() => rejectReady(new Error(`Intercom broker did not become ready within ${BROKER_STARTUP_TIMEOUT_MS}ms`)),
			BROKER_STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (!stdout.includes("Intercom broker started")) return;
			clearTimeout(timer);
			resolveReady();
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			rejectReady(
				new Error(`Intercom broker exited before readiness (code=${String(code)}, signal=${String(signal)})`),
			);
		});
	});
}

async function stopBroker(): Promise<void> {
	const active = broker;
	broker = undefined;
	if (active === undefined || active.exitCode !== null) return;
	await new Promise<void>((resolveExit, rejectExit) => {
		const timer = setTimeout(
			() => rejectExit(new Error(`Broker did not exit within ${BROKER_SHUTDOWN_TIMEOUT_MS}ms after SIGTERM`)),
			BROKER_SHUTDOWN_TIMEOUT_MS,
		);
		active.once("exit", () => {
			clearTimeout(timer);
			resolveExit();
		});
		active.kill("SIGTERM");
	});
}

beforeAll(startBroker);

afterAll(async () => {
	await stopBroker();
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	setDurableBackend(undefined);
});

test("a session bounds the routes of finished workflows and closes them when the runs are deleted (#5492, #5561)", async () => {
	const observer = new IntercomClient("terminal-route-retention-observer");
	observer.on("error", () => {});
	await observer.connect({
		name: "terminal-route-retention-observer",
		cwd: repoRoot,
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default"],
	});
	cleanups.push(() => observer.disconnect().catch(() => {}));
	const connectedSessions = async (): Promise<number> => {
		const status = await observer.brokerStatus();
		assert.ok(status, "the broker answers its status");
		return status.sessions;
	};

	const host = hostFixture("terminal-route-host", "terminal-route-host");
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());

	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const store = createStore();
	configureTestStoreBackend(store, backend);
	const bridge = registerPendingStageIntercomBridge(host.pi as never, store);
	cleanups.push(bridge);

	const short = workflow({
		name: "short-run",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("step", {}, async () => "done");
			return {};
		},
	});
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		store,
		jobs,
		toolControlRegistry: createToolControlRegistry(),
		cwd: repoRoot,
		registry: createRegistry([short]),
	});

	const runCount = TERMINAL_INVOCATION_ROUTE_RETENTION + RUNS_PAST_RETENTION;
	const runIds: string[] = [];
	for (let index = 0; index < runCount; index++) {
		const started = await runtime.dispatch({ action: "run", workflow: short.name, inputs: {} });
		assert.ok("runId" in started && typeof started.runId === "string", JSON.stringify(started));
		await jobs.get(started.runId)?.promise;
		assert.equal(store.runs().find((run) => run.id === started.runId)?.status, "completed");
		runIds.push(started.runId);
	}
	await bridge.flush();

	// The host's own connection and the observer's, plus one route connection for each retained finished invocation: the
	// most recently finished ones keep their routes, the older ones closed theirs.
	const expected = 2 + TERMINAL_INVOCATION_ROUTE_RETENTION;
	let observed = 0;
	await until(`${expected} connected sessions`, async () => {
		observed = await connectedSessions();
		return observed === expected ? observed : undefined;
	}).catch((error: Error) => {
		throw new Error(`${error.message}; ${observed} connected after ${runCount} finished runs`);
	});

	for (const id of runIds) assert.ok((await backend.deleteWorkflowIfInactive(id)).ok);
	assert.deepEqual(new Set(purgeSuppressedWorkflowRuns(backend, store)), new Set(runIds));
	await bridge.flush();
	await until("only the host and observer after deleting the finished runs", async () =>
		(await connectedSessions()) === 2 ? true : undefined,
	);
});

async function connectedObserver(name: string, groups: string[] = []) {
	const observer = new IntercomClient(name);
	observer.on("error", () => {});
	await observer.connect({
		name,
		cwd: repoRoot,
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "default",
		groups: ["default", ...groups],
	});
	cleanups.push(() => observer.disconnect().catch(() => {}));
	return {
		probe: async (target: string) => (await observer.send(target, { text: "probe" })).reason ?? "",
		sessions: async (): Promise<number> => {
			const status = await observer.brokerStatus();
			assert.ok(status, "the broker answers its status");
			return status.sessions;
		},
	};
}

async function hostRoutes(store: ReturnType<typeof createStore>) {
	const id = crypto.randomUUID();
	const host = hostFixture(id, id);
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());
	const bridge = registerPendingStageIntercomBridge(host.pi as never, store);
	cleanups.push(bridge);
	await bridge.flush();
	return bridge;
}

async function runInOtherJournal() {
	const own = await JournalTestBackend.create();
	const selected = await JournalTestBackend.create();
	const store = createStore();
	configureTestStoreBackend(store, selected);
	const nested = workflow({
		name: "nested",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("step", {}, async () => 1);
			return {};
		},
	});
	const def = workflow({
		name: "other-journal",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.workflow(nested);
			return {};
		},
	});
	const sessionStore = new MemorySessionStore();
	cleanups.push(() => sessionStore.close());
	const id = crypto.randomUUID();
	const observer = await connectedObserver("journal-observer", [`workflow:${id}`]);
	const result = await run(def, {}, { runId: id, store, durableBackend: own, adapters: { sessionStore } });
	assert.equal(result.status, "completed", result.error);
	const bridge = await hostRoutes(store);
	const target = `workflow:${id}/future`;
	assert.match(await observer.probe(target), /terminated with status completed/);
	const runtime = createDurableResumeRuntime({
		store,
		registry: createRegistry([def]),
		runtimeCwd: repoRoot,
		baseRunOpts: () => ({ adapters: { sessionStore } }),
		adapters: { sessionStore },
		ensureReady: async () => selected,
	});
	const [child] = store.childRuns(id);
	assert.ok(child);
	await runtime.prepareDurableCatalog!();
	return { own, store, id, childId: child.id, bridge, observer, target, runtime };
}

test("opening a completed run keeps its own journal for subsequent inspection (#5561)", async () => {
	const { own, id, bridge, observer, target, runtime } = await runInOtherJournal();
	assert.equal((await runtime.inspectDurableWorkflow(id)).kind, "found");
	const opened = await runtime.openCompletedDurableWorkflow!(id, own.listCompletedWorkflows());
	assert.ok(opened.ok, opened.message);
	await bridge.flush();
	assert.equal((await runtime.inspectDurableWorkflow(id)).kind, "found");
	assert.match(await observer.probe(target), /terminated with status completed/);
});

test("refreshing a different journal retires a run deleted from its own journal (#5561)", async () => {
	const { own, store, id, childId, bridge, observer, target, runtime } = await runInOtherJournal();
	assert.equal(
		store.run(childId)?.status,
		"completed",
		"the child is stored under its surviving root, not as a separate journal row",
	);
	assert.equal(await observer.sessions(), 3);
	assert.ok((await own.deleteWorkflowIfInactive(id)).ok);
	await runtime.prepareDurableCatalog!();
	await bridge.flush();
	assert.equal(store.run(id), undefined);
	assert.equal(store.run(childId), undefined);
	await until("the deleted run's connection to close", async () =>
		(await observer.sessions()) === 2 ? true : undefined,
	);
	assert.match(await observer.probe(target), /not found/i);
});

test("a refused resume keeps the original finishers reachable after reopening the journal (#5561)", async () => {
	const backend = await JournalTestBackend.create();
	const ids = Array.from({ length: TERMINAL_INVOCATION_ROUTE_RETENTION + 1 }, () => crypto.randomUUID());
	const [oldest, next] = ids;
	const def = workflow({ name: "resume", description: "", inputs: {}, outputs: {}, run: async () => ({}) });
	for (const [i, id] of ids.entries())
		await backend.commitWorkflowRegistration({
			workflowId: id,
			name: def.name,
			inputs: {},
			status: "failed",
			createdAt: 1,
			updatedAt: i + 10,
			finishSequence: i + 10,
			runGeneration: 3,
			resumable: true,
		});
	const refused = await resumeDurableWorkflow(oldest!, {
		registry: createRegistry([def]),
		durableBackend: backend,
		baseRunOpts: { adapters: {}, store: createStore() },
		jobs: Object.assign(createJobTracker(), {
			register() {
				throw new Error("admission refused");
			},
		}),
	});
	assert.equal(refused.ok, false);
	assert.match(refused.message, /admission refused/);
	const reopened = await backend.reopen();
	const store = createStore();
	configureTestStoreBackend(store, reopened);
	for (const id of ids) {
		await reopened.hydrateWorkflow(id);
		for (const snapshot of durableWorkflowRunSnapshots(reopened, reopened.getWorkflow(id)!))
			store.recordRunStart(snapshot);
	}
	const observer = await connectedObserver(
		"resume-observer",
		[oldest, next].map((id) => `workflow:${id}`),
	);
	await hostRoutes(store);
	assert.match(await observer.probe(`workflow:${oldest}/future`), /not found/i);
	assert.match(await observer.probe(`workflow:${next}/future`), /terminated with status failed/);
	assert.equal(reopened.getWorkflow(oldest!)?.finishSequence, 10);
	assert.equal(reopened.getWorkflow(oldest!)?.runGeneration, 3, "a refused claim is not a new block or pause");
});

test("a successor takes a nested route without disconnecting the parent on the shared connection (#5561)", async () => {
	const root = crypto.randomUUID();
	const child = crypto.randomUUID();
	const group = `workflow:${root}`;
	const backend = await JournalTestBackend.create();
	const store = createStore();
	configureTestStoreBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: root,
		name: "root",
		status: "failed",
		inputs: {},
		createdAt: 1,
	});
	const finished = { status: "failed" as const, inputs: {}, startedAt: 1, endedAt: 2, toolNodes: [] };
	store.recordRunStart({
		...finished,
		id: root,
		name: "root",
		stages: [
			{
				id: "boundary",
				name: "workflow:child",
				status: "completed",
				parentIds: [],
				toolEvents: [],
				replayKey: "child:1",
				workflowChildRun: { alias: "child", workflow: "child", runId: child },
			},
		],
	});
	store.recordRunStart({
		...finished,
		id: child,
		name: "child",
		stages: [],
		parentRunId: root,
		parentStageId: "boundary",
		rootRunId: root,
	});
	const observer = await connectedObserver("nested-observer", [group]);
	const bridge = await hostRoutes(store);
	assert.equal(await observer.sessions(), 3);
	assert.match(await observer.probe(`${group}/${child}/future`), /terminated with status failed/);
	const successor = new IntercomClient("nested-successor", { multiplexesPendingStageRoutes: true });
	successor.on("error", () => {});
	await successor.connect({
		name: "nested-successor",
		group,
		groups: [group],
		model: "test-model",
		cwd: repoRoot,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		pid: process.pid,
	});
	cleanups.push(() => successor.disconnect());
	successor.on("pending_stage_message", ({ requestId }: { requestId: string }) =>
		successor.respondPendingStageMessage(requestId, { outcome: "refused", reason: "answered by successor" }),
	);
	cleanups.push(
		claimExternalRunRoute(store, child, { notifyUndeliverable: async () => false, deliversQueued: () => false }),
	);
	bridge.refresh();
	await bridge.flush();
	await successor.registerPendingStageRouteAcknowledged(child, group, crypto.randomUUID(), []);
	assert.equal(await observer.probe(`${group}/${child}/future`), "answered by successor");
	assert.match(await observer.probe(`${group}/future`), /terminated with status failed/);
	assert.equal(await observer.sessions(), 4);
});

test("a route retired while the Intercom runtime is still loading is not connected once it loads (#5492)", async () => {
	const observer = await connectedObserver("terminal-route-loading-observer");
	const host = hostFixture("terminal-route-loading-host", "terminal-route-loading-host");
	const importGate = Promise.withResolvers<void>();
	intercom(host.pi as never, {
		importHeavy: async () => {
			await importGate.promise;
			return import("../../packages/intercom/index-heavy.js");
		},
	});
	await host.start();
	cleanups.push(() => host.shutdown());
	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const store = createStore();
	configureTestStoreBackend(store, backend);
	const bridge = registerPendingStageIntercomBridge(host.pi as never, store);
	cleanups.push(bridge);
	let retired = 0;
	host.pi.events.on("atomic:workflow-pending-stage-route-retired", () => {
		retired += 1;
	});
	const short = workflow({
		name: "short-run-loading",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("step", {}, async () => "done");
			return {};
		},
	});
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		store,
		jobs,
		toolControlRegistry: createToolControlRegistry(),
		cwd: repoRoot,
		registry: createRegistry([short]),
	});
	for (let index = 0; index < TERMINAL_INVOCATION_ROUTE_RETENTION + RUNS_PAST_RETENTION; index++) {
		const started = await runtime.dispatch({ action: "run", workflow: short.name, inputs: {} });
		assert.ok("runId" in started && typeof started.runId === "string", JSON.stringify(started));
		await jobs.get(started.runId)?.promise;
	}
	bridge.refresh();
	assert.equal(retired, RUNS_PAST_RETENTION, "the oldest finished invocations were retired before the runtime loaded");

	importGate.resolve();
	await bridge.flush();
	const expected = 2 + TERMINAL_INVOCATION_ROUTE_RETENTION;
	let observed = 0;
	await until(`${expected} connected sessions`, async () => {
		observed = await observer.sessions();
		return observed === expected ? observed : undefined;
	}).catch((error: Error) => {
		throw new Error(`${error.message}; ${observed} connected once the runtime loaded`);
	});
});

test("a route retired right after it was published is never connected (#5492)", async () => {
	const observer = await connectedObserver("terminal-route-order-observer");
	const host = hostFixture("terminal-route-order-host", "terminal-route-order-host");
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());
	type Route = { runId: string; group: string; capability: string; stages: []; completion?: Promise<void> };
	const kept: Route = {
		runId: "kept-5492",
		group: "workflow:kept-5492",
		capability: "kept-5492-capability",
		stages: [],
	};
	host.pi.events.emit("atomic:workflow-pending-stage-route", kept);
	await kept.completion;
	const retiring: Route = {
		runId: "retired-5492",
		group: "workflow:retired-5492",
		capability: "retired-5492-capability",
		stages: [],
	};
	host.pi.events.emit("atomic:workflow-pending-stage-route", retiring);
	host.pi.events.emit("atomic:workflow-pending-stage-route-retired", { runId: retiring.runId, group: retiring.group });
	await retiring.completion?.catch(() => {});

	// The host's connection, the observer's and the kept route's; the retired route's never stays open.
	let observed = 0;
	await until("3 connected sessions", async () => {
		observed = await observer.sessions();
		return observed === 3 ? observed : undefined;
	}).catch((error: Error) => {
		throw new Error(`${error.message}; ${observed} connected`);
	});
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	assert.equal(await observer.sessions(), 3, "a connection opened for the retired route after it was retired");
});
