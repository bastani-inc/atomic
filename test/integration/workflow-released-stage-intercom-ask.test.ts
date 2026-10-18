import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createPostMortemHandleResolver } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { registerReleasedStageIntercomRoutes } from "../../packages/workflows/src/extension/released-stage-intercom-route.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { createPersistedStageFixture, type PersistedStageSession } from "../unit/persisted-stage-fixture.js";

const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const ASK_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 5_000;
const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "released-stage-"));
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
	details: { delivered?: boolean };
	isError: boolean;
}

interface InjectedMessage {
	customType?: string;
	content?: string;
}

type LifecycleHandler = (event: Record<string, object | string>, ctx: TestContext) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

interface TestContext {
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
	model: { id: string };
	orchestrationContext: StageOrchestrationContext | { intercomGroup: string };
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

/** The host surface one Intercom extension instance runs against, as Atomic provides it per session. */
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
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
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
		tools,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

type Fixture = ReturnType<typeof extensionFixture>;

async function executeIntercom(
	fixture: Fixture,
	params: { action: string; message?: string; to?: string },
	signal?: AbortSignal,
): Promise<ToolResult> {
	const execute = fixture.tools.get("intercom")?.execute;
	assert.ok(execute);
	return execute("test-call", params, signal, undefined, fixture.context);
}

async function untilListed(asker: Fixture, expected: RegExp): Promise<string> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let listing = "";
	while (Date.now() < deadline) {
		listing = (await executeIntercom(asker, { action: "list" })).content[0]?.text ?? "";
		if (expected.test(listing)) return listing;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Intercom listing never matched ${expected}:\n${listing}`);
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
});

interface ReleasedStageScenario {
	readonly host: Fixture;
	readonly asker: Fixture;
	readonly fixture: ReturnType<typeof createPersistedStageFixture>;
	readonly store: ReturnType<typeof createStore>;
	readonly registry: ReturnType<typeof createStageControlRegistry>;
	readonly runId: string;
	readonly stageId: string;
	/** How many times the workflow body executed. */
	workflowRuns(): number;
	/** The name the stage's live session was listed under, before and after its release. */
	readonly stagePeerName: string;
}

/**
 * Runs a one-stage workflow whose stage session has its own live Intercom peer, as an
 * SDK stage session does, and returns once the run has ended and the registry released
 * that session. The host session owns the workflow and its Intercom extension.
 */
async function endRunOfWorkflowWithReleasedStage(
	options: { failSecondSession?: boolean } = {},
): Promise<ReleasedStageScenario> {
	const host = extensionFixture("host-session", "host", { intercomGroup: "default" });
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());

	const stagePeers: Fixture[] = [];
	let stagePeerName = "";
	const fixture = createPersistedStageFixture({
		reply: (text) => `saved-conversation answer to: ${text.split("\n\n")[1] ?? text}`,
		onPrompt: (_text, record: PersistedStageSession) => {
			if (options.failSecondSession === true && record !== fixture.sessions[0]) throw new Error("model unavailable");
		},
		async onCreate(createOptions) {
			const manager = createOptions.sessionManager;
			const orchestration = createOptions.orchestrationContext;
			assert.ok(manager && orchestration?.kind === "workflow-stage");
			// Unnamed, like every runner-created stage session: Intercom derives its name from the session id.
			const peer = extensionFixture(manager.getSessionId(), "", orchestration);
			intercomHeavy(peer.pi as never);
			await peer.start();
			stagePeers.push(peer);
			stagePeerName = `subagent-chat-${manager.getSessionId()}`;
			return () => peer.shutdown();
		},
	});
	const registry = createStageControlRegistry();
	const store = createStore();
	// The workflow owner publishes the run's route, which every stage's live Intercom peer registers against.
	const runId = randomUUID();
	const backend = await createMemoryTestBackend();
	configureTestStoreBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "released-stage-ask",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	const disposeBridge = registerPendingStageIntercomBridge(host.pi as never, store);
	cleanups.push(disposeBridge);
	const resolveHandle = createPostMortemHandleResolver({
		adapters: fixture.adapters,
		resolveDefaultStageSessionDir: () => undefined,
		store,
		stageControlRegistry: registry,
	});
	const disposeRoutes = registerReleasedStageIntercomRoutes(host.pi, registry, store, resolveHandle);
	cleanups.push(async () => {
		disposeRoutes();
		await registry.clear();
	});

	let workflowRuns = 0;
	const definition = workflow({
		name: "released-stage-ask",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			workflowRuns += 1;
			await ctx.stage("reviewer").prompt("review the change");
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{ runId, store, stageControlRegistry: registry, adapters: fixture.adapters },
	);
	assert.equal(result.status, "completed", JSON.stringify(result));

	const runSnapshot = store.runs()[0]!;
	const stage = runSnapshot.stages[0]!;
	assert.equal(stagePeers.length, 1, "the stage session had a live Intercom peer while it ran");
	assert.equal(fixture.disposals(), 1, "the run's end released the completed stage session");
	assert.equal(registry.get(runSnapshot.id, stage.id), undefined, "the released stage is no longer registered");

	const asker = extensionFixture("asker-session", "asker", { intercomGroup: `workflow:${runSnapshot.id}` });
	intercomHeavy(asker.pi as never);
	await asker.start();
	cleanups.push(() => asker.shutdown());
	return {
		host,
		asker,
		fixture,
		store,
		registry,
		runId: runSnapshot.id,
		stageId: stage.id,
		workflowRuns: () => workflowRuns,
		stagePeerName,
	};
}

test("an Intercom ask sent after the run ended reopens the released stage and answers from its saved conversation (#3622)", async () => {
	const scenario = await endRunOfWorkflowWithReleasedStage();
	const { asker, fixture, store, stagePeerName } = scenario;

	const listing = await untilListed(asker, new RegExp(`${stagePeerName}[^\\n]*`));
	assert.match(
		listing,
		/closed · reply: post-mortem only/,
		"the released stage is listed like its closed live session was",
	);
	assert.equal(fixture.sessions.length, 1, "listing the peer does not reopen the stage");

	const reply = await executeIntercom(
		asker,
		{ action: "ask", to: stagePeerName, message: "which file did you review?" },
		AbortSignal.timeout(ASK_TIMEOUT_MS),
	);

	assert.equal(reply.isError, false, reply.content[0]?.text);
	assert.match(reply.content[0]?.text ?? "", /saved-conversation answer to: which file did you review\?/);
	assert.equal(fixture.sessions.length, 2, "the ask reopened the stage from its saved transcript, once");
	assert.match(fixture.sessions[1]!.prompts[0] ?? "", /which file did you review\?/);
	assert.deepEqual(
		fixture.sessions[1]!.session.messages.map((message) => message.role).slice(0, 2),
		["user", "assistant"],
		"the reopened session continued the saved conversation",
	);
	assert.equal(scenario.workflowRuns(), 1, "answering does not rerun the workflow");
	assert.equal(store.runs()[0]!.stages[0]!.status, "completed");
});

test("an ask to the released stage's canonical workflow path reaches it like its live session did (#3622)", async () => {
	const { asker, runId, stagePeerName, fixture } = await endRunOfWorkflowWithReleasedStage();
	await untilListed(asker, new RegExp(stagePeerName));

	const reply = await executeIntercom(
		asker,
		{ action: "ask", to: `workflow:${runId}/reviewer`, message: "any blockers?" },
		AbortSignal.timeout(ASK_TIMEOUT_MS),
	);

	assert.equal(reply.isError, false, reply.content[0]?.text);
	assert.match(reply.content[0]?.text ?? "", /saved-conversation answer to: any blockers\?/);
	assert.equal(fixture.sessions.length, 2);
});

test("an ask the reopened stage cannot answer fails the ask instead of leaving it waiting (#3622)", async () => {
	const { asker, stagePeerName } = await endRunOfWorkflowWithReleasedStage({ failSecondSession: true });
	await untilListed(asker, new RegExp(stagePeerName));

	const reply = await executeIntercom(
		asker,
		{ action: "ask", to: stagePeerName, message: "are you there?" },
		AbortSignal.timeout(ASK_TIMEOUT_MS),
	);

	assert.equal(reply.isError, true);
	assert.match(reply.content[0]?.text ?? "", /Released workflow stage could not answer: model unavailable/);
});

test("a plain send to a released stage reaches the host session that ran the workflow (#3622)", async () => {
	const { asker, host, stagePeerName, fixture } = await endRunOfWorkflowWithReleasedStage();
	await untilListed(asker, new RegExp(stagePeerName));

	const sent = await executeIntercom(asker, { action: "send", to: stagePeerName, message: "fyi: the build is green" });

	assert.equal(sent.details.delivered, true);
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (host.injectedMessages.length === 0 && Date.now() < deadline) {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	assert.match(host.injectedMessages[0]?.content ?? "", /fyi: the build is green/);
	assert.equal(fixture.sessions.length, 1, "a notification does not reopen the stage conversation");
});

test("a released stage stops being reachable when the host session that ran the workflow ends (#3622)", async () => {
	const { asker, host, stagePeerName } = await endRunOfWorkflowWithReleasedStage();
	await untilListed(asker, new RegExp(stagePeerName));

	await host.shutdown();

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let listing = "";
	do {
		listing = (await executeIntercom(asker, { action: "list" })).content[0]?.text ?? "";
		if (!listing.includes(stagePeerName)) break;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	} while (Date.now() < deadline);
	assert.doesNotMatch(listing, new RegExp(stagePeerName));
});
