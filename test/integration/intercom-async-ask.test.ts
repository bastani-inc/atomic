import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { configureTestStoreBackend } from "../helpers/store-backend.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { createPersistedStageFixture } from "../unit/persisted-stage-fixture.js";

const BROKER_STARTUP_TIMEOUT_MS = 10_000;
const BROKER_SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 20;
/** A foreground budget short enough to keep the suite quick and long enough to observe the call still waiting. */
const SHORT_BUDGET_MS = 300;

const repoRoot = resolve(import.meta.dirname, "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-async-ask-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

// The broker paths are read at module load, so every Intercom import follows the agent-dir override.
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
type ReleasedChildReply = import("../../packages/intercom/broker/client.js").ReleasedChildReply;
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError: boolean;
}

interface InjectedMessage {
	readonly customType?: string;
	readonly content?: string;
	readonly options?: { triggerTurn?: boolean; deliverAs?: string };
}

type Entry = Record<string, unknown> & { type: string };
type LifecycleHandler = (event: Record<string, unknown>, ctx: object) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;
type Execute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: object,
) => Promise<ToolResult>;

/** One Atomic session running Intercom against the real broker, with a session branch that survives a restart. */
function session(options: {
	readonly name: string;
	readonly sessionId?: string;
	readonly entries?: Entry[];
	readonly hasUI?: boolean;
	readonly automaticBudgetMs?: number;
	/** False for a session that is not saved (`--no-session`), which cannot be resumed once it ends. */
	readonly saved?: boolean;
	/** A workflow stage's orchestration context, as the stage runner gives its session. */
	readonly orchestrationContext?: object;
	/** An admitted subagent child's policy, as its launcher gives its session. */
	readonly subagentPolicy?: object;
}) {
	const sessionId = options.sessionId ?? randomUUID();
	const entries: Entry[] = options.entries ?? [];
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const events = new Map<string, EventHandler[]>();
	const tools = new Map<string, { execute: Execute }>();
	const injected: InjectedMessage[] = [];
	let idle = true;
	const record = (entry: Entry) => entries.push({ id: randomUUID(), timestamp: new Date().toISOString(), ...entry });
	const context = {
		hasUI: options.hasUI ?? true,
		cwd: repoRoot,
		isIdle: () => idle,
		model: { id: "test-model" },
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries,
			getEntries: () => entries,
			...(options.saved === false ? { getSessionStore: () => ({ descriptor: { adapter: "memory" } }) } : {}),
		},
		ui: { confirm: async () => true, notify() {} },
		...(options.orchestrationContext === undefined ? {} : { orchestrationContext: options.orchestrationContext }),
		...(options.subagentPolicy === undefined ? {} : { subagentPolicy: options.subagentPolicy }),
		...(options.automaticBudgetMs === undefined
			? {}
			: { getAgentTaskHost: () => ({ commandWaitBudgetMs: options.automaticBudgetMs, hasActiveTaskWaits: false }) }),
	};
	const deliver = (message: { customType?: string; content?: string; details?: unknown }, sendOptions?: object) => {
		injected.push({ customType: message.customType, content: message.content, options: sendOptions });
		record({
			type: "custom_message",
			customType: message.customType,
			content: message.content,
			details: message.details,
			display: true,
		});
	};
	const pi = {
		on(name: string, handler: LifecycleHandler) {
			lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute: Execute }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry(customType: string, data: unknown) {
			record({ type: "custom", customType, data });
		},
		async sendMessage(message: { customType?: string; content?: string; details?: unknown }, sendOptions?: object) {
			deliver(message, sendOptions);
		},
		async sendMessages(
			messages: Array<{ customType?: string; content?: string; details?: unknown }>,
			sendOptions?: object,
		) {
			for (const message of messages) deliver(message, sendOptions);
		},
		getSessionName: () => options.name,
		setSessionName() {},
		getActiveTools: () => [],
		setActiveTools() {},
		events: {
			on(name: string, handler: EventHandler) {
				events.set(name, [...(events.get(name) ?? []), handler]);
				return () =>
					events.set(
						name,
						(events.get(name) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(name: string, payload: object) {
				for (const handler of events.get(name) ?? []) void handler(payload);
			},
		},
	};
	intercomHeavy(pi as never);
	const fire = async (name: string, event: Record<string, unknown> = {}) => {
		for (const handler of lifecycle.get(name) ?? []) await handler({ type: name, ...event }, context);
	};
	const call = (params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
		const tool = tools.get("intercom");
		assert.ok(tool, "the intercom tool is registered");
		return tool.execute(randomUUID(), params, signal, undefined, context);
	};
	return {
		pi,
		sessionId,
		entries,
		injected,
		call,
		start: (reason = "startup") => fire("session_start", { reason }),
		shutdown: () => fire("session_shutdown", { reason: "quit" }),
		/** Busy in a long tool call, as a session running a long bash command is. */
		async busy(toolName = "bash") {
			idle = false;
			await fire("agent_start");
			await fire("tool_execution_start", { toolCallId: "long-call", toolName, args: {} });
		},
		async becomeIdle() {
			await fire("tool_execution_end", { toolCallId: "long-call", toolName: "bash", result: {}, isError: false });
			idle = true;
			await fire("agent_end", { messages: [] });
		},
		cards: (pattern: RegExp) => injected.filter((message) => pattern.test(message.content ?? "")),
	};
}

type Session = ReturnType<typeof session>;

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, label: string): Promise<T> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined && value !== false) return value;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
	}
	throw new Error(`timed out waiting until ${label}`);
}

