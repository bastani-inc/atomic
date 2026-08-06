import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentSessionOptions, ExtensionContext } from "@bastani/atomic";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type {
	ExecutorDeps,
	SubagentExecutorRuntimeDeps,
} from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import { createStore, mockSession, run, workflow } from "./executor-shared.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function makeState(): ExecutorDeps["state"] {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function stageContext(
	cwd: string,
	orchestrationContext: NonNullable<CreateAgentSessionOptions["orchestrationContext"]>,
): ExtensionContext {
	const ui: Pick<ExtensionContext["ui"], "custom"> = {
		custom: async <T>() => undefined as T,
	};
	const modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable"> = {
		getAvailable: () => [],
	};
	const sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getSessionId" | "getLeafId"> = {
		getSessionFile: () => undefined,
		getSessionId: () => "workflow-stage-session",
		getLeafId: () => null,
	};
	return {
		cwd,
		mode: "tui",
		hasUI: false,
		ui: ui as ExtensionContext["ui"],
		model: undefined,
		scopedModels: [],
		modelRegistry: modelRegistry as ExtensionContext["modelRegistry"],
		sessionManager: sessionManager as ExtensionContext["sessionManager"],
		orchestrationContext,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} satisfies ExtensionContext;
}

test("a real foreground subagent inherits its workflow group and stays outside default chat", async () => {
	let stageOrchestrationContext: CreateAgentSessionOptions["orchestrationContext"];
	const definition = workflow({
		name: "subagent-invocation-group-inheritance",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("launcher", { prompt: "launch" });
			return {};
		},
	});
	const workflowResult = await run(
		definition,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						stageOrchestrationContext = options.orchestrationContext;
						return mockSession();
					},
				},
			},
		},
	);
	assert.equal(workflowResult.status, "completed");
	assert.ok(stageOrchestrationContext?.intercomGroup);

	const root = mkdtempSync(join(tmpdir(), "atomic-workflow-group-subagent-"));
	const childGroups: Array<string | undefined> = [];
	const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (_cwd, _agents, agent, task, options) => {
		childGroups.push(options.intercomGroup);
		return { agent, task, status: "ok", messages: [], usage, finalOutput: "done" };
	};
	const pi: Pick<ExecutorDeps["pi"], "events" | "getSessionName"> = {
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "workflow-stage",
	};
	try {
		const executor = createSubagentExecutor({
			pi: pi as ExecutorDeps["pi"],
			state: makeState(),
			config: { maxSubagentDepth: 2, parallel: { concurrency: 2, maxTasks: 10 } },
			asyncByDefault: false,
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
		const context = stageContext(root, stageOrchestrationContext);
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
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const workflowGroup = stageOrchestrationContext.intercomGroup;
	assert.deepEqual(childGroups, [workflowGroup, "child-group", "default"]);
	assert.ok(workflowGroup);
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
		["child", { socket: childSocket, info: sessionInfo("child", "workflow-child", workflowGroup) }],
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
		(socket, brokerMessage) => writes.push({ socket, message: brokerMessage }),
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

test("foreground chain children inherit the workflow group and keep explicit overrides", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-workflow-group-chain-"));
	const childGroups: Array<string | undefined> = [];
	const runSync: SubagentExecutorRuntimeDeps["runSync"] = async (_cwd, _agents, agent, task, options) => {
		childGroups.push(options.intercomGroup);
		return { agent, task, status: "ok", messages: [], usage, finalOutput: "done" };
	};
	const pi: Pick<ExecutorDeps["pi"], "events" | "getSessionName"> = {
		events: { on: () => () => {}, emit: () => {} },
		getSessionName: () => "workflow-stage",
	};
	try {
		const executor = createSubagentExecutor({
			pi: pi as ExecutorDeps["pi"],
			state: makeState(),
			config: { maxSubagentDepth: 2, parallel: { concurrency: 2, maxTasks: 10 } },
			asyncByDefault: false,
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
		const context = stageContext(root, {
			kind: "workflow-stage",
			workflowRunId: "root",
			workflowStageId: "launcher",
			workflowStageName: "launcher",
			intercomGroup: "workflow:root",
			constraints: { disableWorkflowTool: true, maxSubagentDepth: 2 },
		});
		const result = await executor.execute(
			"chain",
			{
				chain: [
					{ agent: "worker", task: "inherit" },
					{ agent: "worker", task: "default", group: "default" },
					{
						parallel: [
							{ agent: "worker", task: "parallel-set" },
							{ agent: "worker", task: "parallel-default", group: "default" },
						],
						group: "parallel-group",
					},
				],
			},
			new AbortController().signal,
			undefined,
			context,
		);
		assert.equal(result.isError, undefined);
		assert.deepEqual(childGroups, ["workflow:root", "default", "parallel-group", "default"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
