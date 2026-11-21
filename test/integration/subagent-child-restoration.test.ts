import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	EARLY_CHILD_HOLD_MAX_MS,
	holdRunningSubagentChildren,
} from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	awaitSubagentChildRestoration,
	recordReportedGoneSubagentChildren,
	restoredChildrenAwaitingIntercom,
	restoreSubagentChild,
	restoreSubagentChildren,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT,
	SUBAGENT_RESUME_CONTINUATION_PROMPT,
	type SubagentChildRestoreDeps,
	type SubagentReleaseRestoringChildRequest,
	type SubagentReserveRestoringChildRequest,
	type SubagentRestoredIntercomPeer,
	type SubagentRestoredIntercomPeersRequest,
	subagentChildRestoreNotices,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const RECORD_POLL_MS = 10;

function taskHost(owner: string): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `${owner}-${randomUUID()}` },
		authorizeLaunch() {},
	});
}
const RECORD_WAIT_MS = 5_000;
/** Long enough that a target matched only at the deadline is plainly late, short enough to stay inside the test budget. */
const UNMATCHED_TARGET_WAIT_MS = 10_000;
/** A wait that ends while a restoration is still blocked. */
const SHORT_RESTORE_WAIT_MS = 200;

const agent: AgentConfig = {
	name: "worker",
	description: "worker",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

interface Parent {
	readonly sessionManager: SessionManager;
	readonly ctx: (host: AgentTaskHost) => ExtensionContext;
	readonly pi: SubagentChildRestoreDeps["pi"];
	readonly authorizations: string[];
	readonly awaitedPeers: Array<{ name: string; group?: string }>;
	/** What the parent asked Intercom's broker to hold for its restoring children, in order. */
	readonly holds: Array<
		{ reserve: string; aliases: readonly string[]; group?: string } | { release: string; gone?: string }
	>;
}

function parentSession(cwd: string, sessionManager: SessionManager = SessionManager.inMemory(cwd)): Parent {
	const authorizations: string[] = [];
	const awaitedPeers: Array<{ name: string; group?: string }> = [];
	const holds: Parent["holds"] = [];
	const events = {
		on: () => () => {},
		emit(channel: string, data: object) {
			if (channel === SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT) {
				const request = data as { childName: string; completion?: Promise<object> };
				authorizations.push(request.childName);
				request.completion = Promise.resolve({
					capability: `fresh-capability-${authorizations.length}`,
					supervisorSessionId: "resumed-parent",
					childName: request.childName,
				});
			}
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT) {
				const request = data as { name: string; group?: string; completion?: Promise<boolean> };
				awaitedPeers.push({ name: request.name, ...(request.group ? { group: request.group } : {}) });
				request.completion = Promise.resolve(true);
			}
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReserveRestoringChildRequest;
				holds.push({
					reserve: request.capability,
					aliases: request.aliases,
					...(request.group ? { group: request.group } : {}),
				});
				request.completion = Promise.resolve();
			}
			if (channel === SUBAGENT_RELEASE_RESTORING_CHILD_EVENT) {
				const request = data as SubagentReleaseRestoringChildRequest;
				holds.push({ release: request.capability, ...(request.gone === undefined ? {} : { gone: request.gone }) });
				request.completion = Promise.resolve();
			}
		},
	};
	const pi = {
		events,
		appendEntry: async (customType: string, data?: SubagentChildRecord) => {
			await sessionManager.appendCustomEntry(customType, data);
		},
		getSessionName: () => "parent-session",
	} as unknown as SubagentChildRestoreDeps["pi"];
	const ctx = (host: AgentTaskHost) =>
		({
			cwd,
			sessionManager,
			getAgentTaskHost: () => host,
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
			model: undefined,
			thinkingLevel: undefined,
		}) as unknown as ExtensionContext;
	return { sessionManager, ctx, pi, authorizations, awaitedPeers, holds };
}

function records(parent: Parent): SubagentChildRecord[] {
	return parent.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === SUBAGENT_CHILD_RECORD_TYPE
				? [entry.data as SubagentChildRecord]
				: [],
		);
}

async function waitForRecord(
	parent: Parent,
	state: SubagentChildRecord["state"],
	accept: (record: SubagentChildRecord) => boolean = () => true,
): Promise<SubagentChildRecord> {
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (Date.now() < deadline) {
		const record = records(parent).find((candidate) => candidate.state === state && accept(candidate));
		if (record) return record;
		await sleep(RECORD_POLL_MS);
	}
	throw new Error(`No ${state} child record within ${RECORD_WAIT_MS}ms`);
}

async function launchInterruptedChild(
	cwd: string,
	parent: Parent,
	runId: string,
	group = "lane-group",
	childSessionManager?: SessionManager,
	launchOptions: Partial<RunSyncOptions> = {},
) {
	const host = taskHost("parent-before-restart");
	const neverReleased = Promise.withResolvers<void>();
	const options: RunSyncOptions = {
		cwd,
		runId,
		index: 0,
		sessionDir: join(cwd, "children", runId),
		...(childSessionManager ? { sessionManager: childSessionManager } : {}),
		...launchOptions,
		intercomSessionName: `subagent-worker-${runId}-1`,
		intercomGroup: group,
		orchestratorIntercomTarget: "parent-session",
	};
	const recordChild = createSubagentChildRecordSink(parent.pi, parent.ctx(host));
	const response = await runAgentTask({
		host,
		cwd,
		agents: [agent],
		agent: "worker",
		task: "original task",
		options,
		recordChild,
		runtime: {
			runSync: (...args) =>
				runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: { output: "never", promptGate: neverReleased.promise, abortResolvesPrompt: true },
				}),
		},
	});
	assert.equal(response.kind, "admitted");
	// The launch model and thinking level follow the first record once the child's session exists.
	const running = await waitForRecord(parent, "running", (record) => record.launchLeafId !== undefined);
	await host.close("session-close");
	// Closing records the child's last state after it returns; a copy of the session must see that record.
	await recordChild.flushed?.();
	return running;
}

function restoreDeps(parent: Parent, launched: RunSyncOptions[]): SubagentChildRestoreDeps {
	return {
		pi: parent.pi,
		config: {},
		discoverAgents: () => ({ agents: [agent] }),
		runtime: {
			runSync: (...args) => {
				launched.push(args[4]);
				return runSync(args[0], args[1], args[2], args[3], { ...args[4], testSession: { output: "resumed" } });
			},
		},
	};
}

