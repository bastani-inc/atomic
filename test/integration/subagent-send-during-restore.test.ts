import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { afterAll, test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChild,
	type SubagentChildRestoreDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const agentDir = mkdtempSync(join(tmpdir(), "send-during-restore-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

const { getBrokerPidPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

/** Spawning the detached broker child is the structural cost of this real-broker suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const RECORD_WAIT_MS = 5_000;
const SETTLE_MS = 400;

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: unknown) => void;

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: { delivered?: boolean; error?: boolean };
	isError?: boolean;
}

const worker: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

function eventBus() {
	const handlers = new Map<string, EventHandler[]>();
	return {
		on(eventName: string, handler: EventHandler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
			return () => {
				handlers.set(
					eventName,
					(handlers.get(eventName) ?? []).filter((candidate) => candidate !== handler),
				);
			};
		},
		emit(eventName: string, payload: unknown) {
			for (const handler of handlers.get(eventName) ?? []) handler(payload);
		},
	};
}

/** The real Intercom and Subagents extensions, wired to one event bus the way a resumed session wires them. */
function resumedSession(cwd: string, sessionManager: SessionManager, host: AgentTaskHost) {
	const events = eventBus();
	const intercomHandlers = new Map<string, Handler[]>();
	const subagentHandlers = new Map<string, Handler[]>();
	const tools = new Map<
		string,
		{ execute: (id: string, params: object, s: undefined, u: undefined, c: object) => Promise<ToolResult> }
	>();
	let activeTools: string[] = [];
	const appendEntry = async (customType: string, data?: unknown) => {
		await sessionManager.appendCustomEntry(customType, data);
	};
	const intercomPi = {
		on(eventName: string, handler: Handler) {
			intercomHandlers.set(eventName, [...(intercomHandlers.get(eventName) ?? []), handler]);
		},
		registerTool(tool: { name: string; execute: never }) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry,
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => "send-parent",
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events,
	};
	const subagentPi = {
		on(eventName: string, handler: Handler) {
			subagentHandlers.set(eventName, [...(subagentHandlers.get(eventName) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		appendEntry,
		getSessionName: () => "send-parent",
		events,
	};
	const ctx = {
		hasUI: false,
		cwd,
		isIdle: () => true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager,
		getAgentTaskHost: () => host,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		ui: { confirm: async () => true, notify() {} },
	} as unknown as ExtensionContext;
	intercomLightweight(intercomPi as never);
	registerSubagentExtension(subagentPi as unknown as ExtensionAPI);
	const fire = async <T>(handlers: Map<string, Handler[]>, eventName: string, event: object): Promise<T[]> => {
		const results: T[] = [];
		for (const handler of handlers.get(eventName) ?? []) results.push((await handler(event, ctx)) as T);
		return results;
	};
	return {
		ctx,
		events,
		appendEntry,
		async resume() {
			await fire(intercomHandlers, "session_start", { type: "session_start", reason: "resume" });
			await fire(subagentHandlers, "session_start", { type: "session_start", reason: "resume" });
			await fire(intercomHandlers, "session_recovery_restore", {
				type: "session_recovery_restore",
				reason: "resume",
			});
		},
		/** Subagents' own recovery hook, started without waiting so a send can race the restoration. */
		startSubagentRestoration: () =>
			fire<{ notices?: string[] } | undefined>(subagentHandlers, "session_recovery_restore", {
				type: "session_recovery_restore",
				reason: "resume",
			}),
		send(to: string, message: string): Promise<ToolResult> {
			const tool = tools.get("intercom");
			assert.ok(tool, "the intercom tool must be registered");
			return tool.execute("call", { action: "send", to, message }, undefined, undefined, ctx);
		},
		async shutdown() {
			await fire(intercomHandlers, "session_shutdown", { type: "session_shutdown", reason: "quit" });
			await fire(subagentHandlers, "session_shutdown", { type: "session_shutdown", reason: "quit" });
		},
	};
}

function taskHost(owner: string): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `${owner}-${randomUUID()}` },
		authorizeLaunch() {},
	});
}

async function launchInterruptedChild(cwd: string, sessionManager: SessionManager, runId: string) {
	const host = taskHost("parent-before-restart");
	const neverReleased = Promise.withResolvers<void>();
	const pi = {
		appendEntry: async (customType: string, data?: unknown) => {
			await sessionManager.appendCustomEntry(customType, data);
		},
	};
	const response = await runAgentTask({
		host,
		cwd,
		agents: [worker],
		agent: "worker",
		task: "original task",
		options: {
			cwd,
			runId,
			index: 0,
			sessionDir: join(cwd, "children", runId),
			intercomSessionName: `subagent-worker-${runId}-1`,
			intercomGroup: "default",
			orchestratorIntercomTarget: "send-parent",
		},
		wait: { kind: "background" },
		recordChild: createSubagentChildRecordSink(pi, { sessionManager, orchestrationContext: undefined }),
		runtime: {
			runSync: (...args) =>
				runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: { output: "never", promptGate: neverReleased.promise, abortResolvesPrompt: true },
				}),
		},
	});
	assert.equal(response.kind, "admitted");
	const deadline = Date.now() + RECORD_WAIT_MS;
	let running: SubagentChildRecord | undefined;
	while (!running && Date.now() < deadline) {
		running = readSubagentChildRecords(sessionManager.getEntries()).get(`${runId}:0`);
		if (running?.state !== "running") {
			running = undefined;
			await sleep(10);
		}
	}
	assert.ok(running, "the interrupted child must be recorded running");
	await host.close("session-close");
	return running;
}

const text = (result: ToolResult): string => result.content.map((part) => part.text).join("\n");

/** Restoration dependencies that relaunch the child in-process and record each relaunch's options. */
function restoreDeps(parent: ReturnType<typeof resumedSession>, launched: RunSyncOptions[]): SubagentChildRestoreDeps {
	return {
		pi: {
			events: parent.events,
			appendEntry: parent.appendEntry,
			getSessionName: () => "send-parent",
		} as never,
		config: {},
		discoverAgents: () => ({ agents: [worker] }),
		runtime: {
			runSync: (...args) => {
				launched.push(args[4]);
				return runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: { output: "resumed" },
				});
			},
		},
	};
}

