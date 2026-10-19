import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import { restoreSubagentChild } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { registerDormantRunIntercomRoutes } from "../../packages/workflows/src/extension/dormant-run-intercom.js";
import { registerPendingStageIntercomBridge } from "../../packages/workflows/src/extension/pending-stage-intercom.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { JournalTestBackend } from "../helpers/journal-backend.js";
import { resumedSession, type Supervisor, worker } from "../helpers/resumed-session-harness.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "dormant-subagent-hold-")));
brokerFixture.overrideAgentDir();
// Intercom's broker paths are snapshotted at import time, so import after the agent dir override.
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");

type Client = InstanceType<typeof IntercomClient>;

const REAL_BROKER_TEST_TIMEOUT_MS = 90_000;
const RECORD_WAIT_MS = 5_000;
const SETTLE_MS = 400;
const HELD_PROBE_MS = 150;
const HOLD_IN_PLACE_MS = 10_000;
const REVOKE_WAIT_MS = 10_000;

function taskHost(owner: string): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `${owner}-${randomUUID()}` },
		authorizeLaunch() {},
	});
}

interface InterruptedRun {
	readonly runId: string;
	readonly group: string;
	readonly store: MemorySessionStore;
	readonly stageSessionId: string;
	readonly child: SubagentChildRecord & { intercomTarget: string; childSessionId: string };
	readonly previousIntercomId: string;
	readonly backend: JournalTestBackend;
}

/**
 * A workflow run whose process died while its `lane` stage was running with a background subagent. The journal
 * names the lane stage's session, which records the subagent as running; a second stage's session was never saved.
 */