test("session recovery leaves a former workflow stage's saved children alone", async () => {
	const cwd = makeTempDirectory("subagent-retired-stage-");
	const parent = parentSession(cwd);
	const host = taskHost("recovery");
	try {
		await parent.sessionManager.appendCustomEntry(SUBAGENT_CHILD_RECORD_TYPE, {
			version: 1,
			childId: "previous:0",
			runId: "previous",
			index: 0,
			agent: "worker",
			state: "running",
			cwd,
			owner: {
				kind: "workflow-stage",
				sessionId: parent.sessionManager.getSessionId(),
				workflowRunId: "old",
				workflowStageId: "one",
				workflowStageName: "One",
			},
		});
		assert.deepEqual(await restoreSubagentChildren(restoreDeps(parent, []), parent.ctx(host)), []);
		assert.equal(records(parent).length, 1);
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a background child is recorded at launch and stays restorable when its owner closes (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-record-");
	try {
		const parent = parentSession(cwd);
		const running = await launchInterruptedChild(cwd, parent, "rec1");
		assert.equal(running.childId, "rec1:0");
		assert.equal(running.agent, "worker");
		assert.equal(running.intercomTarget, "subagent-worker-rec1-1");
		assert.equal(running.intercomGroup, "lane-group");
		assert.equal(running.orchestratorTarget, "parent-session");
		assert.deepEqual(running.owner, { kind: "session", sessionId: parent.sessionManager.getSessionId() });
		assert.ok(running.childSessionFile && existsSync(running.childSessionFile));
		assert.match(readFileSync(running.childSessionFile, "utf8"), /original task/);
		assert.equal(readSubagentChildRecords(parent.sessionManager.getEntries()).get("rec1:0")?.state, "running");
		assert.equal(records(parent).filter((record) => record.state === "terminal").length, 0);
	} finally {
		removeTempDirectory(cwd);
	}
});

test("a settled background child is recorded terminal and is never relaunched (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-terminal-");
	const host = taskHost("parent");
	try {
		const parent = parentSession(cwd);
		const response = await runAgentTask({
			host,
			cwd,
			agents: [agent],
			agent: "worker",
			task: "finish",
			options: { cwd, runId: "done1", index: 0, sessionDir: join(cwd, "children") },
			recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(host)),
			runtime: {
				runSync: (...args) =>
					runSync(args[0], args[1], args[2], args[3], { ...args[4], testSession: { output: "ok" } }),
			},
		});
		assert.equal(response.kind, "admitted");
		await host.waitForTask(response.observation.taskId as TaskId);
		const terminal = await waitForRecord(parent, "terminal");
		assert.equal(terminal.terminalStatus, "ok");
		const launched: RunSyncOptions[] = [];
		const outcome = await restoreSubagentChild(restoreDeps(parent, launched), parent.ctx(host), "done1:0");
		assert.equal(outcome.kind, "terminal");
		assert.equal(launched.length, 0);
		assert.deepEqual(await restoreSubagentChildren(restoreDeps(parent, launched), parent.ctx(host)), []);
	} finally {
		await host.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("restoring a child reopens its own session under its original Intercom name with fresh authorization (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-restore-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "lane1");
		assert.ok(original.childSessionFile);
		const launched: RunSyncOptions[] = [];
		const deps = restoreDeps(parent, launched);

		const [outcome, concurrent] = await Promise.all([
			restoreSubagentChild(deps, parent.ctx(resumedHost), "subagent-worker-lane1-1"),
			restoreSubagentChild(deps, parent.ctx(resumedHost), "lane1:0"),
		]);
		assert.equal(concurrent, outcome);
		assert.equal(outcome.kind, "restored");
		assert.equal(outcome.intercomLive, true);
		assert.deepEqual(parent.authorizations, ["subagent-worker-lane1-1"]);
		assert.deepEqual(parent.awaitedPeers, [{ name: "subagent-worker-lane1-1", group: "lane-group" }]);

		assert.equal(launched.length, 1);
		const relaunch = launched[0]!;
		assert.equal(relaunch.runId, "lane1");
		assert.equal(relaunch.index, 0);
		assert.equal(relaunch.resumeSession, true);
		assert.equal(relaunch.intercomSessionName, "subagent-worker-lane1-1");
		assert.equal(relaunch.intercomGroup, "lane-group");
		assert.equal(relaunch.supervisorAuthorization?.capability, "fresh-capability-1");
		assert.equal(relaunch.sessionManager?.getSessionId(), original.childSessionId);

		const settled = await resumedHost.waitForTask(outcome.taskId as TaskId);
		assert.ok(settled.ok);
		assert.deepEqual(
			parent.holds,
			[
				{ reserve: "fresh-capability-1", aliases: [original.childSessionId], group: "lane-group" },
				{ release: "fresh-capability-1" },
			],
			"sends to the child are held under its fresh capability until it settles, and it is never called gone",
		);
		const transcript = readFileSync(original.childSessionFile, "utf8");
		assert.match(transcript, /original task/);
		assert.ok(transcript.includes(SUBAGENT_RESUME_CONTINUATION_PROMPT));
		assert.match(
			SUBAGENT_RESUME_CONTINUATION_PROMPT,
			/redo or continue that step as needed/,
			"the restored child is told to redo a step the restart interrupted",
		);
		const final = await waitForRecord(parent, "terminal");
		assert.equal(final.childId, "lane1:0");
		assert.equal(final.childSessionId, original.childSessionId);
		assert.equal(readSubagentChildRecords(parent.sessionManager.getEntries()).get("lane1:0")?.state, "terminal");

		const [notice] = subagentChildRestoreNotices([outcome]);
		assert.match(notice!, /`subagent-worker-lane1-1`.*relaunched from its own session.*live on Intercom/);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a relaunched child that has not re-registered with Intercom is reported as still coming back until it settles (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-pending-peer-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "pend1");
		const previousIntercomId = randomUUID();
		const childSession = await SessionManager.open(original.childSessionFile!, undefined, cwd);
		await childSession.appendCustomEntry("intercom_session_identity", {
			sessionId: original.childSessionId,
			intercomSessionId: previousIntercomId,
		});
		// Intercom never sees the relaunched child register.
		const emitted = parent.pi.events.emit.bind(parent.pi.events);
		parent.pi.events.emit = (channel: string, data: unknown) => {
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT) {
				(data as { completion?: Promise<boolean> }).completion = Promise.resolve(false);
				return;
			}
			emitted(channel, data);
		};
		const settle = Promise.withResolvers<void>();
		const deps: SubagentChildRestoreDeps = {
			pi: parent.pi,
			config: {},
			discoverAgents: () => ({ agents: [agent] }),
			runtime: {
				runSync: (...args) =>
					runSync(args[0], args[1], args[2], args[3], {
						...args[4],
						testSession: { output: "resumed", promptGate: settle.promise },
					}),
			},
		};
		const ctx = parent.ctx(resumedHost);
		const ownerSessionId = parent.sessionManager.getSessionId();
		assert.deepEqual(restoredChildrenAwaitingIntercom(ownerSessionId), [], "nothing is relaunched yet");

		const outcome = await restoreSubagentChild(deps, ctx, "pend1:0");
		assert.equal(outcome.kind, "restored");
		assert.equal(outcome.kind === "restored" && outcome.intercomLive, false);
		const awaiting: SubagentRestoredIntercomPeer[] = [
			{ name: "subagent-worker-pend1-1", ids: [original.childSessionId!, previousIntercomId] },
		];
		assert.deepEqual(restoredChildrenAwaitingIntercom(ownerSessionId), awaiting);
		assert.deepEqual(
			restoredChildrenAwaitingIntercom("another-session"),
			[],
			"another session's children are not reported",
		);

		// Intercom reaches the same answer through the subagents extension.
		const listeners = new Map<string, Array<(payload: unknown) => void>>();
		registerSubagentExtension({
			registerTool: () => {},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			on: () => {},
			events: {
				on: (channel: string, listener: (payload: unknown) => void) => {
					listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
					return () => {};
				},
				emit: () => {},
			},
			getSessionName: () => "parent-session",
		} as unknown as ExtensionAPI);
		const request: SubagentRestoredIntercomPeersRequest = { ownerSessionId };
		for (const listener of listeners.get(SUBAGENT_RESTORED_INTERCOM_PEERS_EVENT) ?? []) listener(request);
		assert.deepEqual(await request.completion, awaiting);

		settle.resolve();
		await resumedHost.waitForTask(outcome.kind === "restored" ? (outcome.taskId as TaskId) : ("" as TaskId));
		await vi.waitFor(() => assert.deepEqual(restoredChildrenAwaitingIntercom(ownerSessionId), []), {
			timeout: RECORD_WAIT_MS,
			interval: RECORD_POLL_MS,
		});
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a resumed session holds its interrupted children's targets as soon as it starts, and its recovery takes the hold over under the same capability (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-early-hold-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "early1");
		// A sibling finished before the restart; only early1 was interrupted.
		await parent.pi.appendEntry(SUBAGENT_CHILD_RECORD_TYPE, {
			...original,
			childId: "early2:0",
			runId: "early2",
			intercomTarget: "subagent-worker-early2-1",
			state: "terminal",
			terminalStatus: "completed",
		});
		parent.holds.length = 0;
		parent.authorizations.length = 0;

		const ctx = parent.ctx(resumedHost);
		await holdRunningSubagentChildren(parent.pi.events as never, ctx);
		assert.deepEqual(parent.authorizations, ["subagent-worker-early1-1"], "only the interrupted child is held");
		assert.deepEqual(parent.holds, [
			{ reserve: "fresh-capability-1", aliases: [original.childSessionId], group: "lane-group" },
		]);
		await holdRunningSubagentChildren(parent.pi.events as never, ctx);
		assert.equal(parent.authorizations.length, 1, "holding again never authorizes the child twice");

		const launched: RunSyncOptions[] = [];
		const outcome = await restoreSubagentChild(restoreDeps(parent, launched), ctx, "early1:0");
		assert.equal(outcome.kind, "restored");
		assert.deepEqual(parent.authorizations, ["subagent-worker-early1-1"], "the restoration reuses the hold it found");
		assert.equal(launched[0]?.supervisorAuthorization?.capability, "fresh-capability-1");
		await resumedHost.waitForTask((outcome as { taskId: string }).taskId as TaskId);
		assert.deepEqual(
			parent.holds,
			[
				{ reserve: "fresh-capability-1", aliases: [original.childSessionId], group: "lane-group" },
				{ reserve: "fresh-capability-1", aliases: [original.childSessionId], group: "lane-group" },
				{ release: "fresh-capability-1" },
			],
			"the hold never lapses between session start and the child's end: the restoration refreshes it, it does not start over",
		);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a child that cannot be restored is told gone under the capability its hold was taken with at session start (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-early-gone-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "early3");
		rmSync(original.childSessionFile!, { force: true });
		parent.holds.length = 0;
		parent.authorizations.length = 0;
		const ctx = parent.ctx(resumedHost);
		await holdRunningSubagentChildren(parent.pi.events as never, ctx);
		const outcome = await restoreSubagentChild(restoreDeps(parent, []), ctx, "early3:0");
		assert.equal(outcome.kind, "unrestorable");
		assert.deepEqual(parent.authorizations, ["subagent-worker-early3-1"]);
		assert.deepEqual(parent.holds.at(-1), {
			release: "fresh-capability-1",
			gone: `its session file is missing: ${original.childSessionFile}`,
		});
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("the subagents extension holds interrupted children when a session is opened and ends the holds with the session, but not after a reload or in a child (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-early-extension-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "early5");
		parent.holds.length = 0;
		parent.authorizations.length = 0;
		const handlers = new Map<string, Array<(event: object, ctx: ExtensionContext) => unknown>>();
		registerSubagentExtension({
			registerTool: () => {},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			on: (event: string, handler: (event: object, ctx: ExtensionContext) => unknown) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			events: parent.pi.events,
			getSessionName: () => "parent-session",
		} as unknown as ExtensionAPI);
		const fire = async (event: string, payload: object, ctx: ExtensionContext) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		};
		const ctx = parent.ctx(resumedHost);

		await fire("session_start", { type: "session_start", reason: "reload" }, ctx);
		await sleep(200);
		assert.deepEqual(parent.authorizations, [], "after a reload the running children are alive: nothing is held");
		const child = { ...ctx, subagentPolicy: { depth: 1 } } as ExtensionContext;
		await fire("session_start", { type: "session_start", reason: "resume" }, child);
		await sleep(200);
		assert.deepEqual(parent.authorizations, [], "a subagent child never owns children");

		await fire("session_start", { type: "session_start", reason: "resume" }, ctx);
		await vi.waitFor(() => assert.deepEqual(parent.authorizations, ["subagent-worker-early5-1"]), {
			timeout: RECORD_WAIT_MS,
			interval: RECORD_POLL_MS,
		});
		await vi.waitFor(
			() =>
				assert.deepEqual(parent.holds[0], {
					reserve: "fresh-capability-1",
					aliases: [original.childSessionId],
					group: "lane-group",
				}),
			{ timeout: RECORD_WAIT_MS, interval: RECORD_POLL_MS },
		);

		await fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		await vi.waitFor(() => assert.deepEqual(parent.holds.at(-1), { release: "fresh-capability-1" }), {
			timeout: RECORD_WAIT_MS,
			interval: RECORD_POLL_MS,
		});
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a hold taken at session start that no recovery takes over ends instead of outliving the session or its host (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-early-expiry-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		await launchInterruptedChild(cwd, parent, "early4");
		parent.holds.length = 0;
		parent.authorizations.length = 0;
		const ctx = parent.ctx(resumedHost);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const held = holdRunningSubagentChildren(parent.pi.events as never, ctx);
			await vi.advanceTimersByTimeAsync(10);
			await held;
			assert.equal(parent.holds.length >= 1, true, "the child is held");
			assert.equal(
				parent.holds.some((hold) => "release" in hold),
				false,
			);
			await vi.advanceTimersByTimeAsync(EARLY_CHILD_HOLD_MAX_MS - 1_000);
			assert.equal(
				parent.holds.some((hold) => "release" in hold),
				false,
				"still held while recovery may yet restore the child",
			);
			await vi.advanceTimersByTimeAsync(1_000);
			assert.deepEqual(parent.holds.at(-1), { release: "fresh-capability-1" });
		} finally {
			vi.useRealTimers();
		}
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a restored child continues on its own session's model and thinking level, not the parent's current ones (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-model-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true };
		const haiku = { provider: "anthropic", id: "claude-haiku-5", reasoning: true };
		const models = [sonnet, haiku];
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "model1");
		// The model and thinking level the child was running on before the restart, persisted in its own session.
		const childSession = await SessionManager.open(original.childSessionFile!, undefined, cwd);
		await childSession.appendModelChange(sonnet.provider, sonnet.id);
		await childSession.appendThinkingLevelChange("high");

		// After the restart the parent runs on a different model and thinking level.
		const resumedCtx = {
			...parent.ctx(resumedHost),
			model: haiku,
			thinkingLevel: "low",
			modelRegistry: {
				getAvailable: () => models,
				getAll: () => models,
				find: (provider: string, id: string) =>
					models.find((model) => model.provider === provider && model.id === id),
				hasConfiguredAuth: () => true,
			},
		} as unknown as ExtensionContext;
		const results: Array<{ model?: string; thinking?: string }> = [];
		const deps: SubagentChildRestoreDeps = {
			...restoreDeps(parent, []),
			runtime: {
				runSync: async (...args) => {
					const result = await runSync(args[0], args[1], args[2], args[3], {
						...args[4],
						testSession: { output: "resumed" },
					});
					results.push({ model: result.model, thinking: result.thinking });
					return result;
				},
			},
		};

		const outcome = await restoreSubagentChild(deps, resumedCtx, "model1:0");
		assert.equal(outcome.kind, "restored");
		assert.ok((await resumedHost.waitForTask(outcome.taskId as TaskId)).ok);
		assert.equal(results.length, 1);
		assert.match(results[0]!.model ?? "", /^anthropic\/claude-sonnet-5-5\b/);
		assert.equal(results[0]!.thinking, "high");
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a child whose session is gone is reported gone to the resumed agent instead of relaunched (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-gone-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "gone1");
		rmSync(original.childSessionFile!, { force: true });
		const launched: RunSyncOptions[] = [];
		const outcomes = await restoreSubagentChildren(restoreDeps(parent, launched), parent.ctx(resumedHost));
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0]?.kind, "unrestorable");
		assert.equal(launched.length, 0);
		// The parent authorizes itself only to hold, then mark gone, the child's targets for every sender (#3760).
		assert.deepEqual(parent.authorizations, ["subagent-worker-gone1-1"]);
		assert.deepEqual(parent.holds, [
			{ reserve: "fresh-capability-1", aliases: [original.childSessionId], group: "lane-group" },
			{ release: "fresh-capability-1", gone: `its session file is missing: ${original.childSessionFile}` },
		]);
		const [notice] = subagentChildRestoreNotices(outcomes);
		assert.match(notice!, /`subagent-worker-gone1-1` \(worker\) did not survive the restart/);
		assert.match(notice!, /It is gone: do not send it Intercom messages/);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a forked session never restores or reports the background children of the session it was forked from (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-fork-");
	const resumedHost = taskHost("after-restart");
	try {
		const original = await SessionManager.create(cwd, join(cwd, "sessions"));
		await original.appendMessage({ role: "user", content: "parent request", timestamp: Date.now() });
		const parent = parentSession(cwd, original);
		await launchInterruptedChild(cwd, parent, "fork1");
		const sessionFile = original.getSessionFile();
		assert.ok(sessionFile, "the original session is file-backed");

		// `/fork` and `atomic --fork` copy every entry, the child records included, into a new session. A file forked
		// into its own directory is copied whole, as main copied it; a proven other store gets only the window.
		const forkedFrom = await SessionManager.forkFrom(sessionFile, cwd, join(cwd, "sessions"));
		const branched = await SessionManager.open(sessionFile, undefined, cwd);
		await branched.createBranchedSession(branched.getLeafId()!);
		for (const fork of [forkedFrom, branched]) {
			assert.notEqual(fork.getSessionId(), original.getSessionId());
			assert.equal(
				fork
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CHILD_RECORD_TYPE).length,
				records(parent).length,
				"the fork carries a copy of the original's child records",
			);
			const forked = parentSession(cwd, fork);
			const launched: RunSyncOptions[] = [];
			assert.deepEqual(await restoreSubagentChildren(restoreDeps(forked, launched), forked.ctx(resumedHost)), []);
			const byId = await restoreSubagentChild(restoreDeps(forked, launched), forked.ctx(resumedHost), "fork1:0");
			assert.equal(byId.kind, "unrestorable");
			assert.equal(launched.length, 0, "a fork must not relaunch the original's child");
			assert.deepEqual(forked.authorizations, [], "a fork must not claim the original child's Intercom name");
		}

		const launched: RunSyncOptions[] = [];
		const [outcome] = await restoreSubagentChildren(restoreDeps(parent, launched), parent.ctx(resumedHost));
		assert.equal(outcome?.kind, "restored", "the session that launched the child still restores it");
		assert.equal(launched.length, 1);
		if (outcome?.kind === "restored") await resumedHost.waitForTask(outcome.taskId as TaskId);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("the subagents extension restores children when the resumed session runs recovery (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-extension-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "ext1");
		rmSync(original.childSessionFile!, { force: true });
		const handlers = new Map<
			string,
			(event: object, ctx: ExtensionContext) => Promise<{ notices?: string[] } | undefined>
		>();
		registerSubagentExtension({
			registerTool: () => {},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			on: (
				event: string,
				handler: (event: object, ctx: ExtensionContext) => Promise<{ notices?: string[] } | undefined>,
			) => handlers.set(event, handler),
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent-session",
		} as unknown as ExtensionAPI);
		const restore = handlers.get("session_recovery_restore");
		assert.ok(restore, "the subagents extension must take part in session recovery");
		const result = await restore({ type: "session_recovery_restore", reason: "resume" }, parent.ctx(resumedHost));
		assert.equal(result?.notices?.length, 1);
		assert.match(result!.notices![0]!, /`subagent-worker-ext1-1` \(worker\) did not survive the restart/);
		const child = { ...parent.ctx(resumedHost), subagentPolicy: { depth: 1 } } as ExtensionContext;
		assert.equal(await restore({ type: "session_recovery_restore", reason: "resume" }, child), undefined);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a child reported gone on one resume is neither retried nor reported again on the next (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-gone-once-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "once1");
		rmSync(original.childSessionFile!, { force: true });
		const handlers = new Map<
			string,
			(event: object, ctx: ExtensionContext) => Promise<{ notices?: string[] } | undefined>
		>();
		registerSubagentExtension({
			registerTool: () => {},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			appendEntry: parent.pi.appendEntry,
			on: (
				event: string,
				handler: (event: object, ctx: ExtensionContext) => Promise<{ notices?: string[] } | undefined>,
			) => handlers.set(event, handler),
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "parent-session",
		} as unknown as ExtensionAPI);
		const restore = handlers.get("session_recovery_restore");
		assert.ok(restore, "the subagents extension must take part in session recovery");
		// Restoration begins by asking the resumed session for its task host, so reads count attempts.
		let attempts = 0;
		const resumed = Object.defineProperty({ ...parent.ctx(resumedHost) }, "getAgentTaskHost", {
			get() {
				attempts += 1;
				return () => resumedHost;
			},
		}) as ExtensionContext;

		const first = await restore({ type: "session_recovery_restore", reason: "resume" }, resumed);
		assert.equal(first?.notices?.length, 1);
		assert.match(first!.notices![0]!, /`subagent-worker-once1-1` \(worker\) did not survive the restart/);
		assert.equal(attempts, 1, "the first resume attempts the restoration");

		const entriesAfterFirst = parent.sessionManager.getEntries().length;
		const second = await restore({ type: "session_recovery_restore", reason: "resume" }, resumed);
		assert.deepEqual(second?.notices ?? [], [], "the second resume must not repeat the notice");
		assert.equal(attempts, 1, "the second resume must not attempt the restoration again");
		assert.equal(parent.sessionManager.getEntries().length, entriesAfterFirst);
		const gone = readSubagentChildRecords(parent.sessionManager.getEntries()).get("once1:0");
		assert.equal(gone?.state, "terminal");
		assert.equal(gone?.terminalStatus, "gone");
		assert.equal(gone?.childSessionId, original.childSessionId, "the gone record keeps the child's identity");
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a restored child's pre-restart Intercom id is recognized while a sibling is still being restored (#5097)", async () => {
	const cwd = makeTempDirectory("subagent-child-sibling-id-");
	const resumedHost = taskHost("parent-after-restart");
	const open = SessionManager.open.bind(SessionManager);
	const slowSibling = Promise.withResolvers<SessionManager>();
	try {
		const parent = parentSession(cwd);
		await launchInterruptedChild(cwd, parent, "known1");
		await launchInterruptedChild(cwd, parent, "slow1");
		const children = readSubagentChildRecords(parent.sessionManager.getEntries());
		const known = children.get("known1:0")!;
		const slow = children.get("slow1:0")!;
		const previousIntercomId = randomUUID();
		const childSession = await SessionManager.open(known.childSessionFile!, undefined, cwd);
		await childSession.appendCustomEntry("intercom_session_identity", {
			sessionId: known.childSessionId,
			intercomSessionId: previousIntercomId,
		});
		// The known child never re-registers with Intercom, so its restoration settles with a refusal to send.
		const emitted = parent.pi.events.emit.bind(parent.pi.events);
		parent.pi.events.emit = (channel: string, data: unknown) => {
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT) {
				(data as { completion?: Promise<boolean> }).completion = Promise.resolve(false);
				return;
			}
			emitted(channel, data);
		};
		// The sibling's session does not reopen until the end of the test.
		vi.spyOn(SessionManager, "open").mockImplementation(((...args: Parameters<typeof open>) =>
			args[0] === (slow.childSessionFile as unknown) ? slowSibling.promise : open(...args)) as typeof open);

		const restoring = restoreSubagentChildren(restoreDeps(parent, []), parent.ctx(resumedHost));
		const refusal = await awaitSubagentChildRestoration(
			parent.sessionManager.getSessionId(),
			parent.sessionManager.getEntries(),
			previousIntercomId,
			RECORD_WAIT_MS,
		);
		// The sibling, named, is found at once and is still being restored when the short wait ends.
		const slowRefusal = await awaitSubagentChildRestoration(
			parent.sessionManager.getSessionId(),
			parent.sessionManager.getEntries(),
			slow.intercomTarget!,
			SHORT_RESTORE_WAIT_MS,
		);

		slowSibling.reject(new Error("the sibling's session is gone"));
		await restoring;
		// The relaunched child that has not registered is still starting: its hold keeps the send, which goes out.
		assert.equal(refusal, undefined);
		assert.match(slowRefusal ?? "", /subagent-worker-slow1-1.*is still being restored/);
	} finally {
		slowSibling.reject(new Error("the sibling's session is gone"));
		vi.restoreAllMocks();
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a restored child's pre-restart Intercom id is matched past a sibling's, and a target that is no child's is answered at once (#5097)", async () => {
	const cwd = makeTempDirectory("subagent-child-two-ids-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		await launchInterruptedChild(cwd, parent, "first1");
		await launchInterruptedChild(cwd, parent, "second1");
		const children = readSubagentChildRecords(parent.sessionManager.getEntries());
		const previousIds = new Map<string, string>();
		for (const childId of ["first1:0", "second1:0"]) {
			const child = children.get(childId)!;
			const previousIntercomId = randomUUID();
			previousIds.set(childId, previousIntercomId);
			const childSession = await SessionManager.open(child.childSessionFile!, undefined, cwd);
			await childSession.appendCustomEntry("intercom_session_identity", {
				sessionId: child.childSessionId,
				intercomSessionId: previousIntercomId,
			});
		}
		const emitted = parent.pi.events.emit.bind(parent.pi.events);
		parent.pi.events.emit = (channel: string, data: unknown) => {
			if (channel === SUBAGENT_AWAIT_INTERCOM_PEER_EVENT) {
				(data as { completion?: Promise<boolean> }).completion = Promise.resolve(false);
				return;
			}
			emitted(channel, data);
		};
		const outcomes = await restoreSubagentChildren(restoreDeps(parent, []), parent.ctx(resumedHost));
		assert.deepEqual(
			outcomes.map((outcome) => outcome.kind),
			["restored", "restored"],
		);
		const owner = parent.sessionManager.getSessionId();
		const entries = parent.sessionManager.getEntries();

		// The relaunched child that has not registered is still starting: its hold keeps the send, which goes out.
		const second = await awaitSubagentChildRestoration(owner, entries, previousIds.get("second1:0")!, RECORD_WAIT_MS);
		assert.equal(second, undefined);

		// Every id is known, so a target that is none of them is not held until the deadline.
		const started = Date.now();
		assert.equal(
			await awaitSubagentChildRestoration(owner, entries, "someone-else", UNMATCHED_TARGET_WAIT_MS),
			undefined,
		);
		assert.equal(
			await awaitSubagentChildRestoration("another-owner", entries, "someone-else", UNMATCHED_TARGET_WAIT_MS),
			undefined,
		);
		assert.ok(Date.now() - started < UNMATCHED_TARGET_WAIT_MS / 2, "an unmatched target waited for the deadline");
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("only the children reported gone are recorded gone; a restored child keeps recording its own progress (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-gone-mixed-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		await launchInterruptedChild(cwd, parent, "keep1");
		await launchInterruptedChild(cwd, parent, "lose1");
		const lost = readSubagentChildRecords(parent.sessionManager.getEntries()).get("lose1:0");
		rmSync(lost!.childSessionFile!, { force: true });

		const outcomes = await restoreSubagentChildren(restoreDeps(parent, []), parent.ctx(resumedHost));
		assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["restored", "unrestorable"]);
		await recordReportedGoneSubagentChildren(parent.pi, outcomes);

		const settled = outcomes.find((outcome) => outcome.kind === "restored");
		assert.ok(settled?.kind === "restored");
		assert.ok((await resumedHost.waitForTask(settled.taskId as TaskId)).ok);
		const final = readSubagentChildRecords(parent.sessionManager.getEntries());
		assert.equal(final.get("lose1:0")?.terminalStatus, "gone");
		assert.notEqual(final.get("keep1:0")?.terminalStatus, "gone");
		assert.equal(records(parent).filter((record) => record.terminalStatus === "gone").length, 1);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

async function openDefaultStore(cwd: string): Promise<SessionStore> {
	return resolveSessionStore(cwd, {
		sessionStore: { kind: "sqlite", path: join(cwd, "sessions.sqlite"), prefix: "" },
	});
}

async function launchForkedSqliteChild(
	cwd: string,
	runId: string,
	setup?: {
		parentModel: { provider: string; id: string };
		parentThinking: string;
		launchOptions: Partial<RunSyncOptions>;
	},
) {
	const store = await openDefaultStore(cwd);
	const parentManager = await SessionManager.create(store, cwd);
	await parentManager.appendMessage({ role: "user", content: "parent request", timestamp: Date.now() });
	if (setup) {
		await parentManager.appendModelChange(setup.parentModel.provider, setup.parentModel.id);
		await parentManager.appendThinkingLevelChange(setup.parentThinking);
	}
	const parent = parentSession(cwd, parentManager);
	const forked = await createForkContextResolver(parentManager, "fork").sessionManagerForIndex(0);
	assert.ok(forked);
	assert.equal(forked.getSessionFile(), undefined, "a SQLite child session has no session file");
	const running = await launchInterruptedChild(cwd, parent, runId, "lane-group", forked, setup?.launchOptions);
	await store.close();
	return { parentId: parentManager.getSessionId(), running };
}

async function resumeSqliteParent(cwd: string, parentId: string) {
	const store = await openDefaultStore(cwd);
	const parent = parentSession(cwd, await SessionManager.open(store, parentId, cwd));
	return { store, parent };
}

test("a background child in the default SQLite session store is restored by its session id on resume (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-sqlite-");
	const resumedHost = taskHost("parent-after-restart");
	let resumedStore: SessionStore | undefined;
	try {
		const { parentId, running } = await launchForkedSqliteChild(cwd, "sql1");
		assert.ok(running.childSessionId);
		assert.equal(running.childSessionFile, undefined);

		const resumed = await resumeSqliteParent(cwd, parentId);
		resumedStore = resumed.store;
		const launched: RunSyncOptions[] = [];
		const outcome = await restoreSubagentChild(
			restoreDeps(resumed.parent, launched),
			resumed.parent.ctx(resumedHost),
			"sql1:0",
		);
		assert.equal(outcome.kind, "restored");
		assert.equal(outcome.intercomLive, true);
		assert.deepEqual(resumed.parent.authorizations, ["subagent-worker-sql1-1"]);
		assert.equal(launched[0]?.resumeSession, true);
		assert.equal(launched[0]?.sessionManager?.getSessionId(), running.childSessionId);

		const settled = await resumedHost.waitForTask(outcome.taskId as TaskId);
		assert.ok(settled.ok);
		const transcript = await SessionManager.open(resumedStore, running.childSessionId, cwd);
		const text = JSON.stringify(transcript.getEntries());
		assert.match(text, /original task/);
		assert.ok(text.includes(SUBAGENT_RESUME_CONTINUATION_PROMPT));
	} finally {
		await resumedHost.close("session-close");
		await resumedStore?.close();
		removeTempDirectory(cwd);
	}
});

test("a SQLite child whose session was deleted from its store is reported gone (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-sqlite-gone-");
	const resumedHost = taskHost("parent-after-restart");
	let resumedStore: SessionStore | undefined;
	try {
		const { parentId, running } = await launchForkedSqliteChild(cwd, "sql2");
		const resumed = await resumeSqliteParent(cwd, parentId);
		resumedStore = resumed.store;
		await resumedStore.delete(running.childSessionId!);
		const launched: RunSyncOptions[] = [];
		const outcomes = await restoreSubagentChildren(
			restoreDeps(resumed.parent, launched),
			resumed.parent.ctx(resumedHost),
		);
		assert.equal(outcomes[0]?.kind, "unrestorable");
		assert.equal(launched.length, 0);
		assert.deepEqual(resumed.parent.authorizations, ["subagent-worker-sql2-1"]);
		assert.deepEqual(resumed.parent.holds.at(-1), {
			release: "fresh-capability-1",
			gone: "its session no longer exists in the session store",
		});
		assert.match(subagentChildRestoreNotices(outcomes)[0]!, /It is gone/);
	} finally {
		await resumedHost.close("session-close");
		await resumedStore?.close();
		removeTempDirectory(cwd);
	}
});

