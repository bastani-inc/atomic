import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
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
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "restore-hold-")));
brokerFixture.overrideAgentDir();
// Intercom's broker paths are snapshotted at import time, so import after the agent dir override.
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

type Client = InstanceType<typeof IntercomClient>;
type Supervisor = { capability: string; supervisorSessionId: string };

/** Spawning the broker child is the structural cost of this real-broker suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const RECORD_WAIT_MS = 5_000;
const SETTLE_MS = 400;
const SUPERVISOR_AUTHORIZATION_EVENT = "subagent:supervisor-authorization";

type Handler = (event: object, ctx: object) => unknown;
type EventHandler = (payload: unknown) => void;

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

function taskHost(owner: string): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `${owner}-${randomUUID()}` },
		authorizeLaunch() {},
	});
}

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

/** The real Intercom extension of a resumed parent session, on the event bus its subagent restoration uses. */
function resumedParent(name: string, cwd: string, sessionManager: SessionManager, host: AgentTaskHost) {
	const events = eventBus();
	const handlers = new Map<string, Handler[]>();
	let activeTools: string[] = [];
	const appendEntry = async (customType: string, data?: unknown) => {
		await sessionManager.appendCustomEntry(customType, data);
	};
	intercomLightweight({
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry,
		async sendMessage() {},
		async sendMessages() {},
		getSessionName: () => name,
		setSessionName() {},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events,
	} as never);
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
	const fire = async (eventName: string, event: object): Promise<void> => {
		for (const handler of handlers.get(eventName) ?? []) await handler(event, ctx);
	};
	return {
		ctx,
		async resume(): Promise<void> {
			await fire("session_start", { type: "session_start", reason: "resume" });
			await fire("session_recovery_restore", { type: "session_recovery_restore", reason: "resume" });
		},
		/** A broker capability for another child of this parent, as a fresh launch would get. */
		authorize(childName: string): Promise<Supervisor> {
			const request: { childName: string; completion?: Promise<Supervisor> } = { childName };
			events.emit(SUPERVISOR_AUTHORIZATION_EVENT, request);
			assert.ok(request.completion, "Intercom must answer the supervisor authorization request");
			return request.completion;
		},
		/** Restoration that relaunches the child in-process; the relaunched child keeps running until its host closes. */
		restoreDeps(launched: RunSyncOptions[]): SubagentChildRestoreDeps {
			return {
				pi: { events, appendEntry, getSessionName: () => name } as never,
				config: {},
				discoverAgents: () => ({ agents: [worker] }),
				runtime: {
					runSync: (...args) => {
						launched.push(args[4]);
						return runSync(args[0], args[1], args[2], args[3], {
							...args[4],
							testSession: { output: "never", promptGate: new Promise(() => {}), abortResolvesPrompt: true },
						});
					},
				},
			};
		},
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

/** A background child launched before the restart, recorded running in its parent's session. */
async function launchInterruptedChild(cwd: string, sessionManager: SessionManager, runId: string) {
	const host = taskHost("parent-before-restart");
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
		},
		wait: { kind: "background" },
		recordChild: createSubagentChildRecordSink(
			{
				appendEntry: async (customType: string, data?: unknown) => {
					await sessionManager.appendCustomEntry(customType, data);
				},
			},
			{ sessionManager, orchestrationContext: undefined },
		),
		runtime: {
			runSync: (...args) =>
				runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: { output: "never", promptGate: new Promise(() => {}), abortResolvesPrompt: true },
				}),
		},
	});
	assert.equal(response.kind, "admitted");
	let running: SubagentChildRecord | undefined;
	await vi.waitFor(
		() => {
			running = readSubagentChildRecords(sessionManager.getEntries()).get(`${runId}:0`);
			assert.equal(running?.state, "running");
			assert.ok(running?.childSessionFile, "its own session is recorded once it starts");
		},
		{ timeout: RECORD_WAIT_MS, interval: 10 },
	);
	await host.close("session-close");
	assert.ok(running?.intercomTarget && running.childSessionId && running.childSessionFile);
	return { ...running, intercomTarget: running.intercomTarget, childSessionId: running.childSessionId };
}