/** Start a session and connect it, so peers can reach it before it uses Intercom itself. */
async function started(options: Parameters<typeof session>[0]): Promise<Session> {
	const current = session(options);
	await current.start();
	cleanups.push(() => current.shutdown());
	const status = await current.call({ action: "status" });
	assert.equal(status.isError, false, status.content[0]?.text);
	return current;
}

/** The recipient has the question as a message it can reply to. */
async function questionArrives(recipient: Session, question: string): Promise<void> {
	await until(() => recipient.cards(new RegExp(question)).length > 0, `the recipient receives "${question}"`);
}

let broker: ChildProcess | undefined;
const cleanups: Array<() => void | Promise<void>> = [];

beforeAll(async () => {
	const child = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	broker = child;
	await new Promise<void>((resolveReady, rejectReady) => {
		let stdout = "";
		const timer = setTimeout(
			() => rejectReady(new Error("Intercom broker did not become ready")),
			BROKER_STARTUP_TIMEOUT_MS,
		);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (!stdout.includes("Intercom broker started")) return;
			clearTimeout(timer);
			resolveReady();
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			rejectReady(new Error(`Intercom broker exited before readiness (code=${String(code)})`));
		});
	});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

afterAll(async () => {
	const active = broker;
	broker = undefined;
	if (active !== undefined && active.exitCode === null) {
		await new Promise<void>((resolveExit, rejectExit) => {
			const timer = setTimeout(() => rejectExit(new Error("Broker did not exit")), BROKER_SHUTDOWN_TIMEOUT_MS);
			active.once("exit", () => {
				clearTimeout(timer);
				resolveExit();
			});
			active.kill("SIGTERM");
		});
	}
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("an ask to a busy recipient returns at delivery and the reply arrives later as a message (#4751)", async () => {
	const asker = await started({ name: "asker-busy" });
	const recipient = await started({ name: "recipient-busy" });
	await recipient.busy("bash");

	const asked = await asker.call({
		action: "ask",
		to: "recipient-busy",
		message: "which test fails?",
		wait: { kind: "background" },
	});
	assert.equal(asked.isError, false, asked.content[0]?.text);
	const askId = asked.details.askId;
	assert.equal(typeof askId, "string");
	assert.deepEqual(asked.details.recipient, { name: "recipient-busy", state: "busy", currentAction: "running bash" });
	assert.equal(asked.details.delivered, true);
	assert.match(asked.content[0]?.text ?? "", /busy: running bash/);

	const pending = await asker.call({ action: "pending" });
	assert.match(pending.content[0]?.text ?? "", new RegExp(`${askId} → recipient-busy`));

	// The recipient reads the question only after its long tool call, then answers.
	await recipient.becomeIdle();
	await questionArrives(recipient, "which test fails\\?");
	const replied = await recipient.call({ action: "reply", message: "the login test", replyTo: askId });
	assert.equal(replied.isError, false, replied.content[0]?.text);

	const [card] = await until(() => {
		const cards = asker.cards(/^Reply to your ask/);
		return cards.length > 0 ? cards : undefined;
	}, "the reply arrives on the asker's thread");
	assert.ok(card);
	assert.ok(card.content?.startsWith(`Reply to your ask ${askId} from recipient-busy`), card.content);
	assert.match(card.content ?? "", /> which test fails\?/);
	assert.match(card.content ?? "", /the login test/);
	assert.equal(
		card.options?.triggerTurn,
		true,
		"the reply starts a turn when idle, or steers after the current tool call",
	);
	assert.match(
		(await asker.call({ action: "pending" })).content[0]?.text ?? "",
		/No unresolved inbound or outbound asks/,
	);
});

test("an omitted wait uses the owner's automatic yield, and a foreground budget yields with the ask pending (#4751)", async () => {
	const asker = await started({ name: "asker-budget", automaticBudgetMs: SHORT_BUDGET_MS });
	const recipient = await started({ name: "recipient-budget" });
	await recipient.busy();

	for (const wait of [undefined, { kind: "foreground", budgetMs: SHORT_BUDGET_MS }]) {
		const started = Date.now();
		const asked = await asker.call({
			action: "ask",
			to: "recipient-budget",
			message: `budget question ${wait === undefined ? "automatic" : "foreground"}`,
			...(wait === undefined ? {} : { wait }),
		});
		assert.equal(asked.isError, false, asked.content[0]?.text);
		assert.ok(Date.now() - started >= SHORT_BUDGET_MS, "the call waited for its budget");
		assert.match(asked.content[0]?.text ?? "", /^No reply yet; the wait budget ended\. Ask .* stays pending/);
		assert.equal(asked.details.pending, true);
	}
	assert.equal(asker.cards(/^Reply to your ask/).length, 0);
});

test("a reply within the foreground budget is returned inline and never repeated as a message (#4751)", async () => {
	const asker = await started({ name: "asker-inline" });
	const recipient = await started({ name: "recipient-inline" });

	const asking = asker.call({
		action: "ask",
		to: "recipient-inline",
		message: "quick question?",
		wait: { kind: "foreground", budgetMs: POLL_TIMEOUT_MS },
	});
	await questionArrives(recipient, "quick question\\?");
	const replied = await recipient.call({ action: "reply", to: "asker-inline", message: "quick answer" });
	assert.equal(replied.isError, false, replied.content[0]?.text);
	const asked = await asking;
	assert.equal(asked.isError, false, asked.content[0]?.text);
	assert.match(asked.content[0]?.text ?? "", /\*\*Reply from recipient-inline:\*\*\nquick answer/);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, SHORT_BUDGET_MS));
	assert.equal(asker.cards(/quick answer/).length, 0);
});

