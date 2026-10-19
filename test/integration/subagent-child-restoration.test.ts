import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
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
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RECORD_TYPE,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.js";
import {
	recordReportedGoneSubagentChildren,
	restoreSubagentChild,
	restoreSubagentChildren,
	SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
	SUBAGENT_RESUME_CONTINUATION_PROMPT,
	type SubagentChildRestoreDeps,
	subagentChildRestoreNotices,
} from "../../packages/subagents/src/runs/foreground/subagent-child-restore.js";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.js";
import {
	type PiCodingAgentSdk,
	prepareAtomicStageSessionOptions,
} from "../../packages/workflows/src/extension/atomic-stage-session.js";
import { makeTempDirectory, removeTempDirectory, sleep } from "../helpers/runtime.js";

const RECORD_POLL_MS = 10;

function taskHost(owner: string): AgentTaskHost {
	return new AgentTaskHost({
		scope: { kind: "session", sessionId: `${owner}-${randomUUID()}` },
		authorizeLaunch() {},
	});
}
const RECORD_WAIT_MS = 5_000;

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

type OrchestrationContext = ExtensionContext["orchestrationContext"];

interface Parent {
	readonly sessionManager: SessionManager;
	readonly ctx: (host: AgentTaskHost) => ExtensionContext;
	readonly pi: SubagentChildRestoreDeps["pi"];
	readonly authorizations: string[];
	readonly awaitedPeers: Array<{ name: string; group?: string }>;
	readonly ownedRuns: string[];
}

function parentSession(
	cwd: string,
	orchestrationContext?: OrchestrationContext,
	sessionManager: SessionManager = SessionManager.inMemory(cwd),
): Parent {
	const authorizations: string[] = [];
	const awaitedPeers: Array<{ name: string; group?: string }> = [];
	const ownedRuns: string[] = [];
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
		},
	};
	const pi = {
		events,
		appendEntry: async (customType: string, data?: SubagentChildRecord) => {
			await sessionManager.appendCustomEntry(customType, data);
		},
		getSessionName: () => "parent-session",
	} as unknown as SubagentChildRestoreDeps["pi"];
	const boundary = orchestrationContext
		? {
				...orchestrationContext,
				messageAdmission: {
					boundary: {
						registerOwnedSubagentRun: (runId: string) => ownedRuns.push(runId),
					},
				},
			}
		: undefined;
	const ctx = (host: AgentTaskHost) =>
		({
			cwd,
			sessionManager,
			getAgentTaskHost: () => host,
			modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
			model: undefined,
			thinkingLevel: undefined,
			...(boundary ? { orchestrationContext: boundary } : {}),
		}) as unknown as ExtensionContext;
	return { sessionManager, ctx, pi, authorizations, awaitedPeers, ownedRuns };
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

async function waitForRecord(parent: Parent, state: SubagentChildRecord["state"]): Promise<SubagentChildRecord> {
	const deadline = Date.now() + RECORD_WAIT_MS;
	while (Date.now() < deadline) {
		const record = records(parent).find((candidate) => candidate.state === state);
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
) {
	const host = taskHost("parent-before-restart");
	const neverReleased = Promise.withResolvers<void>();
	const options: RunSyncOptions = {
		cwd,
		runId,
		index: 0,
		sessionDir: join(cwd, "children", runId),
		...(childSessionManager ? { sessionManager: childSessionManager } : {}),
		intercomSessionName: `subagent-worker-${runId}-1`,
		intercomGroup: group,
		orchestratorIntercomTarget: "parent-session",
	};
	const response = await runAgentTask({
		host,
		cwd,
		agents: [agent],
		agent: "worker",
		task: "original task",
		options,
		wait: { kind: "background" },
		recordChild: createSubagentChildRecordSink(parent.pi, parent.ctx(host)),
		runtime: {
			runSync: (...args) =>
				runSync(args[0], args[1], args[2], args[3], {
					...args[4],
					testSession: { output: "never", promptGate: neverReleased.promise, abortResolvesPrompt: true },
				}),
		},
	});
	assert.equal(response.kind, "admitted");
	const running = await waitForRecord(parent, "running");
	await host.close("session-close");
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
			wait: { kind: "background" },
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
		const transcript = readFileSync(original.childSessionFile, "utf8");
		assert.match(transcript, /original task/);
		assert.ok(transcript.includes(SUBAGENT_RESUME_CONTINUATION_PROMPT));
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
		assert.deepEqual(parent.authorizations, []);
		const [notice] = subagentChildRestoreNotices(outcomes);
		assert.match(notice!, /`subagent-worker-gone1-1` \(worker\) did not survive the restart/);
		assert.match(notice!, /It is gone: do not send it Intercom messages/);
	} finally {
		await resumedHost.close("session-close");
		removeTempDirectory(cwd);
	}
});

