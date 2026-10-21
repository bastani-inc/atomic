import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import type { WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { quitRun } from "../../packages/workflows/src/runs/background/quit.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";

const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const STATE_POLL_TIMEOUT_MS = 10_000;
const STATE_POLL_INTERVAL_MS = 25;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "launch-after-retired-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { default: intercom } = await import("../../packages/intercom/index.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	isError: boolean;
}

interface InjectedMessage {
	customType?: string;
	content?: string;
}

interface SendOptions {
	triggerTurn?: boolean;
}

type LifecycleHandler = (event: Record<string, object | string>, ctx: TestContext) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

interface TestContext {
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
	model: { id: string };
	orchestrationContext: { intercomGroup: string };
	sessionManager: { getSessionId(): string; getBranch(): [] };
	ui: { confirm(): Promise<boolean>; notify(): void };
}

interface CapturedTool {
	name: string;
	execute?: (
		toolCallId: string,
		params: { action: string; message?: string; to?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: TestContext,
	) => Promise<ToolResult>;
}

/** One extension host session; `onTurn` stands in for the agent turn a triggering message starts. */
function sessionFixture(sessionId: string, sessionName: string, onTurn?: (message: InjectedMessage) => void) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, CapturedTool>();
	const context: TestContext = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext: { intercomGroup: "default" },
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: { confirm: async () => true, notify() {} },
	};
	let activeTools: string[] = [];
	const deliver = (messages: InjectedMessage[], options?: SendOptions): void => {
		// An idle host starts its next agent turn inside the call that delivered the message.
		if (options?.triggerTurn === true) for (const message of messages) onTurn?.(message);
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			lifecycleHandlers.set(name, [...(lifecycleHandlers.get(name) ?? []), handler]);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		async sendMessage(message: InjectedMessage, options?: SendOptions) {
			deliver([message], options);
		},
		async sendMessages(messages: InjectedMessage[], options?: SendOptions) {
			deliver(messages, options);
		},
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
		send(to: string, message: string): Promise<ToolResult> {
			const execute = tools.get("intercom")?.execute;
			assert.ok(execute);
			return execute("test-call", { action: "send", to, message }, undefined, undefined, context);
		},
	};
}

async function until(description: string, predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + STATE_POLL_TIMEOUT_MS;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
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

test("a host turn started by an Intercom message launches a new run after an earlier run was quit, resumed, and completed", async () => {
	const turnLaunches: Array<Promise<WorkflowToolResult>> = [];
	let launchFromTurn: (() => Promise<WorkflowToolResult>) | undefined;
	const host = sessionFixture("host-session", "host", () => {
		if (launchFromTurn !== undefined) turnLaunches.push(launchFromTurn());
	});
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());

	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const store = createStore();
	configureTestStoreBackend(store, backend);
	cleanups.push(registerPendingStageIntercomBridge(host.pi as never, store));

	const firstAttemptStarted = Promise.withResolvers<void>();
	const releaseResumedAttempt = Promise.withResolvers<void>();
	let attempts = 0;
	const longRunning = workflow({
		name: "quit-and-resume",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("prepare", {}, async () => "prepared");
			attempts += 1;
			if (attempts === 1) {
				firstAttemptStarted.resolve();
				// Quit interrupts this attempt; it never continues.
				await new Promise<void>(() => {});
			}
			await releaseResumedAttempt.promise;
			await ctx.tool("finish", {}, async () => "finished");
			return {};
		},
	});
	const followUp = workflow({
		name: "follow-up",
		description: "",
		inputs: {},
		outputs: {},
		async run(ctx) {
			await ctx.tool("effect", {}, async () => "done");
			return {};
		},
	});
	const jobs = createJobTracker();
	const toolControlRegistry = createToolControlRegistry();
	const runtime = createExtensionRuntime({
		store,
		jobs,
		toolControlRegistry,
		cwd: repoRoot,
		registry: createRegistry([longRunning, followUp]),
	});
	const status = (id: string) => store.runs().find((run) => run.id === id)?.status;

	const started = await runtime.dispatch({ action: "run", workflow: longRunning.name, inputs: {} });
	assert.ok("runId" in started && typeof started.runId === "string", JSON.stringify(started));
	const firstRunId = started.runId;
	await firstAttemptStarted.promise;

	const quit = await quitRun(firstRunId, { store, toolControlRegistry, jobs });
	assert.equal(quit.ok, true, JSON.stringify(quit));
	await jobs.get(firstRunId)?.promise;
	assert.equal(status(firstRunId), "paused");

	const resumed = await runtime.resumeDurableWorkflow(firstRunId);
	assert.equal(resumed.ok, true, resumed.message);
	releaseResumedAttempt.resolve();
	await until("the resumed run to complete", () => status(firstRunId) === "completed");
	await jobs.get(firstRunId)?.promise;

	launchFromTurn = () => runtime.dispatch({ action: "run", workflow: followUp.name, inputs: {} });
	const peer = sessionFixture("peer-session", "peer");
	intercomHeavy(peer.pi as never);
	await peer.start();
	cleanups.push(() => peer.shutdown());
	const sent = await peer.send("host", "Please start the follow-up workflow.");
	assert.equal(sent.isError, false, JSON.stringify(sent));
	await until("the host turn to launch the follow-up run", () => turnLaunches.length === 1);

	const launched = await turnLaunches[0];
	assert.ok(launched !== undefined);
	assert.notEqual(
		"status" in launched ? launched.status : undefined,
		"failed",
		JSON.stringify({ firstRunId, launched }),
	);
	assert.ok("runId" in launched && typeof launched.runId === "string", JSON.stringify(launched));
	await jobs.get(launched.runId)?.promise;
	assert.equal(status(launched.runId), "completed");
});
