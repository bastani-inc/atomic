import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	restoreSubagentChild,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	subagentChildRestoreNotices,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { resumedSession, type Supervisor, worker } from "../helpers/resumed-session-harness.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "early-restore-hold-")));
brokerFixture.overrideAgentDir();
// Intercom's broker paths are snapshotted at import time, so import after the agent dir override.
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

type Client = InstanceType<typeof IntercomClient>;
type SendResult = Awaited<ReturnType<Client["send"]>>;

/** Spawning the broker child is the structural cost of this real-broker suite. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const RECORD_WAIT_MS = 5_000;
const SETTLE_MS = 400;
/** A send answered by the broker settles within milliseconds; one it holds does not settle within this. */
const HELD_PROBE_MS = 150;
const HOLD_IN_PLACE_MS = 5_000;

function taskHost(owner: string): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `${owner}-${randomUUID()}` },
		authorizeLaunch() {},
	});
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
		},
		{ timeout: RECORD_WAIT_MS, interval: 10 },
	);
	await host.close("session-close");
	assert.ok(running?.intercomTarget && running.childSessionId && running.childSessionFile);
	// Before the restart the child's Intercom extension recorded the id it registered under.
	const previousIntercomId = randomUUID();
	const childSession = await SessionManager.open(running.childSessionFile, undefined, cwd);
	await childSession.appendCustomEntry("intercom_session_identity", {
		sessionId: running.childSessionId,
		intercomSessionId: previousIntercomId,
	});
	return {
		...running,
		intercomTarget: running.intercomTarget,
		childSessionId: running.childSessionId,
		previousIntercomId,
	};
}

