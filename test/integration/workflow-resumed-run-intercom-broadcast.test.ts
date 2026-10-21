import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { JournalExecutionRetiredError } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStore, type Store } from "../../packages/workflows/src/shared/store.js";
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
const agentDir = mkdtempSync(join(tmpdir(), "resumed-broadcast-"));
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

test("a blocked then resumed run delivers ** broadcasts live, keeps pattern and future-stage sends sticky, and refuses them once it ends", async () => {
	const host = extensionFixture("host-session", "host", { intercomGroup: "default" });
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());

	const stagePeers: Array<{ readonly stageName: string; readonly peer: Fixture }> = [];
	let blockReviewer = true;
	let staleExecutionWrite: (() => ReturnType<Store["queueStickyStageMessage"]>) | undefined;
	const releaseReviewer = Promise.withResolvers<void>();
	const fixture = createPersistedStageFixture({
		reply: (text) => `done: ${text}`,
		onPrompt: async (text) => {
			if (text.includes("open the pull request")) return;
			if (blockReviewer) {
				staleExecutionWrite = AsyncResource.bind(() => queueStickyFromStaleExecution());
				throw new Error("HTTP 429 quota exceeded");
			}
			await releaseReviewer.promise;
		},
		async onCreate(createOptions) {
			const manager = createOptions.sessionManager;
			const orchestration = createOptions.orchestrationContext;
			assert.ok(manager && orchestration?.kind === "workflow-stage" && orchestration.workflowStageName);
			const sessionId = manager.getSessionId();
			// The resumed stage reopens the blocked stage's session id; keep one live peer per session.
			for (const previous of stagePeers.filter(
				({ peer }) => peer.context.sessionManager.getSessionId() === sessionId,
			))
				await previous.peer.shutdown();
			const peer = extensionFixture(sessionId, "", orchestration);
			intercomHeavy(peer.pi as never);
			await peer.start();
			stagePeers.push({ stageName: orchestration.workflowStageName, peer });
			return () => peer.shutdown();
		},
	});
	cleanups.push(async () => {
		releaseReviewer.resolve();
		for (const { peer } of stagePeers) await peer.shutdown();
	});
	const latestPeer = (stageName: string): Fixture | undefined =>
		stagePeers.filter((entry) => entry.stageName === stageName).at(-1)?.peer;

	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const store = createStore();
	configureTestStoreBackend(store, backend);
	cleanups.push(registerPendingStageIntercomBridge(host.pi as never, store));
	let runId = "";
	const queueStickyFromStaleExecution = () =>
		store.queueStickyStageMessage(
			{
				runId,
				stageKey: `workflow:${runId}/**`,
				targetPath: `workflow:${runId}/**`,
				from: { id: "stale-execution", name: "stale-execution", group: `workflow:${runId}` },
				message: { id: "stale-execution-write", timestamp: 1, content: { text: "from the blocked execution" } },
				queuedAt: "2026-10-20T00:00:00.000Z",
			},
			`workflow:${runId}`,
			`workflow:${runId}`,
			backend,
		);
	const definition = workflow({
		name: "resumed-broadcast",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("reviewer").prompt("review");
			await ctx.stage("pull-request").prompt("open the pull request");
			return {};
		},
	});
	const jobs = createJobTracker();
	const runtime = createExtensionRuntime({
		store,
		jobs,
		cwd: repoRoot,
		registry: createRegistry([definition]),
		adapters: fixture.adapters,
	});
	const runSnapshot = () => store.runs().find((candidate) => candidate.id === runId);

	const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
	assert.ok("runId" in started && typeof started.runId === "string", JSON.stringify(started));
	runId = started.runId;
	await jobs.get(runId)?.promise;
	assert.equal(runSnapshot()?.failureDisposition, "active_blocked", JSON.stringify(runSnapshot()));
	assert.equal(runSnapshot()?.resumable, true);

	blockReviewer = false;
	const resumed = await runtime.resumeFailedRun(runId);
	assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
	await until("the resumed reviewer stage to be live", () => {
		const reviewer = runSnapshot()?.stages.find((stage) => stage.name === "reviewer");
		return reviewer?.status === "running" && reviewer.sessionId !== undefined && fixture.sessions.length === 2;
	});

	const sender = extensionFixture("sender-session", "supervisor", { intercomGroup: `workflow:${runId}` });
	intercomHeavy(sender.pi as never);
	await sender.start();
	cleanups.push(() => sender.shutdown());

	const broadcast = await sender.send(`workflow:${runId}/**`, "Broadcast after resume.");
	assert.equal(broadcast.isError, false, JSON.stringify(broadcast));
	assert.equal(broadcast.details.queued, true);
	const pattern = await sender.send(`workflow:${runId}/pull-*`, "Pattern after resume.");
	assert.equal(pattern.isError, false, JSON.stringify(pattern));
	assert.equal(pattern.details.queued, true);
	const future = await sender.send(`workflow:${runId}/pull-request`, "Future stage after resume.");
	assert.equal(future.isError, false, JSON.stringify(future));
	assert.equal(future.details.queued, true);
	await until("the live reviewer to receive the broadcast", () =>
		injectedText(latestPeer("reviewer")).some((text) => text.includes("Broadcast after resume.")),
	);
	assert.equal(
		injectedText(latestPeer("reviewer")).some((text) => text.includes("Future stage after resume.")),
		false,
	);
	await until("the live reviewer delivery to enter the broadcast's durable ledger", () =>
		(runSnapshot()?.pendingStageMessages ?? []).some(
			(entry) => entry.message.content.text === "Broadcast after resume." && entry.deliveryCount === 1,
		),
	);

	assert.ok(staleExecutionWrite);
	await assert.rejects(staleExecutionWrite(), JournalExecutionRetiredError);

	releaseReviewer.resolve();
	await jobs.get(runId)?.promise;
	assert.equal(runSnapshot()?.status, "completed", JSON.stringify(runSnapshot()));
	const pullRequestText = injectedText(latestPeer("pull-request"));
	for (const expected of ["Broadcast after resume.", "Pattern after resume.", "Future stage after resume."])
		assert.ok(
			pullRequestText.some((text) => text.includes(expected)),
			`${expected} reaches the later stage: ${JSON.stringify(pullRequestText)}`,
		);
	assert.equal(
		pullRequestText.some((text) => text.includes("from the blocked execution")),
		false,
	);

	const afterEnd = await sender.send(`workflow:${runId}/**`, "Broadcast after the run ended.");
	assert.equal(afterEnd.isError, true, JSON.stringify(afterEnd));
	assert.doesNotMatch(afterEnd.content[0]?.text ?? "", /retired/);
	assert.match(afterEnd.content[0]?.text ?? "", /terminated with status completed/);
});