test("a resumed workflow stage restores its children in the run's invocation group (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-stage-");
	const rootRunId = "6c1f8b2e-7d3a-4e5f-9a1b-2c3d4e5f6a7b";
	const group = `workflow:${rootRunId}`;
	const resumedHost = taskHost("stage-after-restart");
	try {
		const parent = parentSession(cwd, {
			kind: "workflow-stage",
			workflowRunId: rootRunId,
			workflowStageId: "lane-id",
			workflowStageName: "lane",
			constraints: { disableWorkflowTool: true },
			intercomGroup: group,
		});
		const original = await launchInterruptedChild(cwd, parent, "stage1", group);
		assert.deepEqual(original.owner, {
			kind: "workflow-stage",
			sessionId: parent.sessionManager.getSessionId(),
			workflowRunId: rootRunId,
			workflowStageId: "lane-id",
			workflowStageName: "lane",
		});
		const launched: RunSyncOptions[] = [];
		const [outcome] = await restoreSubagentChildren(restoreDeps(parent, launched), parent.ctx(resumedHost));
		assert.equal(outcome?.kind, "restored");
		assert.deepEqual(parent.ownedRuns, ["stage1"]);
		assert.equal(launched[0]?.intercomGroup, group);
		assert.equal(launched[0]?.intercomSessionName, "subagent-worker-stage1-1");
		assert.equal(launched[0]?.workflowStageSubagentGuard, true);
		assert.deepEqual(parent.authorizations, ["subagent-worker-stage1-1"]);
		assert.deepEqual(parent.awaitedPeers, [{ name: "subagent-worker-stage1-1", group }]);
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

async function workflowStagePolicy(cwd: string): Promise<ExtensionContext["subagentPolicy"]> {
	const sdk = {
		getAgentDir: () => cwd,
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class {
			async reload() {}
		},
		createAgentSession: async () => {
			throw new Error("not used");
		},
	} as unknown as PiCodingAgentSdk;
	const options = await prepareAtomicStageSessionOptions({ cwd }, sdk);
	assert.ok(options?.subagentPolicy, "workflow stages carry a subagent policy");
	return options.subagentPolicy;
}

test("the subagents extension restores a resumed workflow stage's children despite its stage policy (#3760)", async () => {
	const cwd = makeTempDirectory("subagent-child-extension-stage-");
	const rootRunId = "0b6f6a77-5c1d-4f0e-8d3a-2b1c4d5e6f70";
	const group = `workflow:${rootRunId}`;
	const resumedHost = taskHost("stage-after-restart");
	try {
		const stage = parentSession(cwd, {
			kind: "workflow-stage",
			workflowRunId: rootRunId,
			workflowStageId: "coordinator-id",
			workflowStageName: "coordinator",
			constraints: { disableWorkflowTool: true },
			intercomGroup: group,
		});
		const original = await launchInterruptedChild(cwd, stage, "wfext1", group);
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
			getSessionName: () => "coordinator-stage",
		} as unknown as ExtensionAPI);
		const restore = handlers.get("session_recovery_restore");
		assert.ok(restore);
		const resumedStage = {
			...stage.ctx(resumedHost),
			subagentPolicy: await workflowStagePolicy(cwd),
		} as ExtensionContext;
		const result = await restore({ type: "session_recovery_restore", reason: "workflow_stage_resume" }, resumedStage);
		assert.equal(result?.notices?.length, 1, "the stage's interrupted child must go through restoration");
		assert.match(result!.notices![0]!, /`subagent-worker-wfext1-1` \(worker\) did not survive the restart/);
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

async function launchForkedSqliteChild(cwd: string, runId: string) {
	const store = await openDefaultStore(cwd);
	const parentManager = await SessionManager.create(store, cwd);
	await parentManager.appendMessage({ role: "user", content: "parent request", timestamp: Date.now() });
	const parent = parentSession(cwd, undefined, parentManager);
	const forked = await createForkContextResolver(parentManager, "fork").sessionManagerForIndex(0);
	assert.ok(forked);
	assert.equal(forked.getSessionFile(), undefined, "a SQLite child session has no session file");
	const running = await launchInterruptedChild(cwd, parent, runId, "lane-group", forked);
	await store.close();
	return { parentId: parentManager.getSessionId(), running };
}

async function resumeSqliteParent(cwd: string, parentId: string) {
	const store = await openDefaultStore(cwd);
	const parent = parentSession(cwd, undefined, await SessionManager.open(store, parentId, cwd));
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
		assert.deepEqual(resumed.parent.authorizations, []);
		assert.match(subagentChildRestoreNotices(outcomes)[0]!, /It is gone/);
	} finally {
		await resumedHost.close("session-close");
		await resumedStore?.close();
		removeTempDirectory(cwd);
	}
});