test("a refused ask comes back as a failed-ask message (#4751)", async () => {
	const asker = await started({ name: "asker-refused" });
	// A busy non-interactive session refuses the question without interrupting its task.
	const recipient = await started({ name: "recipient-refused", hasUI: false });
	await recipient.busy();

	const asked = await asker.call({
		action: "ask",
		to: "recipient-refused",
		message: "can you look?",
		wait: { kind: "background" },
	});
	assert.equal(asked.isError, false, asked.content[0]?.text);
	const [card] = await until(() => {
		const cards = asker.cards(/^Your ask .* failed/);
		return cards.length > 0 ? cards : undefined;
	}, "the refusal arrives as a failed-ask message");
	assert.ok(card?.content?.startsWith(`Your ask ${String(asked.details.askId)} to recipient-refused failed`));
	assert.match(card?.content ?? "", /> can you look\?/);
	assert.match(card?.content ?? "", /recipient was busy in non-interactive mode/);
	assert.match((await asker.call({ action: "pending" })).content[0]?.text ?? "", /No unresolved/);
});

test("an ask whose recipient session ends comes back as a failed-ask message (#4751)", async () => {
	const asker = await started({ name: "asker-closed" });
	// A session that is not saved cannot be resumed, so ending it ends the ask.
	const recipient = await started({ name: "recipient-closed", saved: false });
	await recipient.busy();

	const asked = await asker.call({
		action: "ask",
		to: "recipient-closed",
		message: "still there?",
		wait: { kind: "background" },
	});
	assert.equal(asked.isError, false, asked.content[0]?.text);
	await recipient.shutdown();

	const [card] = await until(() => {
		const cards = asker.cards(/^Your ask .* failed/);
		return cards.length > 0 ? cards : undefined;
	}, "the closed recipient arrives as a failed-ask message");
	assert.ok(card?.content?.startsWith(`Your ask ${String(asked.details.askId)} to recipient-closed failed`));
	assert.match(card?.content ?? "", /ended before replying/);
	assert.equal(card?.options?.triggerTurn, true);
});

