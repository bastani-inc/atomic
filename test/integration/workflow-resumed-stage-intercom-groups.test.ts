import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CreateAgentSessionOptions, SessionEntry, SessionManager } from "@bastani/atomic";
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
const agentDir = mkdtempSync(join(tmpdir(), "resumed-stage-groups-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { default: intercom } = await import("../../packages/intercom/index.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");

type StageOrchestrationContext = NonNullable<CreateAgentSessionOptions["orchestrationContext"]>;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: { delivered?: boolean; queued?: boolean; groups?: string[] };
	isError: boolean;
}

interface InjectedMessage {
	customType?: string;
	content?: string;
	details?: { message?: { id?: string } };
}

type LifecycleHandler = (event: Record<string, object | string>, ctx: TestContext) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

interface TestSessionManager {
	getSessionId(): string;
	getBranch(): SessionEntry[];
	getEntries(): SessionEntry[];
}

interface TestContext {
	hasUI: boolean;
	cwd: string;
	isIdle(): boolean;
	model: { id: string };
	orchestrationContext: StageOrchestrationContext | { intercomGroup: string };
	sessionManager: TestSessionManager;
	ui: { confirm(): Promise<boolean>; notify(): void };
}

interface CapturedTool {
	name: string;
	execute?: (
		toolCallId: string,
		params: { action: string; message?: string; to?: string; group?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: TestContext,
	) => Promise<ToolResult>;
}

/** A stand-in session store for a session with no saved conversation (the host and the sender). */
function ephemeralManager(sessionId: string): TestSessionManager {
	return { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [] };
}

/** One session's Intercom extension. A stage uses its real session manager, so `join` is saved with the stage. */
function extensionFixture(
	sessionName: string,
	orchestrationContext: TestContext["orchestrationContext"],
	manager: TestSessionManager,
	persist?: SessionManager,
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
		sessionManager: manager,
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
		async appendEntry(customType: string, data?: object) {
			await persist?.appendCustomEntry(customType, data);
		},
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
	const tool = (params: { action: string; message?: string; to?: string; group?: string }): Promise<ToolResult> => {
		const execute = tools.get("intercom")?.execute;
		assert.ok(execute);
		return execute("test-call", params, undefined, undefined, context);
	};
	return {
		pi,
		injectedMessages,
		tool,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
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

test("a resumed workflow stage keeps its subgroup and the group it joined, so it is reachable by path and by name (#4079)", async () => {
	const host = extensionFixture("host", { intercomGroup: "default" }, ephemeralManager("host-session"));
	intercom(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());

	const stagePeers: Array<{ readonly sessionId: string; readonly peer: Fixture }> = [];
	let blockReviewer = true;
	const releaseReviewer = Promise.withResolvers<void>();
	const fixture = createPersistedStageFixture({
		reply: (text) => `done: ${text}`,
		onPrompt: async () => {
			if (blockReviewer) {
				const peer = stagePeers.at(-1)?.peer;
				assert.ok(peer);
				const joined = await peer.tool({ action: "join", group: "reviewer-team" });
				assert.equal(joined.isError, false, JSON.stringify(joined));
				throw new Error("HTTP 429 quota exceeded");
			}
			await releaseReviewer.promise;
		},
		async onCreate(createOptions) {
			const manager = createOptions.sessionManager;
			const orchestration = createOptions.orchestrationContext;
			assert.ok(manager && orchestration?.kind === "workflow-stage");
			const sessionId = manager.getSessionId();
			// The resumed stage reopens the blocked stage's session; keep one live peer per session.
			for (const previous of stagePeers.filter((entry) => entry.sessionId === sessionId))
				await previous.peer.shutdown();
			const peer = extensionFixture("resumed-reviewer", orchestration, manager, manager);
			intercomHeavy(peer.pi as never);
			await peer.start();
			stagePeers.push({ sessionId, peer });
			return () => peer.shutdown();
		},
	});
	cleanups.push(async () => {
		releaseReviewer.resolve();
		for (const { peer } of stagePeers) await peer.shutdown();
	});

	const backend = await JournalTestBackend.create();
	setDurableBackend(backend);
	const store = createStore();
	configureTestStoreBackend(store, backend);
	cleanups.push(registerPendingStageIntercomBridge(host.pi as never, store));
	const definition = workflow({
		name: "resumed-stage-groups",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("reviewer", { group: "reviewers" }).prompt("review");
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

	const started = await runtime.dispatch({ action: "run", workflow: definition.name, inputs: {} });
	assert.ok("runId" in started && typeof started.runId === "string", JSON.stringify(started));
	const runId = started.runId;
	const runSnapshot = () => store.runs().find((candidate) => candidate.id === runId);
	await jobs.get(runId)?.promise;
	assert.equal(runSnapshot()?.failureDisposition, "active_blocked", JSON.stringify(runSnapshot()));

	blockReviewer = false;
	const resumed = await runtime.resumeFailedRun(runId);
	assert.equal(resumed.ok, true, resumed.ok ? undefined : resumed.message);
	await until("the resumed reviewer stage to be live", () => {
		const reviewer = runSnapshot()?.stages.find((stage) => stage.name === "reviewer");
		return reviewer?.status === "running" && fixture.sessions.length === 2;
	});
	assert.equal(stagePeers.length, 2);
	assert.equal(stagePeers[1]?.sessionId, stagePeers[0]?.sessionId, "the resumed stage reopens its own session");

	// A teammate that shares only the joined group, and the launcher's invocation-group peer.
	const teammate = new IntercomClient("reviewer-teammate-session");
	await teammate.connect({
		name: "reviewer-teammate",
		model: "test-model",
		cwd: repoRoot,
		pid: process.pid,
		status: "idle",
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group: "reviewer-team",
		groups: ["reviewer-team"],
	});
	cleanups.push(() => teammate.disconnect().catch(() => undefined));
	const resumedStage = stagePeers[1]!.peer;
	const listed = (await teammate.listSessions()).find((session) => session.name === "resumed-reviewer");
	assert.ok(listed, "the resumed stage shares the group it joined before the quit");
	assert.deepEqual(
		[...(listed.groups ?? [])].sort(),
		[`workflow:${runId}/reviewers`, "reviewer-team"].sort(),
		"exactly the subgroup and the joined group; no sibling or invocation membership is granted",
	);

	const byName = await teammate.send("resumed-reviewer", { text: "TOKEN-BY-NAME" });
	assert.equal(byName.delivered, true, byName.reason);

	const launcher = extensionFixture("launcher", { intercomGroup: `workflow:${runId}` }, ephemeralManager("launcher"));
	intercomHeavy(launcher.pi as never);
	await launcher.start();
	cleanups.push(() => launcher.shutdown());
	const byPath = await launcher.tool({ action: "send", to: `workflow:${runId}/reviewer`, message: "TOKEN-BY-PATH" });
	assert.equal(byPath.isError, false, JSON.stringify(byPath));

	const texts = () => resumedStage.injectedMessages.map((message) => message.content ?? "");
	await until("both messages to reach the resumed stage", () =>
		["TOKEN-BY-NAME", "TOKEN-BY-PATH"].every((token) => texts().some((text) => text.includes(token))),
	);
	for (const token of ["TOKEN-BY-NAME", "TOKEN-BY-PATH"])
		assert.equal(texts().filter((text) => text.includes(token)).length, 1, `${token} delivered once`);

	releaseReviewer.resolve();
	await jobs.get(runId)?.promise;
	assert.equal(runSnapshot()?.status, "completed", JSON.stringify(runSnapshot()));
});