/** A plain Intercom peer in the default group with no session runtime of its own. */
async function peer(
	name: string,
	options: { supervisor?: Supervisor; ownerToken?: string; returnAddress?: string; preferredSessionId?: string } = {},
): Promise<Client> {
	const client = new IntercomClient(
		options.returnAddress ?? randomUUID(),
		options.preferredSessionId === undefined ? {} : { preferredSessionId: options.preferredSessionId },
	);
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
		options.supervisor,
		options.ownerToken,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

function settledLabels() {
	const settled: string[] = [];
	return {
		settled,
		track<T>(label: string, promise: Promise<T>): Promise<T> {
			return promise.finally(() => settled.push(label));
		},
	};
}

let broker: ChildProcess | undefined;

beforeAll(async () => {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await vi.waitFor(
		async () => {
			brokerFixture.assertRunning();
			const connected = await new Promise<boolean>((resolveConnected) => {
				const socket = net.createConnection(getBrokerSocketPath(process.platform, brokerFixture.agentDir));
				socket.once("connect", () => {
					socket.destroy();
					resolveConnected(true);
				});
				socket.once("error", () => resolveConnected(false));
			});
			assert.ok(connected);
		},
		{ timeout: 10_000, interval: 20 },
	);
});
afterAll(() => brokerFixture.cleanup());

test(
	"sends from a third party and a sibling to a restoring subagent, by name, Atomic session id or pre-restart Intercom id, are delivered exactly once after it re-registers (#3760)",
	async () => {
		const cwd = makeTempDirectory("restore-hold-live-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const parent = resumedParent("hold-parent", cwd, sessionManager, resumedHost);
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "hold1");
			const childName = original.intercomTarget;
			const childSessionId = original.childSessionId;
			// Before the restart the child's Intercom extension recorded the id it registered under.
			const previousIntercomId = randomUUID();
			const childSession = await SessionManager.open(original.childSessionFile!, undefined, cwd);
			await childSession.appendCustomEntry("intercom_session_identity", {
				sessionId: childSessionId,
				intercomSessionId: previousIntercomId,
			});
			await parent.resume();
			const thirdParty = await peer("hold-third-party");
			const replies: string[] = [];
			thirdParty.on("message", (_from: object, message: { replyTo?: string; content: { text: string } }) => {
				if (message.replyTo) replies.push(message.content.text);
			});
			const sibling = await peer("subagent-worker-hold1-2", {
				supervisor: await parent.authorize("subagent-worker-hold1-2"),
			});

			const launched: RunSyncOptions[] = [];
			const restoration = restoreSubagentChild(parent.restoreDeps(launched), parent.ctx, "hold1:0");
			// Observed from the start: if an assertion fails before the awaits below, cleanup disconnects the clients and
			// these operations reject; unobserved, that rejection escapes and is credited to a later test.
			void Promise.allSettled([restoration]);
			// Relaunched, but not yet re-registered with Intercom.
			await vi.waitFor(() => assert.equal(launched.length, 1), { timeout: 10_000, interval: 10 });

			const { settled, track } = settledLabels();
			const sends = [
				track("third-name", thirdParty.send(childName, { text: "THIRD-1-BY-NAME" })),
				track("third-atomic", thirdParty.send(childSessionId, { text: "THIRD-2-BY-ATOMIC-ID" })),
				track("third-previous", thirdParty.send(previousIntercomId, { text: "THIRD-3-BY-PREVIOUS-ID" })),
				track("third-ask", thirdParty.send(childName, { text: "THIRD-4-ASK", expectsReply: true })),
				track("sibling-name", sibling.send(childName, { text: "SIBLING-1-BY-NAME" })),
				track("sibling-atomic", sibling.send(childSessionId, { text: "SIBLING-2-BY-ATOMIC-ID" })),
				track("sibling-previous", sibling.send(previousIntercomId, { text: "SIBLING-3-BY-PREVIOUS-ID" })),
			];
			void Promise.allSettled(sends);
			await sleep(SETTLE_MS);
			assert.deepEqual(settled, [], "every send waits for the subagent instead of failing with Session not found");

			const capability = launched[0]?.supervisorAuthorization;
			assert.ok(capability, "the relaunch carries the capability the hold was made under");
			const received: string[] = [];
			const child = new IntercomClient(childSessionId, { preferredSessionId: previousIntercomId });
			child.on(
				"message",
				(from: { id: string }, message: { id: string; expectsReply?: boolean; content: { text: string } }) => {
					received.push(message.content.text);
					if (message.expectsReply) void child.send(from.id, { text: "PONG", replyTo: message.id });
				},
			);
			brokerFixture.onCleanup(() => child.disconnect().catch(() => undefined));
			await child.connect(
				{
					name: childName,
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
			assert.equal(child.sessionId, previousIntercomId, "the restored child reclaims its pre-restart Intercom id");

			for (const result of await Promise.all(sends)) assert.equal(result.delivered, true, result.reason);
			assert.equal((await restoration).kind, "restored");
			await sleep(SETTLE_MS);
			assert.deepEqual(
				received.filter((text) => text.startsWith("THIRD-")),
				["THIRD-1-BY-NAME", "THIRD-2-BY-ATOMIC-ID", "THIRD-3-BY-PREVIOUS-ID", "THIRD-4-ASK"],
				"a third party's held messages arrive once each, in the order it sent them",
			);
			assert.deepEqual(
				received.filter((text) => text.startsWith("SIBLING-")),
				["SIBLING-1-BY-NAME", "SIBLING-2-BY-ATOMIC-ID", "SIBLING-3-BY-PREVIOUS-ID"],
				"a sibling's held messages arrive once each, in the order it sent them",
			);
			assert.equal(received.length, 7, "nothing is delivered twice");
			assert.deepEqual(replies, ["PONG"], "a held ask is answered through its normal reply route");
		} finally {
			await resumedHost.close("session-close");
			await parent.shutdown();
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a third party sending to a subagent that did not survive the restart gets the explicit gone error, not Session not found (#3760)",
	async () => {
		const cwd = makeTempDirectory("restore-hold-gone-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const parent = resumedParent("gone-parent", cwd, sessionManager, resumedHost);
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "gone2");
			rmSync(original.childSessionFile!, { force: true });
			await parent.resume();
			const thirdParty = await peer("gone-third-party");

			const outcome = await restoreSubagentChild(parent.restoreDeps([]), parent.ctx, "gone2:0");
			assert.equal(outcome.kind, "unrestorable");
			for (const target of [original.intercomTarget, original.childSessionId]) {
				const result = await thirdParty.send(target, { text: "are you there?" });
				assert.equal(result.delivered, false, target);
				assert.match(result.reason ?? "", /did not survive the restart and is gone/, target);
				assert.doesNotMatch(result.reason ?? "", /Session not found/, target);
			}
			const unrelated = await thirdParty.send("subagent-worker-never-existed-1", { text: "hello" });
			assert.equal(unrelated.reason, "Session not found", "names that were never restored are unaffected");
		} finally {
			await resumedHost.close("session-close");
			await parent.shutdown();
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a send held for a restoring subagent gets the explicit gone error once its owner reports it gone (#3760)",
	async () => {
		const owner = await peer("held-gone-owner", { ownerToken: randomUUID() });
		const childName = "subagent-worker-gone3-1";
		const { capability } = await owner.authorizeSupervisorChild(childName);
		await owner.reserveRestoringRecipient(capability);
		const thirdParty = await peer("held-gone-third-party");

		const { settled, track } = settledLabels();
		const held = track("held", thirdParty.send(childName, { text: "still there?" }));
		await sleep(SETTLE_MS);
		assert.deepEqual(settled, [], "the send is held while the subagent is being restored");

		await owner.releaseRestoringRecipient(capability, "its session file was deleted");
		const result = await held;
		assert.equal(result.delivered, false);
		assert.match(
			result.reason ?? "",
			/`subagent-worker-gone3-1` did not survive the restart and is gone: its session file was deleted/,
		);
		const later = await thirdParty.send(childName, { text: "and now?" });
		assert.match(
			later.reason ?? "",
			/did not survive the restart and is gone/,
			"the gone marker stays while its owner is connected",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"only the supervisor a subagent's capability was issued to can hold sends for it (#3760)",
	async () => {
		const owner = await peer("victim-owner", { ownerToken: randomUUID() });
		const victim = "subagent-worker-victim-1";
		const { capability } = await owner.authorizeSupervisorChild(victim);

		const intruder = await peer("intruder-owner", { ownerToken: randomUUID() });
		await assert.rejects(
			intruder.reserveRestoringRecipient(capability),
			/Only the supervisor authorized for this subagent/,
		);
		const unprivileged = await peer("unprivileged");
		await assert.rejects(unprivileged.reserveRestoringRecipient(capability), /Only the supervisor authorized/);
		await assert.rejects(
			unprivileged.reserveRestoringRecipient("forged.capability"),
			/Only the supervisor authorized/,
		);
		// A supervisor's own capability names only its own child; extra targets must be session ids, never names.
		const { capability: own } = await intruder.authorizeSupervisorChild("subagent-worker-intruder-1");
		await assert.rejects(
			intruder.reserveRestoringRecipient(own, { aliases: [victim] }),
			/only under its name and session ids/,
		);

		const thirdParty = await peer("victim-third-party");
		const startedAt = Date.now();
		const result = await thirdParty.send(victim, { text: "hello" });
		assert.equal(result.reason, "Session not found", "no refused reservation holds the victim's name");
		assert.ok(Date.now() - startedAt < 5_000, "the send was answered at once, not held");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"when the owner disconnects, its reservation ends and held sends are answered at once (#3760)",
	async () => {
		const owner = await peer("orphan-owner", { ownerToken: randomUUID() });
		const childName = "subagent-worker-orphan-1";
		const { capability } = await owner.authorizeSupervisorChild(childName);
		await owner.reserveRestoringRecipient(capability);
		const thirdParty = await peer("orphan-third-party");

		const { settled, track } = settledLabels();
		const held = track("held", thirdParty.send(childName, { text: "hello?" }));
		await sleep(SETTLE_MS);
		assert.deepEqual(settled, [], "the send is held while the owner restores its subagent");

		const disconnectedAt = Date.now();
		await owner.disconnect();
		const result = await held;
		assert.equal(result.reason, "Session not found", "nothing restores the subagent once its owner is gone");
		assert.ok(Date.now() - disconnectedAt < 5_000, "the held send does not wait out the hold timeout");
		const later = await thirdParty.send(childName, { text: "anyone?" });
		assert.equal(later.reason, "Session not found", "the reservation does not outlive its owner");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