test("a cancelled ask leaves pending, and a later reply is shown once, marked late (#4751)", async () => {
	const asker = await started({ name: "asker-cancel" });
	const recipient = await started({ name: "recipient-cancel" });

	const asked = await asker.call({
		action: "ask",
		to: "recipient-cancel",
		message: "cancel me?",
		wait: { kind: "background" },
	});
	const askId = String(asked.details.askId);
	const cancelled = await asker.call({ action: "cancel", askId: askId.slice(0, 8) });
	assert.equal(cancelled.isError, false, cancelled.content[0]?.text);
	assert.match(cancelled.content[0]?.text ?? "", new RegExp(`Cancelled ask ${askId}`));
	assert.match((await asker.call({ action: "pending" })).content[0]?.text ?? "", /No unresolved/);
	assert.equal(
		(await asker.call({ action: "cancel", askId })).isError,
		true,
		"a cancelled ask cannot be cancelled again",
	);

	await questionArrives(recipient, "cancel me\\?");
	assert.equal((await recipient.call({ action: "reply", to: "asker-cancel", message: "too late" })).isError, false);
	const [card] = await until(() => {
		const cards = asker.cards(/too late/);
		return cards.length > 0 ? cards : undefined;
	}, "the late reply arrives");
	assert.ok(
		card?.content?.startsWith(`Reply to your ask ${askId} from recipient-cancel (late: you cancelled this ask)`),
	);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, SHORT_BUDGET_MS));
	assert.equal(asker.cards(/too late/).length, 1);
});

test("an asker that restarts keeps its ask and receives the reply once after resume (#4751)", async () => {
	const first = await started({ name: "asker-restart" });
	const recipient = await started({ name: "recipient-restart" });

	const asked = await first.call({
		action: "ask",
		to: "recipient-restart",
		message: "survive a restart?",
		wait: { kind: "background" },
	});
	const askId = String(asked.details.askId);
	await questionArrives(recipient, "survive a restart\\?");
	await first.shutdown();

	// The same session resumes from its saved branch and connects under its earlier Intercom id.
	const resumed = session({ name: "asker-restart", sessionId: first.sessionId, entries: first.entries });
	await resumed.start("resume");
	cleanups.push(() => resumed.shutdown());
	assert.equal((await resumed.call({ action: "status" })).isError, false);
	assert.match((await resumed.call({ action: "pending" })).content[0]?.text ?? "", new RegExp(askId));

	const replied = await recipient.call({ action: "reply", message: "yes, after resume", replyTo: askId });
	assert.equal(replied.isError, false, replied.content[0]?.text);
	await until(() => resumed.cards(/yes, after resume/).length > 0, "the reply reaches the resumed asker");
	assert.ok(
		resumed.cards(/yes, after resume/)[0]?.content?.startsWith(`Reply to your ask ${askId} from recipient-restart`),
	);

	// Exactly once: another restart replays nothing that is already on the branch.
	await resumed.shutdown();
	const again = session({ name: "asker-restart", sessionId: first.sessionId, entries: first.entries });
	await again.start("resume");
	cleanups.push(() => again.shutdown());
	assert.equal((await again.call({ action: "status" })).isError, false);
	await new Promise((resolveDelay) => setTimeout(resolveDelay, SHORT_BUDGET_MS));
	assert.equal(
		first.entries.filter(
			(entry) => entry.type === "custom_message" && /yes, after resume/.test(String(entry.content)),
		).length,
		1,
	);
	assert.match((await again.call({ action: "pending" })).content[0]?.text ?? "", /No unresolved/);
});