/** A plain Intercom peer in the default group with no session runtime of its own. */
async function peer(
	name: string,
	options: { supervisor?: Supervisor; ownerToken?: string; preferredSessionId?: string } = {},
): Promise<Client> {
	const client = new IntercomClient(
		randomUUID(),
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

/**
 * Send until the broker holds the message instead of answering at once, so a test learns when the owner's hold is in
 * place without any access to its internals. Resolves with the held send's outcome and how long the hold took to appear.
 */
async function sendUntilHeld(client: Client, target: string, text: string) {
	const startedAt = Date.now();
	for (;;) {
		const attempt = client.send(target, { text });
		const settled = await Promise.race([attempt, sleep(HELD_PROBE_MS).then(() => undefined)]);
		if (settled === undefined) return { outcome: attempt, heldAfterMs: Date.now() - startedAt };
		assert.equal(settled.reason, "Session not found", `unexpected answer to ${target}: ${settled.reason}`);
		assert.ok(Date.now() - startedAt < HOLD_IN_PLACE_MS, `${target} was never held`);
	}
}

/** The restored child registering with the broker under the supervisor capability it was relaunched with. */
async function registerRestoredChild(
	name: string,
	childSessionId: string,
	previousIntercomId: string,
	capability: Supervisor,
	received: string[],
): Promise<Client> {
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
	return child;
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

function resumedParent(name: string, cwd: string, sessionManager: SessionManager, host: AgentTaskHost) {
	return resumedSession({
		name,
		cwd,
		sessionManager,
		host,
		extensions: [(pi) => registerSubagentExtension(pi)],
		intercom: intercomLightweight,
	});
}

test(
	"sends to an interrupted subagent right after its owner's session starts, before recovery has reserved it, are held and delivered once after it re-registers (#3760)",
	async () => {
		const cwd = makeTempDirectory("early-hold-live-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const parent = resumedParent("early-parent", cwd, sessionManager, resumedHost);
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "early1");
			const childName = original.intercomTarget;
			const { childSessionId, previousIntercomId } = original;
			// The session starts. Recovery, which restores and reserves the child, has not run.
			await parent.start();
			const thirdParty = await peer("early-third-party");
			const replies: string[] = [];
			thirdParty.on("message", (_from: object, message: { replyTo?: string; content: { text: string } }) => {
				if (message.replyTo) replies.push(message.content.text);
			});

			const held = [
				await sendUntilHeld(thirdParty, childName, "EARLY-1-BY-NAME"),
				await sendUntilHeld(thirdParty, childSessionId, "EARLY-2-BY-ATOMIC-ID"),
				// Its pre-restart Intercom id is read from the child's own session once the hold is in place.
				await sendUntilHeld(thirdParty, previousIntercomId, "EARLY-3-BY-PREVIOUS-ID"),
			];
			assert.ok(
				held[0]!.heldAfterMs < HOLD_IN_PLACE_MS,
				`the owner held the child from session start, not only once recovery restored it (${held[0]!.heldAfterMs} ms)`,
			);
			const ask = thirdParty.send(childName, { text: "EARLY-4-ASK", expectsReply: true });
			const settled: string[] = [];
			const outcomes = [...held.map((entry) => entry.outcome), ask].map((outcome, index) =>
				outcome.finally(() => settled.push(String(index))),
			);
			await sleep(SETTLE_MS);
			assert.deepEqual(settled, [], "every send waits for the subagent instead of failing with Session not found");

			// Recovery restores the child; it takes over the hold the session already had.
			const launched: RunSyncOptions[] = [];
			const restoration = restoreSubagentChild(parent.restoreDeps(launched), parent.ctx, "early1:0");
			await vi.waitFor(() => assert.equal(launched.length, 1), { timeout: 10_000, interval: 10 });
			assert.deepEqual(settled, [], "nothing is released while the child is relaunching");
			const capability = launched[0]?.supervisorAuthorization;
			assert.ok(capability);
			const received: string[] = [];
			const child = await registerRestoredChild(childName, childSessionId, previousIntercomId, capability, received);
			assert.equal(child.sessionId, previousIntercomId, "the restored child reclaims its pre-restart Intercom id");

			for (const result of (await Promise.all(outcomes)) as SendResult[])
				assert.equal(result.delivered, true, result.reason);
			assert.equal((await restoration).kind, "restored");
			await sleep(SETTLE_MS);
			assert.deepEqual(
				received,
				["EARLY-1-BY-NAME", "EARLY-2-BY-ATOMIC-ID", "EARLY-3-BY-PREVIOUS-ID", "EARLY-4-ASK"],
				"each message sent before recovery arrives once, in the order it was sent",
			);
			assert.deepEqual(replies, ["PONG"], "a held ask is answered through its normal reply route");

			const live = await thirdParty.send(childName, { text: "AFTER-LIVE" });
			assert.equal(live.delivered, true, live.reason);
			await sleep(SETTLE_MS);
			assert.equal(received.at(-1), "AFTER-LIVE");
			assert.equal(received.length, 5, "nothing is delivered twice");
		} finally {
			await resumedHost.close("session-close");
			await parent.shutdown();
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a send held since session start gets the explicit gone error once recovery finds the subagent cannot be restored (#3760)",
	async () => {
		const cwd = makeTempDirectory("early-hold-gone-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const parent = resumedParent("early-gone-parent", cwd, sessionManager, resumedHost);
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "early2");
			rmSync(original.childSessionFile!, { force: true });
			await parent.start();
			const thirdParty = await peer("early-gone-third-party");
			const held = await sendUntilHeld(thirdParty, original.intercomTarget, "ARE-YOU-THERE");

			const outcome = await restoreSubagentChild(parent.restoreDeps([]), parent.ctx, "early2:0");
			assert.equal(outcome.kind, "unrestorable");
			const result = await held.outcome;
			assert.equal(result.delivered, false);
			assert.match(result.reason ?? "", /did not survive the restart and is gone/);
			assert.doesNotMatch(result.reason ?? "", /Session not found/);
			for (const target of [original.intercomTarget, original.childSessionId]) {
				const later = await thirdParty.send(target, { text: "and now?" });
				assert.match(later.reason ?? "", /did not survive the restart and is gone/, target);
			}
			const unrelated = await thirdParty.send("subagent-worker-never-existed-1", { text: "hello" });
			assert.equal(unrelated.reason, "Session not found", "names that were never held are unaffected");
		} finally {
			await resumedHost.close("session-close");
			await parent.shutdown();
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a hold taken at session start ends with its session: held sends are answered at once and nothing keeps the name (#3760)",
	async () => {
		const cwd = makeTempDirectory("early-hold-shutdown-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const parent = resumedParent("early-shutdown-parent", cwd, sessionManager, resumedHost);
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "early3");
			await parent.start();
			const thirdParty = await peer("early-shutdown-third-party");
			const held = await sendUntilHeld(thirdParty, original.intercomTarget, "WAITING");

			const endedAt = Date.now();
			await parent.shutdown();
			const result = await held.outcome;
			assert.equal(result.reason, "Session not found", "nothing will restore the subagent once its owner is gone");
			assert.ok(Date.now() - endedAt < 5_000, "the held send does not wait out the hold timeout");
			await sleep(SETTLE_MS);
			const later = await thirdParty.send(original.intercomTarget, { text: "anyone?" });
			assert.equal(later.reason, "Session not found", "the hold does not outlive its session");
		} finally {
			await resumedHost.close("session-close");
			await parent.shutdown();
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a dormant hold is taken over by the supervisor that restores the child, delivering every send held before, during and after the handover once (#3760)",
	async () => {
		const childName = "subagent-worker-handover-1";
		const childSessionId = randomUUID();
		const previousIntercomId = randomUUID();
		const dormantOwner = await peer("handover-launching-session", { ownerToken: randomUUID() });
		const stage = await peer("handover-resumed-stage", { ownerToken: randomUUID() });
		const dormant = await dormantOwner.authorizeSupervisorChild(childName);
		await dormantOwner.reserveRestoringRecipient(dormant.capability, {
			group: "default",
			aliases: [childSessionId, previousIntercomId],
			dormant: true,
		});
		const thirdParty = await peer("handover-third-party");

		const before = [
			await sendUntilHeld(thirdParty, childName, "BEFORE-1-BY-NAME"),
			await sendUntilHeld(thirdParty, childSessionId, "BEFORE-2-BY-ATOMIC-ID"),
		];
		// The resumed stage restores the child under a capability of its own and reserves it.
		const fresh = await stage.authorizeSupervisorChild(childName);
		await stage.reserveRestoringRecipient(fresh.capability, { group: "default", aliases: [childSessionId] });
		const after = [await sendUntilHeld(thirdParty, previousIntercomId, "AFTER-3-BY-PREVIOUS-ID")];
		// The dormant owner letting go afterwards changes nothing for the stage's hold.
		await dormantOwner.releaseRestoringRecipient(dormant.capability);
		await sleep(SETTLE_MS);
		const settled: string[] = [];
		const outcomes = [...before, ...after].map((entry, index) =>
			entry.outcome.finally(() => settled.push(String(index))),
		);
		await sleep(SETTLE_MS);
		assert.deepEqual(settled, [], "the handover released nothing");

		const received: string[] = [];
		await registerRestoredChild(childName, childSessionId, previousIntercomId, fresh, received);
		for (const result of await Promise.all(outcomes)) assert.equal(result.delivered, true, result.reason);
		await sleep(SETTLE_MS);
		assert.deepEqual(received, ["BEFORE-1-BY-NAME", "BEFORE-2-BY-ATOMIC-ID", "AFTER-3-BY-PREVIOUS-ID"]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a live hold is not taken over by another supervisor of the same name, and a non-supervisor cannot make a dormant hold (#3760)",
	async () => {
		const childName = "subagent-worker-rival-1";
		const owner = await peer("rival-owner", { ownerToken: randomUUID() });
		const rival = await peer("rival-supervisor", { ownerToken: randomUUID() });
		const unprivileged = await peer("rival-unprivileged");
		const live = await owner.authorizeSupervisorChild(childName);
		await owner.reserveRestoringRecipient(live.capability, { group: "default" });
		const thirdParty = await peer("rival-third-party");
		const held = await sendUntilHeld(thirdParty, childName, "FOR-THE-OWNER");

		const takeover = await rival.authorizeSupervisorChild(childName);
		await rival.reserveRestoringRecipient(takeover.capability, { group: "default" });
		await sleep(SETTLE_MS);
		const received: string[] = [];
		await registerRestoredChild(childName, randomUUID(), randomUUID(), live, received);
		assert.equal((await held.outcome).delivered, true);
		await sleep(SETTLE_MS);
		assert.deepEqual(received, ["FOR-THE-OWNER"], "the rival's reservation took nothing from the live owner's");

		await assert.rejects(
			unprivileged.reserveRestoringRecipient(live.capability, { group: "default", dormant: true }),
			/Only the supervisor authorized for this subagent/,
		);
		await assert.rejects(
			unprivileged.reserveRestoringRecipient("forged.capability", { dormant: true }),
			/Only the supervisor authorized/,
		);
		const fresh = await thirdParty.send("subagent-worker-unprivileged-1", { text: "hello" });
		assert.equal(fresh.reason, "Session not found", "a refused dormant hold holds nothing");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"ending a dormant hold with a refusal tells the senders held now why, and later sends are routed normally (#3760)",
	async () => {
		const childName = "subagent-worker-refused-1";
		const owner = await peer("refusal-owner", { ownerToken: randomUUID() });
		const { capability } = await owner.authorizeSupervisorChild(childName);
		await owner.reserveRestoringRecipient(capability, { group: "default", dormant: true });
		const thirdParty = await peer("refusal-third-party");
		const held = await sendUntilHeld(thirdParty, childName, "WAITING");

		await owner.releaseRestoringRecipient(capability, {
			refusal: "Workflow run 1 was resumed in another Atomic session; send to it again there",
		});
		const result = await held.outcome;
		assert.equal(result.delivered, false);
		assert.match(result.reason ?? "", /was resumed in another Atomic session; send to it again there/);
		assert.doesNotMatch(result.reason ?? "", /did not survive the restart/);
		const later = await thirdParty.send(childName, { text: "again" });
		assert.equal(
			later.reason,
			"Session not found",
			"the child may come back elsewhere: no gone marker is left behind",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a dormant hold that no restoring supervisor took over ends when the child registers, delivering what it held once (#3760)",
	async () => {
		const childName = "subagent-worker-orphan-dormant-1";
		const childSessionId = randomUUID();
		const dormantOwner = await peer("orphan-launching-session", { ownerToken: randomUUID() });
		const stage = await peer("orphan-resumed-stage", { ownerToken: randomUUID() });
		const dormant = await dormantOwner.authorizeSupervisorChild(childName);
		await dormantOwner.reserveRestoringRecipient(dormant.capability, {
			group: "default",
			aliases: [childSessionId],
			dormant: true,
		});
		const thirdParty = await peer("orphan-third-party");
		const held = await sendUntilHeld(thirdParty, childName, "HELD-FOR-THE-STAGE");

		// The stage relaunches the child under its own capability without ever reserving it.
		const fresh = await stage.authorizeSupervisorChild(childName);
		const received: string[] = [];
		await registerRestoredChild(childName, childSessionId, randomUUID(), fresh, received);
		assert.equal((await held.outcome).delivered, true);
		await sleep(SETTLE_MS);
		assert.deepEqual(received, ["HELD-FOR-THE-STAGE"]);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a relaunched subagent that has not re-registered keeps its interrupted cards deferred and is neither called gone nor told to launch afresh (#3760)",
	async () => {
		const cwd = makeTempDirectory("early-hold-pending-peer-");
		const resumedHost = taskHost("parent-after-restart");
		const sessionManager = SessionManager.inMemory(cwd);
		const parent = resumedParent("pending-peer-parent", cwd, sessionManager, resumedHost);
		try {
			const original = await launchInterruptedChild(cwd, sessionManager, "pending1");
			await parent.start();
			// The relaunched child does not register with Intercom within the wait.
			const emit = parent.events.emit.bind(parent.events);
			parent.events.emit = (eventName: string, payload: unknown) => {
				if (eventName === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT) {
					(payload as { completion?: Promise<boolean> }).completion = Promise.resolve(false);
					return;
				}
				emit(eventName, payload);
			};
			const outcome = await restoreSubagentChild(parent.restoreDeps([]), parent.ctx, "pending1:0");
			assert.equal(outcome.kind, "restored");
			assert.equal(outcome.kind === "restored" && outcome.intercomLive, false);
			const [restoreNotice] = subagentChildRestoreNotices([outcome]);
			assert.match(restoreNotice ?? "", /did not reconnect to Intercom.*unreachable until it reconnects/);

			// A delivery the child sent before the restart is waiting in the resumed session.
			const timestamp = Date.now();
			const card = {
				entryId: "card-from-child",
				customType: "intercom_message",
				content: "**From the child**\n\nprogress",
				details: {
					from: { id: original.previousIntercomId, name: original.intercomTarget },
					message: { id: "message-from-child", timestamp, content: { text: "progress" } },
					bodyText: "progress",
				},
				timestamp: new Date(timestamp).toISOString(),
				delivery: "steer",
			};
			const results = await parent.fire("session_recovery_replay", {
				type: "session_recovery_replay",
				reason: "resume",
				pending: [card],
			});
			const plan = results.find(Boolean) as { decisions?: unknown[]; notices?: string[] } | undefined;
			assert.deepEqual(plan?.decisions, [{ entryId: "card-from-child", action: "defer" }]);
			assert.equal(plan?.notices?.length, 1);
			assert.match(
				plan?.notices?.[0] ?? "",
				/was relaunched after the restart but has not reconnected to Intercom yet/,
			);
			assert.doesNotMatch(plan?.notices?.join("\n") ?? "", /is gone|launch a fresh subagent/);
		} finally {
			await resumedHost.close("session-close");
			await parent.shutdown();
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