async function interruptedRun(cwd: string): Promise<InterruptedRun> {
	const runId = randomUUID();
	const group = `workflow:${runId}`;
	const store = new MemorySessionStore();
	const stageSession = await SessionManager.create(store, cwd);
	const host = taskHost("stage-before-restart");
	const response = await runAgentTask({
		host,
		cwd,
		agents: [worker],
		agent: "worker",
		task: "original task",
		options: {
			cwd,
			runId: "lane-run",
			index: 0,
			sessionDir: join(cwd, "children", "lane-run"),
			intercomSessionName: "subagent-worker-lane-run-1",
			intercomGroup: group,
		},
		wait: { kind: "background" },
		recordChild: createSubagentChildRecordSink(
			{
				appendEntry: async (customType: string, data?: unknown) => {
					await stageSession.appendCustomEntry(customType, data);
				},
			},
			{
				sessionManager: stageSession,
				orchestrationContext: {
					kind: "workflow-stage",
					workflowRunId: runId,
					workflowStageId: "lane-id",
					workflowStageName: "lane",
				} as never,
			},
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
			running = readSubagentChildRecords(stageSession.getEntries()).get("lane-run:0");
			assert.equal(running?.state, "running");
		},
		{ timeout: RECORD_WAIT_MS, interval: 10 },
	);
	await host.close("session-close");
	assert.ok(running?.intercomTarget && running.childSessionId && running.childSessionFile);
	assert.equal(running.owner.sessionId, stageSession.getSessionId());
	const previousIntercomId = randomUUID();
	await (await SessionManager.open(running.childSessionFile, undefined, cwd)).appendCustomEntry(
		"intercom_session_identity",
		{ sessionId: running.childSessionId, intercomSessionId: previousIntercomId },
	);

	const writer = await JournalTestBackend.create();
	await writer.commitWorkflowRegistration({
		workflowId: runId,
		name: "dormant-subagent-hold",
		inputs: {},
		createdAt: 1,
		status: "running",
		invocationCwd: repoRoot,
		resumable: true,
	});
	await writer.commitCheckpoint({
		kind: "tool",
		workflowId: runId,
		checkpointId: "tool:prep",
		name: "prep",
		argsHash: "prep",
		output: true,
		completedAt: 1,
		topology: {
			version: 1,
			nodeId: "tool:prep",
			ordinal: 1,
			order: 1,
			parentIds: [],
			run: { runId, runName: "dormant-subagent-hold" },
		},
	});
	for (const [name, stageId, sessionId, order] of [
		["lane", "lane-id", stageSession.getSessionId(), 1],
		["ghost", "ghost-id", `session-never-saved-${randomUUID()}`, 2],
	] as const) {
		await writer.commitCheckpoint({
			kind: "stage",
			workflowId: runId,
			checkpointId: `stage-session:${name}`,
			name,
			replayKey: `stage:${name}:1`,
			sessionId,
			startedAt: 1,
			durationMs: 1,
			completedAt: 1,
			topology: {
				version: 1,
				stageId,
				parentIds: ["tool:prep"],
				sourceOrder: order,
				status: "running",
				run: { runId, runName: "dormant-subagent-hold" },
			},
		});
	}
	return {
		runId,
		group,
		store,
		stageSessionId: stageSession.getSessionId(),
		child: {
			...running,
			intercomTarget: running.intercomTarget,
			childSessionId: running.childSessionId,
		},
		previousIntercomId,
		// The crashed process's lease is gone; the restarted launching session reopens the journal.
		backend: await writer.reopen(),
	};
}

/** The launching session after its restart: real workflows dormant routes, subagents and Intercom extensions. */
async function restartedLauncher(run: InterruptedRun) {
	const launcherSession = await SessionManager.create(run.store, repoRoot);
	await launcherSession.appendCustomEntry("workflow.run.start", {
		runId: run.runId,
		name: "dormant-subagent-hold",
		inputs: {},
		ts: 1,
	});
	const store = createStore();
	let dormant: ReturnType<typeof registerDormantRunIntercomRoutes> | undefined;
	let disposeBridge: (() => void) | undefined;
	const launcherHost = taskHost("launcher-after-restart");
	const launcher = resumedSession({
		name: "dormant-launcher",
		cwd: repoRoot,
		sessionManager: launcherSession,
		host: launcherHost,
		extensions: [
			(pi) => {
				disposeBridge = registerPendingStageIntercomBridge(pi as never, store);
				dormant = registerDormantRunIntercomRoutes(pi as never, store, {
					prepareBackend: async () => {
						await run.backend.hydrateResumableWorkflows();
						bindStoreDurableBackend(store, run.backend);
						return run.backend;
					},
				});
			},
			(pi) => registerSubagentExtension(pi),
		],
		intercom: intercomLightweight,
	});
	await launcher.start();
	assert.ok(dormant);
	await dormant.settled();
	return {
		launcher,
		async stop() {
			await launcherHost.close("session-close");
			await launcher.shutdown();
			disposeBridge?.();
			dormant?.dispose();
		},
	};
}

/** A plain Intercom peer; `group` is its registration group. */
async function peer(name: string, group: string, options: { ownerToken?: string } = {}): Promise<Client> {
	const client = new IntercomClient(randomUUID());
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group,
			groups: [group],
		},
		undefined,
		options.ownerToken,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return client;
}

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

