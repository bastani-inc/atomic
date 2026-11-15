import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";
import { createPersistedStageFixture } from "../unit/persisted-stage-fixture.js";

const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const STATE_POLL_TIMEOUT_MS = 10_000;
const STATE_POLL_INTERVAL_MS = 25;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "repeated-child-sticky-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { default: intercom } = await import("../../packages/intercom/index.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");

type StageOrchestrationContext = NonNullable<CreateAgentSessionOptions["orchestrationContext"]>;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: { delivered?: boolean; queued?: boolean; position?: number; refusal?: string };
	isError: boolean;
}

interface InjectedMessage {
	customType?: string;
	content?: string;
	details?: { message?: { id?: string } };
}

interface BranchEntry {
	readonly type: "custom_message";
	readonly customType?: string;
	readonly details?: InjectedMessage["details"];
}

type LifecycleHandler = (event: Record<string, object | string>, ctx: TestContext) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

interface TestContext {
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
	model: { id: string };
	orchestrationContext: StageOrchestrationContext | { intercomGroup: string };
	sessionManager: { getSessionId(): string; getBranch(): BranchEntry[] };
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

function extensionFixture(
	sessionId: string,
	sessionName: string,
	orchestrationContext: TestContext["orchestrationContext"],
) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, CapturedTool>();
	const injectedMessages: InjectedMessage[] = [];
	const context: TestContext = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () =>
				injectedMessages.map((message) => ({
					type: "custom_message" as const,
					customType: message.customType,
					details: message.details,
				})),
		},
		ui: { confirm: async () => true, notify() {} },
	};
	let activeTools: string[] = [];
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
		async sendMessage(message: InjectedMessage) {
			injectedMessages.push(message);
		},
		async sendMessages(messages: InjectedMessage[]) {
			injectedMessages.push(...messages);
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
		context,
		pi,
		injectedMessages,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
		send(to: string, message: string): Promise<ToolResult> {
			const execute = tools.get("intercom")?.execute;
			assert.ok(execute);
			return execute("test-call", { action: "send", to, message }, undefined, undefined, context);
		},
	};
}

type Fixture = ReturnType<typeof extensionFixture>;

async function until(description: string, predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + STATE_POLL_TIMEOUT_MS;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, STATE_POLL_INTERVAL_MS));
	}
}

function injectedText(fixture: Fixture | undefined): string[] {
	return fixture?.injectedMessages.map((message) => message.content ?? "") ?? [];
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

interface RepeatedChildScenario {
	/** One entry per child copy: the boundary stage name, or `undefined` for the default `workflow:<child>`. */
	readonly boundaryNames: readonly (string | undefined)[];
}

async function runRepeatedChildScenario({ boundaryNames }: RepeatedChildScenario): Promise<void> {
	const host = extensionFixture("host-session", "host", { intercomGroup: "default" });
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());

	const reviewers: Fixture[] = [];
	const releaseReviewers = Promise.withResolvers<void>();
	const fixture = createPersistedStageFixture({
		reply: (text) => `done: ${text}`,
		onPrompt: () => releaseReviewers.promise,
		async onCreate(createOptions) {
			const manager = createOptions.sessionManager;
			const orchestration = createOptions.orchestrationContext;
			assert.ok(manager && orchestration?.kind === "workflow-stage" && orchestration.workflowStageName);
			const peer = extensionFixture(manager.getSessionId(), "", orchestration);
			intercomHeavy(peer.pi as never);
			await peer.start();
			reviewers.push(peer);
			return () => peer.shutdown();
		},
	});
	cleanups.push(async () => {
		releaseReviewers.resolve();
		for (const peer of reviewers) await peer.shutdown();
	});

	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const store = createStore();
	configureTestStoreBackend(store, backend);
	cleanups.push(registerPendingStageIntercomBridge(host.pi as never, store));
	const child = workflow({
		name: "child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("reviewer").prompt("review");
			return {};
		},
	});
	const parent = workflow({
		name: "parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await Promise.all(
				boundaryNames.map((stageName) => ctx.workflow(child, stageName === undefined ? {} : { stageName })),
			);
			return {};
		},
	});
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		store,
		jobs,
		cwd: repoRoot,
		registry: createRegistry([parent, child]),
		adapters: fixture.adapters,
	});
	const started = await runtime.dispatch({ action: "run", workflow: parent.name, inputs: {} });
	assert.ok("runId" in started && typeof started.runId === "string", JSON.stringify(started));
	const runId = started.runId;
	const copies = boundaryNames.length;
	await until(`${copies} live reviewer stages`, () => {
		const live = store
			.runs()
			.flatMap((run) => (run.parentRunId === runId ? run.stages : []))
			.filter((stage) => stage.name === "reviewer" && stage.status === "running" && stage.sessionId !== undefined);
		return live.length === copies && reviewers.length === copies;
	});

	const sender = extensionFixture("sender-session", "supervisor", { intercomGroup: `workflow:${runId}` });
	intercomHeavy(sender.pi as never);
	await sender.start();
	cleanups.push(() => sender.shutdown());

	const sends = [
		{ to: `workflow:${runId}/**`, text: "Broadcast to every reviewer." },
		{ to: `workflow:${runId}/*/reviewer`, text: "Pattern to every reviewer." },
	];
	for (const { to, text } of sends) {
		const result = await sender.send(to, text);
		assert.equal(result.isError, false, JSON.stringify(result));
		assert.equal(result.details.queued, true, JSON.stringify(result));
	}
	const received = (peer: Fixture, text: string) => injectedText(peer).filter((entry) => entry.includes(text)).length;
	for (const { text } of sends) {
		await until(`every live reviewer to receive "${text}"`, () =>
			reviewers.every((peer) => received(peer, text) >= 1),
		);
		await until(`"${text}" to record one delivery per reviewer`, () =>
			(store.run(runId)?.pendingStageMessages ?? []).some(
				(entry) => entry.message.content.text === text && entry.deliveryCount === copies,
			),
		);
	}

	releaseReviewers.resolve();
	await jobs.get(runId)?.promise;
	assert.equal(store.run(runId)?.status, "completed", JSON.stringify(store.run(runId)));
	for (const { text } of sends)
		assert.deepEqual(
			reviewers.map((peer) => received(peer, text)),
			reviewers.map(() => 1),
			`each reviewer receives "${text}" exactly once`,
		);
}

test("pattern sends reach every live stage when a parent runs the same child workflow twice (#4844)", async () => {
	await runRepeatedChildScenario({ boundaryNames: [undefined, undefined] });
});

test("pattern sends still reach the live stage of a single child workflow (#4844)", async () => {
	await runRepeatedChildScenario({ boundaryNames: [undefined] });
});

test("pattern sends reach live child stages whose boundary names contain / or * (#4844)", async () => {
	await runRepeatedChildScenario({ boundaryNames: ["review/a", "review*b"] });
});