test("a recipient that restarts can still answer the ask, delivered once (#4751)", async () => {
	const asker = await started({ name: "asker-recipient-restart" });
	const first = await started({ name: "recipient-restarting" });

	const asked = await asker.call({
		action: "ask",
		to: "recipient-restarting",
		message: "answer after restart?",
		wait: { kind: "background" },
	});
	const askId = String(asked.details.askId);
	await questionArrives(first, "answer after restart\\?");
	await first.shutdown();
	const resumed = session({ name: "recipient-restarting", sessionId: first.sessionId, entries: first.entries });
	await resumed.start("resume");
	cleanups.push(() => resumed.shutdown());
	assert.equal((await resumed.call({ action: "status" })).isError, false);

	const replied = await resumed.call({ action: "reply", message: "answered after my restart", replyTo: askId });
	assert.equal(replied.isError, false, replied.content[0]?.text);
	await until(() => asker.cards(/answered after my restart/).length > 0, "the asker receives the reply");
	await new Promise((resolveDelay) => setTimeout(resolveDelay, SHORT_BUDGET_MS));
	assert.equal(asker.cards(/answered after my restart/).length, 1);
});

test("one workflow stage asks another and gets the reply as a message while it keeps running (#4751)", async () => {
	// The session that runs the workflow publishes the run's route, which each stage's Intercom peer registers against.
	const host = session({ name: "workflow-host" });
	intercomLightweight(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());
	const stages = new Map<string, Session>();
	const stageNames = new Map<string, string>();
	const stageFixture = createPersistedStageFixture({
		reply: (text) => `done: ${text}`,
		async onCreate(createOptions) {
			const manager = createOptions.sessionManager;
			const orchestration = createOptions.orchestrationContext;
			assert.ok(manager && orchestration?.kind === "workflow-stage");
			const peer = session({ name: "", sessionId: manager.getSessionId(), orchestrationContext: orchestration });
			await peer.start();
			stages.set(orchestration.workflowStageName, peer);
			stageNames.set(orchestration.workflowStageName, `subagent-chat-${manager.getSessionId()}`);
			return () => peer.shutdown();
		},
		async onPrompt(text) {
			if (text.includes("ask the reviewer")) {
				const asker = stages.get("author");
				assert.ok(asker);
				const reviewer = await until(() => stageNames.get("reviewer"), "the reviewer stage starts");
				const asked = await asker.call({
					action: "ask",
					to: reviewer,
					message: "is the change safe?",
					wait: { kind: "background" },
				});
				assert.equal(asked.isError, false, asked.content[0]?.text);
				askId = String(asked.details.askId);
				// The asking stage is not blocked: it goes on with its own work and the reply arrives as a message.
				await until(() => asker.cards(/^Reply to your ask/).length > 0, "the author stage receives the reply");
			}
			if (text.includes("review the change")) {
				const reviewer = await until(() => stages.get("reviewer"), "the reviewer stage peer starts");
				await until(() => reviewer.cards(/is the change safe\?/).length > 0, "the reviewer receives the question");
				const replied = await reviewer.call({
					action: "reply",
					to: stageNames.get("author"),
					message: "safe to merge",
				});
				assert.equal(replied.isError, false, replied.content[0]?.text);
			}
		},
	});
	let askId = "";
	const store = createStore();
	const registry = createStageControlRegistry();
	const runId = randomUUID();
	const backend = await createMemoryTestBackend();
	configureTestStoreBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "stage-ask",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	cleanups.push(registerPendingStageIntercomBridge(host.pi as never, store));
	cleanups.push(() => registry.clear());
	const definition = workflow({
		name: "stage-ask",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await Promise.all([
				ctx.stage("author").prompt("ask the reviewer"),
				ctx.stage("reviewer").prompt("review the change"),
			]);
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{ runId, store, stageControlRegistry: registry, adapters: stageFixture.adapters },
	);
	assert.equal(result.status, "completed", JSON.stringify(result));
	const author = stages.get("author");
	assert.ok(author);
	const [card] = author.cards(/^Reply to your ask/);
	assert.ok(card?.content?.startsWith(`Reply to your ask ${askId} from ${stageNames.get("reviewer")}`), card?.content);
	assert.match(card?.content ?? "", /safe to merge/);
});

test("only the asked recipient can answer an ask; another peer's message naming it is an ordinary message (#4751)", async () => {
	const asker = await started({ name: "asker-spoof" });
	await started({ name: "recipient-spoof" });
	const stranger = await started({ name: "stranger-spoof" });

	const asked = await asker.call({
		action: "ask",
		to: "recipient-spoof",
		message: "who answers?",
		wait: { kind: "background" },
	});
	const askId = String(asked.details.askId);
	const spoofed = await stranger.call({
		action: "send",
		to: "asker-spoof",
		message: "not your recipient",
		replyTo: askId,
	});
	assert.equal(spoofed.isError, false, spoofed.content[0]?.text);
	await until(() => asker.cards(/not your recipient/).length > 0, "the stranger's message arrives");
	assert.equal(asker.cards(/^Reply to your ask/).length, 0);
	assert.match(
		(await asker.call({ action: "pending" })).content[0]?.text ?? "",
		new RegExp(`${askId} → recipient-spoof`),
	);
});

test("an asker that is away when its recipient ends gets the failed-ask message when it resumes (#4751)", async () => {
	const first = await started({ name: "asker-away" });
	const recipient = await started({ name: "recipient-ends-while-away", saved: false });

	const asked = await first.call({
		action: "ask",
		to: "recipient-ends-while-away",
		message: "still there later?",
		wait: { kind: "background" },
	});
	const askId = String(asked.details.askId);
	await questionArrives(recipient, "still there later\\?");
	await first.shutdown();
	await recipient.shutdown();

	const resumed = session({ name: "asker-away", sessionId: first.sessionId, entries: first.entries });
	await resumed.start("resume");
	cleanups.push(() => resumed.shutdown());
	assert.equal((await resumed.call({ action: "status" })).isError, false);
	const [card] = await until(() => {
		const cards = resumed.cards(/^Your ask .* failed/);
		return cards.length > 0 ? cards : undefined;
	}, "the resumed asker learns its recipient ended");
	assert.ok(card?.content?.startsWith(`Your ask ${askId} to recipient-ends-while-away failed`));
	assert.match((await resumed.call({ action: "pending" })).content[0]?.text ?? "", /No unresolved/);
});

test("a background subagent that yields an ask, is released, and is woken by the reply gets it once as a message (#4751)", async () => {
	const childName = "subagent-worker-async-1";
	// The launching session: it authorizes the child, keeps it reserved while it is released, and wakes it.
	const owner = new IntercomClient(randomUUID());
	await owner.connect(
		{
			name: "owner-async",
			model: "m",
			cwd: repoRoot,
			pid: process.pid,
			startedAt: Date.now(),
			lastActivity: Date.now(),
		},
		undefined,
		randomUUID(),
	);
	cleanups.push(() => owner.disconnect().catch(() => undefined));
	const policy = (supervisor: { capability: string; supervisorSessionId: string }) => ({
		intercom: {
			orchestratorTarget: "owner-async",
			runId: "async-run",
			agent: "worker",
			index: 0,
			sessionName: childName,
			supervisor,
		},
	});
	const peer = await started({ name: "peer-busy-for-child" });
	await peer.busy();
	const first = session({
		name: childName,
		automaticBudgetMs: SHORT_BUDGET_MS,
		subagentPolicy: policy(await owner.authorizeSupervisorChild(childName)),
	});
	await first.start();

	// The default wait yields while the peer is busy; the child's call returns and the ask stays pending.
	const asked = await first.call({ action: "ask", to: "peer-busy-for-child", message: "which port?" });
	assert.equal(asked.isError, false, asked.content[0]?.text);
	assert.equal(asked.details.pending, true);
	const askId = String(asked.details.askId);

	// The child is released while it waits on something else: its owner reserves it, and its session closes.
	await owner.reserveReleasedChildren([{ childName, wake: true }]);
	await first.shutdown();
	const handoffs: string[] = [];
	owner.on("released_child_reply", (notice: ReleasedChildReply) => {
		handoffs.push(notice.replyTo);
		// No call of the child waits for this reply, as Subagents answers for such a child.
		owner.acknowledgeReleasedChildReply(notice, false, true);
	});
	const woken = Promise.withResolvers<Session>();
	owner.on("restoring_recipient_wake", () => {
		void (async () => {
			const resumed = session({
				name: childName,
				sessionId: first.sessionId,
				entries: first.entries,
				subagentPolicy: policy(await owner.authorizeSupervisorChild(childName)),
			});
			cleanups.push(() => resumed.shutdown());
			await resumed.start("resume");
			woken.resolve(resumed);
		})();
	});

	await peer.becomeIdle();
	await questionArrives(peer, "which port\\?");
	const replied = await peer.call({ action: "reply", to: childName, message: "port 8080", replyTo: askId });
	assert.equal(replied.isError, false, replied.content[0]?.text);
	const resumed = await woken.promise;
	await until(() => resumed.cards(/port 8080/).length > 0, "the woken child receives the reply");
	assert.ok(resumed.cards(/port 8080/)[0]?.content?.startsWith(`Reply to your ask ${askId} from peer-busy-for-child`));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, SHORT_BUDGET_MS));
	assert.equal(
		first.entries.filter((entry) => entry.type === "custom_message" && /port 8080/.test(String(entry.content)))
			.length,
		1,
		"the reply is shown exactly once",
	);
	assert.deepEqual(handoffs, [askId]);
});

