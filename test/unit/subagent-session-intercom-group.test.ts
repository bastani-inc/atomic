import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { runSync as runInProcessSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function makeState(): ExecutorDeps["state"] {
	return {
		baseCwd: "",
		currentSessionId: null,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
	};
}

function parentContext(cwd: string, group: string): ExtensionContext {
	const ui: Pick<ExtensionContext["ui"], "custom"> = {
		custom: async <T>() => undefined as T,
	};
	const modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable"> = {
		getAvailable: () => [],
	};
	const sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getSessionId" | "getLeafId"> = {
		getSessionFile: () => undefined,
		getSessionId: () => "parent-session",
		getLeafId: () => null,
	};
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		hasHumanInput: false,
		ui: ui as ExtensionContext["ui"],
		model: undefined,
		scopedModels: [],
		modelRegistry: modelRegistry as ExtensionContext["modelRegistry"],
		sessionManager: sessionManager as ExtensionContext["sessionManager"],
		subagentPolicy: {
			managementActions: "full",
			fanoutAuthorized: true,
			inheritProjectContext: false,
			inheritSkills: false,
			intercomGroup: group,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		sessionSignal: new AbortController().signal,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getDecisionModel: () => "",
		observeWorkflowActivity: () => ({ dispose() {} }),
	} satisfies ExtensionContext;
}

test("a real foreground subagent inherits its parent’s group and stays outside default chat", async () => {
	const parentGroup = "review-team";
	const root = mkdtempSync(join(tmpdir(), "atomic-session-group-subagent-"));
	const childGroups: Array<string | undefined> = [];
	const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (_cwd, _agents, agent, task, options) => {
		childGroups.push(options.intercomGroup);
		return { agent, task, status: "ok", messages: [], usage, finalOutput: "done" };
	};
	const pi: Pick<ExecutorDeps["pi"], "events" | "getSessionName"> = {
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "parent-session",
	};
	try {
		const executor = createSubagentExecutor({
			pi: pi as ExecutorDeps["pi"],
			state: makeState(),
			config: { parallel: { concurrency: 2, maxTasks: 10 } },
			tempArtifactsDir: join(root, "artifacts"),
			getSubagentSessionRoot: () => join(root, "sessions"),
			expandTilde: (path) => path,
			discoverAgents: () => ({
				agents: [
					{
						name: "worker",
						description: "test worker",
						systemPromptMode: "replace",
						inheritProjectContext: false,
						inheritSkills: false,
						systemPrompt: "work",
						source: "project",
						filePath: join(root, "worker.md"),
					},
				],
			}),
			runtime: { runSync },
		});
		const context = parentContext(root, parentGroup);
		for (const params of [
			{ agent: "worker", task: "inherit" },
			{ agent: "worker", task: "named", group: "child-group" },
			{ agent: "worker", task: "default", group: "default" },
		] as const) {
			const result = await executor.execute(
				"subagent-call",
				params,
				new AbortController().signal,
				undefined,
				context,
			);
			assert.equal(result.isError, undefined);
		}
		const parallelResult = await executor.execute(
			"parallel-call",
			{
				tasks: [
					{ agent: "worker", task: "parallel inherited" },
					{ agent: "worker", task: "parallel default", group: "default" },
				],
				group: "parallel-group",
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(parallelResult.isError, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	assert.deepEqual(childGroups, [parentGroup, "child-group", "default", "parallel-group", "default"]);
	const childSocket = {} as net.Socket;
	const mainSocket = {} as net.Socket;
	const sessionInfo = (id: string, name: string, group?: string): SessionInfo => ({
		id,
		name,
		group,
		cwd: "/tmp",
		model: "test",
		pid: 1,
		startedAt: 1,
		lastActivity: 1,
	});
	const sessions = new Map<string, BrokerConnectedSession>([
		["child", { socket: childSocket, info: sessionInfo("child", "team-child", parentGroup) }],
		["main", { socket: mainSocket, info: sessionInfo("main", "main-chat") }],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const message: Message = { id: "child-notice", timestamp: 1, content: { text: "subagent result" } };
	handleBrokerSend(
		childSocket,
		{ type: "send", to: "main", message },
		"child",
		sessions,
		new DeliveredMessageCache(),
		(socket, brokerMessage) => {
			writes.push({ socket, message: brokerMessage });
			return true;
		},
		new SupervisorChannelCache(),
	);
	assert.equal(
		writes.some((write) => write.socket === mainSocket && write.message.type === "message"),
		false,
	);
	assert.equal(
		writes.some((write) => write.socket === childSocket && write.message.type === "delivery_failed"),
		true,
	);
});

test("in-process child resolves intercom group through typed admission without an env bridge", async () => {
	const previousGroup = process.env.ATOMIC_INTERCOM_GROUP;
	process.env.ATOMIC_INTERCOM_GROUP = "ambient-group";
	const dir = mkdtempSync(join(tmpdir(), "atomic-session-group-inprocess-"));
	try {
		const agent = {
			name: "worker",
			description: "test worker",
			systemPromptMode: "replace" as const,
			inheritProjectContext: false,
			inheritSkills: false,
			systemPrompt: "work",
			source: "project" as const,
			filePath: join(dir, "worker.md"),
		};
		const result = await runInProcessSync(dir, [agent], "worker", "work", {
			cwd: dir,
			runId: "inprocess-group",
			intercomGroup: "review-team",
			testSession: { output: "done" },
		});
		assert.equal(result.status, "ok");
		assert.equal(result.finalOutput, "done");
		assert.equal(process.env.ATOMIC_INTERCOM_GROUP, "ambient-group");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		if (previousGroup === undefined) delete process.env.ATOMIC_INTERCOM_GROUP;
		else process.env.ATOMIC_INTERCOM_GROUP = previousGroup;
	}
});