test("a forked child launched with a model thinking suffix is restored on that thinking level, not the copied parent's (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-fork-thinking-");
	const resumedHost = taskHost("parent-after-restart");
	let resumedStore: SessionStore | undefined;
	try {
		const sonnet = { provider: "anthropic", id: "claude-sonnet-4-6", reasoning: true };
		const models = [sonnet];
		const modelRegistry = {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
		};
		// The forked child's own session holds only the thinking level and model copied from its parent;
		// `:low` is applied at launch without writing an entry of its own.
		const { parentId, running } = await launchForkedSqliteChild(cwd, "think1", {
			parentModel: sonnet,
			parentThinking: "medium",
			launchOptions: {
				modelOverride: `${sonnet.provider}/${sonnet.id}:low`,
				resolveCandidateModel: createCandidateModelResolver(modelRegistry as never, sonnet.provider),
			},
		});

		const resumed = await resumeSqliteParent(cwd, parentId);
		resumedStore = resumed.store;
		const resumedCtx = {
			...resumed.parent.ctx(resumedHost),
			model: sonnet,
			thinkingLevel: "medium",
			modelRegistry,
		} as unknown as ExtensionContext;
		const results: Array<{ model?: string; thinking?: string }> = [];
		const deps: SubagentChildRestoreDeps = {
			...restoreDeps(resumed.parent, []),
			runtime: {
				runSync: async (...args) => {
					const result = await runSync(args[0], args[1], args[2], args[3], {
						...args[4],
						testSession: { output: "resumed" },
					});
					results.push({ model: result.model, thinking: result.thinking });
					return result;
				},
			},
		};

		const outcome = await restoreSubagentChild(deps, resumedCtx, "think1:0");
		assert.equal(outcome.kind, "restored");
		assert.ok((await resumedHost.waitForTask(outcome.taskId as TaskId)).ok);
		assert.equal(results.length, 1);
		assert.match(results[0]!.model ?? "", /^anthropic\/claude-sonnet-4-6\b/);
		assert.equal(results[0]!.thinking, "low");
		assert.ok(running.childSessionId);
	} finally {
		await resumedHost.close("session-close");
		await resumedStore?.close();
		removeTempDirectory(cwd);
	}
});