async function registerRestoredChild(run: InterruptedRun, capability: Supervisor, received: string[]): Promise<Client> {
	const child = new IntercomClient(run.child.childSessionId, { preferredSessionId: run.previousIntercomId });
	child.on("message", (_from: object, message: { content: { text: string } }) => {
		received.push(message.content.text);
	});
	brokerFixture.onCleanup(() => child.disconnect().catch(() => undefined));
	await child.connect(
		{
			name: run.child.intercomTarget,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: run.group,
			groups: [run.group],
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

test(
	"sends to a stage's subagent while its workflow run waits for resume are held, then delivered once after the resumed stage restores it (#3760)",
	async () => {
		const cwd = makeTempDirectory("dormant-subagent-hold-");
		const stageHost = taskHost("stage-after-resume");
		try {
			const run = await interruptedRun(cwd);
			const launching = await restartedLauncher(run);
			try {
				const { intercomTarget: childName, childSessionId } = run.child;
				const thirdParty = await peer("dormant-third-party", run.group);

				// The run is down: only the launching session is up, and the subagent's own session is not running.
				// Its stage routes are queued in the journal, and its subagent's targets are held.
				const held = [
					await sendUntilHeld(thirdParty, childName, "DORMANT-1-BY-NAME"),
					await sendUntilHeld(thirdParty, childSessionId, "DORMANT-2-BY-ATOMIC-ID"),
					await sendUntilHeld(thirdParty, run.previousIntercomId, "DORMANT-3-BY-PREVIOUS-ID"),
				];
				const stageSend = await thirdParty.send(`${run.group}/lane`, { text: "FOR-THE-STAGE" });
				assert.equal(
					stageSend.queued,
					true,
					`the stage route itself still queues the send for the run, though one stage's records could not be read: ${stageSend.reason}`,
				);
				const settled: string[] = [];
				const outcomes = held.map((entry, index) => entry.outcome.finally(() => settled.push(String(index))));
				await sleep(SETTLE_MS);
				assert.deepEqual(settled, [], "every send to the subagent waits instead of failing with Session not found");

				// `/workflow resume` runs the lane stage again as its own session, which restores the subagent.
				const stageSession = await SessionManager.open(run.store, run.stageSessionId, cwd);
				const stage = resumedSession({
					name: "dormant-lane-stage",
					cwd,
					sessionManager: stageSession,
					host: stageHost,
					orchestrationContext: { intercomGroup: run.group },
					intercom: intercomLightweight,
				});
				await stage.start();
				const launched: RunSyncOptions[] = [];
				const restoration = restoreSubagentChild(stage.restoreDeps(launched), stage.ctx, "lane-run:0");
				await vi.waitFor(() => assert.equal(launched.length, 1), { timeout: 15_000, interval: 10 });
				const afterHandover = await sendUntilHeld(thirdParty, childName, "RESUMED-4-BY-NAME");
				assert.deepEqual(settled, [], "the handover released nothing");

				const capability = launched[0]?.supervisorAuthorization;
				assert.ok(capability);
				const received: string[] = [];
				const child = await registerRestoredChild(run, capability, received);
				assert.equal(child.sessionId, run.previousIntercomId);
				for (const result of await Promise.all([...outcomes, afterHandover.outcome]))
					assert.equal(result.delivered, true, result.reason);
				assert.equal((await restoration).kind, "restored");
				await sleep(SETTLE_MS);
				assert.deepEqual(
					received,
					["DORMANT-1-BY-NAME", "DORMANT-2-BY-ATOMIC-ID", "DORMANT-3-BY-PREVIOUS-ID", "RESUMED-4-BY-NAME"],
					"every message sent while the run was down or resuming arrives once, in order",
				);
				await stage.shutdown();
			} finally {
				await launching.stop();
			}
		} finally {
			await stageHost.close("session-close");
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"when another process resumes the run, held sends to its stage's subagent get the explicit resumed-elsewhere error and the hold ends (#3760)",
	async () => {
		const cwd = makeTempDirectory("dormant-subagent-revoke-");
		try {
			const run = await interruptedRun(cwd);
			const launching = await restartedLauncher(run);
			try {
				const thirdParty = await peer("revoke-third-party", run.group);
				const held = await sendUntilHeld(thirdParty, run.child.intercomTarget, "HELD-FOR-THE-RESUMED-RUN");

				// Another Atomic process resumes the run: it registers the run's live route, which revokes the dormant one.
				const resumingProcess = await peer("resuming-process", run.group);
				resumingProcess.registerPendingStageRoute(run.runId, run.group, "resuming-process-capability", [
					{
						stageId: "lane-id",
						stageName: "lane",
						target: `${run.group}/lane-id`,
						lifecycle: "pending",
						routeEligible: true,
						group: run.group,
					},
				]);
				const result = await Promise.race([held.outcome, sleep(REVOKE_WAIT_MS).then(() => undefined)]);
				assert.ok(result, "the held send is answered once the run is taken over");
				assert.equal(result.delivered, false);
				assert.match(
					result.reason ?? "",
					new RegExp(`Workflow run ${run.runId} was resumed in another Atomic session; send to it again there`),
				);
				assert.doesNotMatch(result.reason ?? "", /Session not found|did not survive/);

				const later = await thirdParty.send(run.child.intercomTarget, { text: "anyone?" });
				assert.equal(later.reason, "Session not found", "the dormant owner no longer holds the subagent");
			} finally {
				await launching.stop();
			}
		} finally {
			removeTempDirectory(cwd);
		}
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);