/** Re-register the relaunched child with the broker the way its own Intercom extension does. */
async function connectRestoredChild(
	name: string,
	capability: NonNullable<RunSyncOptions["supervisorAuthorization"]>,
	received: string[],
	client: InstanceType<typeof IntercomClient>,
): Promise<InstanceType<typeof IntercomClient>> {
	client.on("message", (_from: object, message: { content: { text: string } }) => received.push(message.content.text));
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		},
		{ capability: capability.capability, supervisorSessionId: capability.supervisorSessionId },
	);
	return client;
}

afterAll(() => {
	try {
		const pid = Number.parseInt(readFileSync(getBrokerPidPath(agentDir), "utf8").trim(), 10);
		if (Number.isFinite(pid) && pid > 0) process.kill(pid, "SIGKILL");
	} catch {
		// No broker was spawned, or it already exited.
	}
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test(
	"a send to a child that is still being restored waits and is delivered exactly once after it re-registers (#3760)",
	async () => {
		const cwd = makeTempDirectory("send-during-restore-live-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const childName = "subagent-worker-live1-1";
		const parent = resumedSession(cwd, sessionManager, resumedHost);
		let child: InstanceType<typeof IntercomClient> | undefined;
		try {
			await launchInterruptedChild(cwd, sessionManager, "live1");
			await parent.resume();

			const launched: RunSyncOptions[] = [];
			const deps = restoreDeps(parent, launched);
			// Restoration is now in progress: the child has been relaunched but has not re-registered with Intercom.
			const restoration = restoreSubagentChild(deps, parent.ctx, "live1:0");

			let settled = false;
			const sent = parent.send(childName, "continue after resume").finally(() => {
				settled = true;
			});
			await sleep(SETTLE_MS);
			assert.equal(
				settled,
				false,
				"the send must wait for the restoration instead of failing with Session not found",
			);

			const capability = launched[0]?.supervisorAuthorization;
			assert.ok(capability, "the relaunch must carry a fresh supervisor authorization");
			const received: string[] = [];
			child = await connectRestoredChild(
				childName,
				capability,
				received,
				new IntercomClient("restored-live1-session"),
			);

			const result = await sent;
			assert.equal(result.details.delivered, true, text(result));
			assert.equal((await restoration).kind, "restored");
			await sleep(SETTLE_MS);
			assert.deepEqual(received, ["continue after resume"], "the message is delivered once, not repeated");
		} finally {
			await child?.disconnect().catch(() => undefined);
			await parent.shutdown();
			await resumedHost.close("session-close");
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a send addressing a restoring child by its Atomic session id or its pre-restart Intercom id waits and is delivered once (#3760)",
	async () => {
		const cwd = makeTempDirectory("send-during-restore-ids-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const childName = "subagent-worker-ids1-1";
		const parent = resumedSession(cwd, sessionManager, resumedHost);
		let child: InstanceType<typeof IntercomClient> | undefined;
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "ids1");
			const childSessionId = original.childSessionId;
			assert.ok(childSessionId && original.childSessionFile, "the child's own session must be recorded");
			// Before the restart the child's Intercom extension recorded the id it registered under.
			const previousIntercomId = randomUUID();
			const childSession = await SessionManager.open(original.childSessionFile, undefined, cwd);
			await childSession.appendCustomEntry("intercom_session_identity", {
				sessionId: childSessionId,
				intercomSessionId: previousIntercomId,
			});
			await parent.resume();

			const launched: RunSyncOptions[] = [];
			const restoration = restoreSubagentChild(restoreDeps(parent, launched), parent.ctx, "ids1:0");

			const settled = new Set<string>();
			const byAtomicId = parent
				.send(childSessionId, "addressed by Atomic session id")
				.finally(() => settled.add("atomic"));
			const byIntercomId = parent
				.send(previousIntercomId, "addressed by previous Intercom id")
				.finally(() => settled.add("intercom"));
			await sleep(SETTLE_MS);
			assert.deepEqual(
				[...settled],
				[],
				"sends by either id must wait for the restoration instead of failing with Session not found",
			);

			const capability = launched[0]?.supervisorAuthorization;
			assert.ok(capability, "the relaunch must carry a fresh supervisor authorization");
			const received: string[] = [];
			child = await connectRestoredChild(
				childName,
				capability,
				received,
				new IntercomClient(childSessionId, { preferredSessionId: previousIntercomId }),
			);
			assert.equal(child.sessionId, previousIntercomId, "the restored child reclaims its pre-restart Intercom id");

			for (const result of await Promise.all([byAtomicId, byIntercomId]))
				assert.equal(result.details.delivered, true, text(result));
			assert.equal((await restoration).kind, "restored");
			await sleep(SETTLE_MS);
			assert.deepEqual(
				received.sort(),
				["addressed by Atomic session id", "addressed by previous Intercom id"],
				"each message is delivered once, not repeated",
			);
		} finally {
			await child?.disconnect().catch(() => undefined);
			await parent.shutdown();
			await resumedHost.close("session-close");
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a send to a child that did not survive the restart is told it is gone, not Session not found (#3760)",
	async () => {
		const cwd = makeTempDirectory("send-during-restore-gone-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const childName = "subagent-worker-gone1-1";
		const parent = resumedSession(cwd, sessionManager, resumedHost);
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "gone1");
			rmSync(original.childSessionFile!, { force: true });
			await parent.resume();

			// The sends race the restoration, which finds the child's session missing.
			const restoration = parent.startSubagentRestoration();
			const [duringRestore, byAtomicIdDuringRestore] = await Promise.all([
				parent.send(childName, "are you there?"),
				parent.send(original.childSessionId!, "are you there, by session id?"),
			]);
			for (const result of [duringRestore, byAtomicIdDuringRestore]) {
				assert.equal(result.details.delivered, false);
				assert.equal(result.isError, true);
				assert.match(text(result), /did not survive the restart and is gone/);
				assert.doesNotMatch(text(result), /Session not found/);
			}

			await restoration;
			const afterRecord = readSubagentChildRecords(sessionManager.getEntries()).get("gone1:0");
			assert.equal(afterRecord?.terminalStatus, "gone", "the gone child is recorded so later resumes know it");

			for (const target of [childName, original.childSessionId!]) {
				const laterSend = await parent.send(target, "anyone?");
				assert.match(text(laterSend), /did not survive the restart and is gone/, target);
				assert.doesNotMatch(text(laterSend), /Session not found/, target);
			}

			const unrelated = await parent.send("subagent-worker-never-existed-1", "hello");
			assert.match(
				text(unrelated),
				/Session not found/,
				"names that were never this session's children are unaffected",
			);
		} finally {
			await parent.shutdown();
			await resumedHost.close("session-close");
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