/** A resumed parent on `haiku` that restores child `runId:0` and reports what each restored execution returned. */
async function restoreOnHaiku(parent: Parent, resumedHost: AgentTaskHost, runId: string) {
	const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true };
	const haiku = { provider: "anthropic", id: "claude-haiku-5", reasoning: true };
	const opus = { provider: "anthropic", id: "claude-opus-5", reasoning: true };
	const models = [sonnet, haiku, opus];
	const resumedCtx = {
		...parent.ctx(resumedHost),
		model: haiku,
		thinkingLevel: "low",
		modelRegistry: {
			getAvailable: () => models,
			getAll: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: () => true,
		},
	} as unknown as ExtensionContext;
	const results: Awaited<ReturnType<typeof runSync>>[] = [];
	const deps: SubagentChildRestoreDeps = {
		...restoreDeps(parent, []),
		runtime: {
			runSync: async (...args) => {
				const result = await runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: { output: "resumed" },
				});
				results.push(result);
				return result;
			},
		},
	};
	const outcome = await restoreSubagentChild(deps, resumedCtx, `${runId}:0`);
	assert.equal(outcome.kind, "restored");
	assert.ok((await resumedHost.waitForTask(outcome.taskId as TaskId)).ok);
	return results;
}

test("a restored child launched on a named model that is gone fails naming it instead of running the parent's model (#4188)", async () => {
	const cwd = makeTempDirectory("subagent-child-named-gone-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		await launchInterruptedChild(cwd, parent, "named1", "lane-group", undefined, {
			modelOverride: "anthropic/claude-retired:high",
			currentModel: "anthropic/claude-haiku-5",
		});

		const results = await restoreOnHaiku(parent, resumedHost, "named1");
		assert.equal(results.length, 1);
		assert.equal(results[0]!.status, "error", JSON.stringify(results[0]));
		assert.match(results[0]!.error ?? "", /Model anthropic\/claude-retired:high is not available/);
		assert.doesNotMatch(results[0]!.model ?? "", /haiku/);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a restored child that fell back keeps the model its launch asked for beside the one it continues on (#4188)", async () => {
	const cwd = makeTempDirectory("subagent-child-named-fallback-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "named2", "lane-group", undefined, {
			modelOverride: "anthropic/claude-sonnet-5-5:high",
		});
		assert.equal(original.namedModel, "anthropic/claude-sonnet-5-5:high");
		// The child had moved to a fallback of its own before the restart.
		const childSession = await SessionManager.open(original.childSessionFile!, undefined, cwd);
		await childSession.appendModelChange("anthropic", "claude-haiku-5");

		const results = await restoreOnHaiku(parent, resumedHost, "named2");
		assert.equal(results.length, 1);
		assert.match(results[0]!.model ?? "", /^anthropic\/claude-haiku-5\b/);
		assert.equal(results[0]!.requestedModel, "anthropic/claude-sonnet-5-5:high");
		const restoredRecord = await waitForRecord(
			parent,
			"terminal",
			(record) => record.runId === "named2" && record.taskId !== original.taskId,
		);
		assert.equal(restoredRecord.namedModel, "anthropic/claude-sonnet-5-5:high");
		assert.equal(restoredRecord.requestedModel, "anthropic/claude-sonnet-5-5:high");
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

/** The boundary a context clear saves, and the one a compaction that rewrites the context saves. */
const CONTEXT_CLEAR = {
	strategy: "verbatim-lines",
	form: "cleared",
	promptVersion: 7,
	parameters: { query: "clear" },
	stats: {
		linesBefore: 4,
		linesDeleted: 4,
		linesKept: 0,
		rangeCount: 0,
		tokensBefore: 300,
		tokensAfter: 20,
		percentReduction: 93,
	},
} as const;
const CONTEXT_COMPACTION = { ...CONTEXT_CLEAR, form: "compacted", parameters: { query: "compact" } } as const;

/** Turns of a child that a later boundary removes from its session's memory. */
async function appendChildTurns(session: SessionManager, label: string): Promise<void> {
	for (let turn = 1; turn <= 3; turn += 1)
		await session.appendMessage({ role: "user", content: `${label} turn ${turn}`, timestamp: Date.now() });
}

/**
 * The child's session as a restore opens it: asserts that each of `switchIds` (entries the child saved after its
 * launch) lies before the window the session holds, where only what the session keeps of its earlier history is.
 */
async function assertBeforeWindow(opened: SessionManager, switchIds: readonly string[]): Promise<void> {
	const heldFrom = opened.getHeldTail().fromSeq;
	for (const id of switchIds) {
		const seq = await opened.findEntrySeq(id);
		assert.ok(seq !== undefined && seq < heldFrom, `entry ${id} at ${seq} lies before the window from ${heldFrom}`);
	}
}

test("a restored child continues on the fallback model and thinking level it moved to before a context clear (#6116)", async () => {
	const cwd = makeTempDirectory("subagent-child-fallback-cleared-");
	const resumedHost = taskHost("parent-after-restart");
	try {
		const parent = parentSession(cwd);
		const original = await launchInterruptedChild(cwd, parent, "cleared1", "lane-group", undefined, {
			modelOverride: "anthropic/claude-sonnet-5-5:high",
		});
		const childSession = await SessionManager.open(original.childSessionFile!, undefined, cwd);
		await appendChildTurns(childSession, "before the fallback");
		// The launch model failed and the child moved on to its fallback, at the fallback's thinking level.
		const fallback = await childSession.appendModelChange("anthropic", "claude-opus-5", {
			requested: "anthropic/claude-sonnet-5-5",
			from: "anthropic/claude-sonnet-5-5",
			reason: "503 provider unavailable",
		});
		const level = await childSession.appendThinkingLevelChange("medium");
		await appendChildTurns(childSession, "on the fallback");
		await childSession.appendCompaction("The context was cleared.", null, 300, CONTEXT_CLEAR);
		await childSession.appendMessage({ role: "user", content: "after the clear", timestamp: Date.now() });
		const opened = await SessionManager.open(original.childSessionFile!, undefined, cwd);
		await assertBeforeWindow(opened, [fallback, level]);

		const results = await restoreOnHaiku(parent, resumedHost, "cleared1");
		assert.equal(results.length, 1);
		assert.match(results[0]!.model ?? "", /^anthropic\/claude-opus-5\b/);
		assert.equal(results[0]!.thinking, "medium");
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

/** A forked SQLite child launched on `sonnet:high` from a parent whose conversation is on `parentModel` at `medium`. */
async function launchForkedSonnetChild(cwd: string, runId: string, parentModel: { provider: string; id: string }) {
	const models = [
		{ provider: "anthropic", id: "claude-sonnet-5-5", reasoning: true },
		{ provider: "anthropic", id: "claude-opus-5", reasoning: true },
	];
	const modelRegistry = {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: () => true,
	};
	return launchForkedSqliteChild(cwd, runId, {
		parentModel,
		parentThinking: "medium",
		launchOptions: {
			modelOverride: "anthropic/claude-sonnet-5-5:high",
			resolveCandidateModel: createCandidateModelResolver(modelRegistry as never, "anthropic"),
		},
	});
}

test("a restored SQLite child continues on the model and thinking level it chose across a clear and a later compaction (#6116)", async () => {
	const cwd = makeTempDirectory("subagent-child-sqlite-compacted-");
	const resumedHost = taskHost("parent-after-restart");
	let resumedStore: SessionStore | undefined;
	try {
		const { parentId, running } = await launchForkedSonnetChild(cwd, "compacted1", {
			provider: "anthropic",
			id: "claude-sonnet-5-5",
		});
		const resumed = await resumeSqliteParent(cwd, parentId);
		resumedStore = resumed.store;
		const childSession = await SessionManager.open(resumedStore, running.childSessionId!, cwd);
		const model = await childSession.appendModelChange("anthropic", "claude-opus-5");
		await appendChildTurns(childSession, "on opus");
		await childSession.appendCompaction("The context was cleared.", null, 300, CONTEXT_CLEAR);
		const level = await childSession.appendThinkingLevelChange("minimal");
		await appendChildTurns(childSession, "at minimal");
		await childSession.appendCompaction("The child moved to opus at minimal.", null, 300, CONTEXT_COMPACTION);
		await childSession.appendMessage({ role: "user", content: "after the compaction", timestamp: Date.now() });
		const opened = await SessionManager.open(resumedStore, running.childSessionId!, cwd);
		await assertBeforeWindow(opened, [model, level]);

		const results = await restoreOnHaiku(resumed.parent, resumedHost, "compacted1");
		assert.equal(results.length, 1);
		assert.match(results[0]!.model ?? "", /^anthropic\/claude-opus-5\b/);
		assert.equal(results[0]!.thinking, "minimal");
	} finally {
		await resumedHost.close("session-close");
		await resumedStore?.close();
		removeTempDirectory(cwd);
	}
});

test("a restored forked child that changed only its thinking level before a clear keeps its launch model, not the parent's copied model (#6116)", async () => {
	const cwd = makeTempDirectory("subagent-child-sqlite-level-cleared-");
	const resumedHost = taskHost("parent-after-restart");
	let resumedStore: SessionStore | undefined;
	try {
		// The child's session starts with the parent's opus; its launch runs sonnet without saving a model change.
		const { parentId, running } = await launchForkedSonnetChild(cwd, "level1", {
			provider: "anthropic",
			id: "claude-opus-5",
		});
		const resumed = await resumeSqliteParent(cwd, parentId);
		resumedStore = resumed.store;
		const childSession = await SessionManager.open(resumedStore, running.childSessionId!, cwd);
		const level = await childSession.appendThinkingLevelChange("minimal");
		await appendChildTurns(childSession, "at minimal");
		await childSession.appendCompaction("The context was cleared.", null, 300, CONTEXT_CLEAR);
		await childSession.appendMessage({ role: "user", content: "after the clear", timestamp: Date.now() });
		const opened = await SessionManager.open(resumedStore, running.childSessionId!, cwd);
		await assertBeforeWindow(opened, [level]);
		assert.equal(opened.buildSessionContext().model?.modelId, "claude-opus-5", "the session still holds the copy");

		const results = await restoreOnHaiku(resumed.parent, resumedHost, "level1");
		assert.equal(results.length, 1);
		assert.match(results[0]!.model ?? "", /^anthropic\/claude-sonnet-5-5\b/);
		assert.equal(results[0]!.thinking, "minimal");
	} finally {
		await resumedHost.close("session-close");
		await resumedStore?.close();
		removeTempDirectory(cwd);
	}
});