test("a workflow stage released after asking gets the reply once it reopens (#4751)", async () => {
	const host = session({ name: "workflow-host-released" });
	intercomLightweight(host.pi as never);
	await host.start();
	cleanups.push(() => host.shutdown());
	const peers = new Map<string, Session[]>();
	const ids = new Map<string, string>();
	let askId = "";
	const released = Promise.withResolvers<void>();
	const reviewerReplied = Promise.withResolvers<void>();
	const stageFixture = createPersistedStageFixture({
		reply: (text) => `done: ${text}`,
		async onCreate(createOptions) {
			const manager = createOptions.sessionManager;
			const orchestration = createOptions.orchestrationContext;
			assert.ok(manager && orchestration?.kind === "workflow-stage");
			const name = orchestration.workflowStageName;
			const earlier = peers.get(name)?.at(-1);
			// A reopened stage continues from its saved session.
			const peer = session({
				name: "",
				sessionId: manager.getSessionId(),
				orchestrationContext: orchestration,
				...(earlier === undefined ? {} : { entries: earlier.entries }),
			});
			await peer.start(earlier === undefined ? "startup" : "resume");
			peers.set(name, [...(peers.get(name) ?? []), peer]);
			ids.set(name, manager.getSessionId());
			return () => peer.shutdown();
		},
		async onPrompt(text) {
			if (text.includes("ask then wait")) {
				const author = peers.get("author")?.at(-1);
				assert.ok(author);
				const reviewerId = await until(() => ids.get("reviewer"), "the reviewer stage starts");
				const asked = await author.call({
					action: "ask",
					to: `subagent-chat-${reviewerId}`,
					message: "is it safe while I am away?",
					wait: { kind: "background" },
				});
				assert.equal(asked.isError, false, asked.content[0]?.text);
				askId = String(asked.details.askId);
			}
			if (text.includes("review while the author is away")) {
				await released.promise;
				const reviewer = await until(() => peers.get("reviewer")?.at(-1), "the reviewer stage peer starts");
				await until(
					() => reviewer.cards(/is it safe while I am away\?/).length > 0,
					"the reviewer receives the question",
				);
				const replied = await reviewer.call({
					action: "reply",
					to: `subagent-chat-${ids.get("author")}`,
					message: "safe once you are back",
					replyTo: askId,
				});
				assert.equal(replied.isError, false, replied.content[0]?.text);
				reviewerReplied.resolve();
			}
			if (text.includes("continue after the reply")) {
				// The reopened author took the reply that waited for it while it was released.
				await until(
					() =>
						peers
							.get("author")
							?.at(-1)
							?.cards(/safe once you are back/).length,
					"the reopened author receives the reply",
				);
				const pending = await peers.get("author")?.at(-1)?.call({ action: "pending" });
				assert.match(pending?.content[0]?.text ?? "", /No unresolved/, "the answered ask is no longer pending");
			}
		},
	});
	const store = createStore();
	const registry = createStageControlRegistry();
	const runId = randomUUID();
	const backend = await createMemoryTestBackend();
	configureTestStoreBackend(store, backend);
	await backend.commitWorkflowRegistration({
		workflowId: runId,
		name: "stage-ask-released",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	cleanups.push(registerPendingStageIntercomBridge(host.pi as never, store));
	cleanups.push(() => registry.clear());
	const definition = workflow({
		name: "stage-ask-released",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const author = ctx.stage("author");
			await Promise.all([
				(async () => {
					await author.prompt("ask then wait");
					// The stage is released between turns while its ask is pending.
					await author.release();
					released.resolve();
					await reviewerReplied.promise;
					// The workflow's next message reopens the stage's saved session.
					await author.sendUserMessage("continue after the reply");
				})(),
				ctx.stage("reviewer").prompt("review while the author is away"),
			]);
			return {};
		},
	});
	const result = await run(
		definition,
		{},
		{ runId, store, stageControlRegistry: registry, adapters: stageFixture.adapters },
	);
	assert.equal(result.status, "completed", JSON.stringify(result));
	const reopened = peers.get("author")?.at(-1);
	assert.ok(reopened);
	const cards = (peers.get("author") ?? []).flatMap((peer) => peer.cards(/safe once you are back/));
	assert.equal(cards.length, 1, "the reply is shown exactly once");
	assert.ok(cards[0]?.content?.startsWith(`Reply to your ask ${askId} from subagent-chat-`), cards[0]?.content);
});

test("a reply sent while its top-level asker is closed is held and delivered once when the asker resumes (#4751)", async () => {
	const first = await started({ name: "asker-closed-at-reply" });
	const recipient = await started({ name: "recipient-replies-while-closed" });
	const asked = await first.call({
		action: "ask",
		to: "recipient-replies-while-closed",
		message: "answer me later?",
		wait: { kind: "background" },
	});
	const askId = String(asked.details.askId);
	await questionArrives(recipient, "answer me later\\?");
	await first.shutdown();

	const replied = await recipient.call({ action: "reply", message: "answered while you were away", replyTo: askId });
	assert.equal(replied.isError, false, replied.content[0]?.text);
	assert.match(replied.content[0]?.text ?? "", /^Reply delivered \(held for asker-closed-at-reply/);

	const resumed = session({ name: "asker-closed-at-reply", sessionId: first.sessionId, entries: first.entries });
	await resumed.start("resume");
	cleanups.push(() => resumed.shutdown());
	assert.equal((await resumed.call({ action: "status" })).isError, false);
	await until(
		() => resumed.cards(/answered while you were away/).length > 0,
		"the resumed asker receives the held reply",
	);
	assert.ok(resumed.cards(/answered while you were away/)[0]?.content?.startsWith(`Reply to your ask ${askId} from`));
	await new Promise((resolveDelay) => setTimeout(resolveDelay, SHORT_BUDGET_MS));
	assert.equal(
		first.entries.filter(
			(entry) => entry.type === "custom_message" && /answered while you were away/.test(String(entry.content)),
		).length,
		1,
	);
	assert.match((await resumed.call({ action: "pending" })).content[0]?.text ?? "", /No unresolved/);
});

test("an ask to a child that finishes while its top-level asker is closed fails once when the asker resumes (#4751)", async () => {
	const first = await started({ name: "asker-of-finishing-child" });
	// A subagent child that finishes keeps its registration but can no longer answer.
	const child = new IntercomClient(randomUUID(), { acknowledgesReceipt: true });
	child.on("message", (_from: object, message: { id: string }) => child.acknowledgeReceived(message.id));
	await child.connect({
		name: "child-that-finishes",
		model: "m",
		cwd: repoRoot,
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
	});
	cleanups.push(() => child.disconnect().catch(() => undefined));
	const asked = await first.call({
		action: "ask",
		to: "child-that-finishes",
		message: "still working?",
		wait: { kind: "background" },
	});
	assert.equal(asked.isError, false, asked.content[0]?.text);
	const askId = String(asked.details.askId);
	await first.shutdown();
	await child.updatePresenceAcked({ replyCapability: "terminal" });

	const resumed = session({ name: "asker-of-finishing-child", sessionId: first.sessionId, entries: first.entries });
	await resumed.start("resume");
	cleanups.push(() => resumed.shutdown());
	assert.equal((await resumed.call({ action: "status" })).isError, false);
	const [card] = await until(() => {
		const cards = resumed.cards(/^Your ask .* failed/);
		return cards.length > 0 ? cards : undefined;
	}, "the resumed asker learns its recipient can no longer answer");
	assert.ok(card?.content?.startsWith(`Your ask ${askId} to child-that-finishes failed`));
	assert.match((await resumed.call({ action: "pending" })).content[0]?.text ?? "", /No unresolved/);
});
