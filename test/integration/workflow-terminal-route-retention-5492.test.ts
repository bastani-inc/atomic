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
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import {
	registerPendingStageIntercomBridge,
	TERMINAL_INVOCATION_ROUTE_RETENTION,
} from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
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

test("a session that keeps running workflows keeps a bounded number of Intercom route connections (#5492)", async () => {
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
});

async function connectedObserver(name: string) {
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
		groups: ["default"],
	});
	cleanups.push(() => observer.disconnect().catch(() => {}));
	return {
		sessions: async (): Promise<number> => {
			const status = await observer.brokerStatus();
			assert.ok(status, "the broker answers its status");
			return status.sessions;
		},
	};
}

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
