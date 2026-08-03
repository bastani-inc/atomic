import assert from "node:assert/strict";
import type net from "node:net";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import { test } from "vitest";
import { DeliveredMessageCache } from "../../packages/intercom/broker/delivered-message-cache.js";
import { type BrokerConnectedSession, handleBrokerSend } from "../../packages/intercom/broker/send-handler.js";
import { SupervisorChannelCache } from "../../packages/intercom/broker/supervisor-channel.js";
import type { BrokerMessage, Message, SessionInfo } from "../../packages/intercom/types.js";
import { DbosDurableBackend } from "../../packages/workflows/src/durable/dbos-backend.js";
import { createMockSdk } from "./durable-dbos-backend-helpers.js";
import { createStore, mockSession, run, workflow } from "./executor-shared.js";

function capturedGroup(options: CreateAgentSessionOptions): string | undefined {
	return options.orchestrationContext?.intercomGroup;
}

test("stages in one workflow invocation share a non-default Intercom group", async () => {
	const groups: Array<string | undefined> = [];
	const definition = workflow({
		name: "shared-invocation-group",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("first", { prompt: "first" });
			await ctx.task("second", { prompt: "second" });
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						groups.push(capturedGroup(options));
						return mockSession();
					},
				},
			},
		},
	);

	assert.equal(result.status, "completed");
	assert.equal(groups.length, 2);
	assert.equal(groups[0], groups[1]);
	assert.notEqual(groups[0], undefined);
	assert.notEqual(groups[0], "default");
});

test("separate top-level workflow invocations receive different Intercom groups", async () => {
	const groups: string[] = [];
	const definition = workflow({
		name: "separate-invocation-groups",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("only", { prompt: "only" });
			return {};
		},
	});
	const options = {
		adapters: {
			agentSession: {
				async create(sessionOptions: CreateAgentSessionOptions) {
					const group = capturedGroup(sessionOptions);
					assert.ok(group);
					groups.push(group);
					return mockSession();
				},
			},
		},
	};

	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	assert.equal((await run(definition, {}, { ...options, store: createStore() })).status, "completed");
	assert.equal(groups.length, 2);
	assert.notEqual(groups[0], groups[1]);
});

test("explicit named and default stage groups override the workflow invocation group", async () => {
	const groups: Array<string | undefined> = [];
	const definition = workflow({
		name: "explicit-invocation-group-overrides",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("inherited", { prompt: "inherited" });
			await ctx.task("named", { prompt: "named", group: "reviewers" });
			await ctx.task("shared-default", { prompt: "default", group: "default" });
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						groups.push(capturedGroup(options));
						return mockSession();
					},
				},
			},
		},
	);

	assert.equal(result.status, "completed");
	assert.notEqual(groups[0], undefined);
	assert.notEqual(groups[0], "default");
	assert.deepEqual(groups.slice(1), ["reviewers", "default"]);
});

test("stages without Intercom access receive no group", async () => {
	const groups: Array<string | undefined> = [];
	const definition = workflow({
		name: "intercom-capability-gate",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("no-tools", { prompt: "none", noTools: "all" });
			await ctx.task("allowlist", { prompt: "allowlist", tools: ["read"] });
			await ctx.task("excluded", { prompt: "excluded", excludedTools: ["intercom"] });
			await ctx.task("extension-tools", { prompt: "intercom remains", noTools: "builtin" });
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						groups.push(capturedGroup(options));
						return mockSession();
					},
				},
			},
		},
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(groups.slice(0, 3), [undefined, undefined, undefined]);
	assert.ok(groups[3]);
	assert.notEqual(groups[3], "default");
});

test("nested workflow stages stay in the top-level invocation group", async () => {
	const groups: string[] = [];
	const child = workflow({
		name: "nested-group-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("child-stage", { prompt: "child" });
			return {};
		},
	});
	const parent = workflow({
		name: "nested-group-parent",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("parent-stage", { prompt: "parent" });
			await ctx.workflow(child);
			return {};
		},
	});

	const result = await run(
		parent,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						const group = capturedGroup(options);
						assert.ok(group);
						groups.push(group);
						return mockSession();
					},
				},
			},
		},
	);

	assert.equal(result.status, "completed");
	assert.equal(groups.length, 2);
	assert.equal(groups[0], groups[1]);
});

test("model fallback replacement sessions keep the workflow invocation group", async () => {
	const groups: string[] = [];
	const definition = workflow({
		name: "fallback-invocation-group",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("fallback-stage", {
				prompt: "run",
				model: "anthropic/primary",
				fallbackModels: ["openai/fallback"],
			});
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						const group = capturedGroup(options);
						assert.ok(group);
						groups.push(group);
						const model =
							typeof options.model === "string"
								? options.model
								: `${String(options.model?.provider)}/${String(options.model?.id)}`;
						return {
							...mockSession(),
							async prompt() {
								if (model === "anthropic/primary") throw new Error("429 rate limit exceeded");
							},
							getLastAssistantText() {
								return model === "openai/fallback" ? "done" : undefined;
							},
						};
					},
				},
			},
		},
	);

	assert.equal(result.status, "completed");
	assert.equal(groups.length, 2);
	assert.equal(groups[0], groups[1]);
});

test("fresh durable replay restores a nested stage to the top-level invocation group", async () => {
	const rootRunId = "durable-invocation-group-root";
	const sdk = createMockSdk();
	const firstBackend = new DbosDurableBackend(sdk, { executorId: "group-first" });
	const firstStore = createStore();
	const promptStarted = Promise.withResolvers<void>();
	const releasePrompt = Promise.withResolvers<void>();
	let initialGroup: string | undefined;

	const child = workflow({
		name: "durable-invocation-group-child",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("pending-child-stage", { prompt: "wait" });
			return {};
		},
	});
	const root = workflow({
		name: "durable-invocation-group-root",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.workflow(child);
			return {};
		},
	});

	const firstController = new AbortController();
	const firstPromise = run(
		root,
		{},
		{
			runId: rootRunId,
			store: firstStore,
			durableBackend: firstBackend,
			signal: firstController.signal,
			adapters: {
				agentSession: {
					async create(options) {
						initialGroup = capturedGroup(options);
						return {
							...mockSession(),
							async prompt() {
								promptStarted.resolve();
								await releasePrompt.promise;
							},
						};
					},
				},
			},
		},
	);
	await promptStarted.promise;
	await firstBackend.flush();
	const firstRoot = firstStore.runs().find((candidate) => candidate.id === rootRunId)!;
	const childBoundary = firstRoot.stages.find((stage) => stage.name === `workflow:${child.name}`)!;
	const firstChild = firstStore.runs().find((candidate) => candidate.parentStageId === childBoundary.id)!;
	assert.ok(initialGroup);
	assert.equal(initialGroup, `workflow:${rootRunId}`);

	const persisted = createMockSdk();
	for (const [key, value] of sdk.state.workflows) persisted.state.workflows.set(key, { ...value });
	for (const [key, value] of sdk.state.steps) persisted.state.steps.set(key, structuredClone(value));
	firstController.abort(new Error("first process stopped"));
	releasePrompt.resolve();
	await firstPromise;

	const captures: Array<{
		metaRunId?: string;
		workflowRunId?: string;
		intercomGroup?: string;
	}> = [];
	const freshBackend = new DbosDurableBackend(persisted, { executorId: "group-fresh" });
	await freshBackend.hydrateWorkflow(rootRunId);
	const resumed = await run(
		root,
		{},
		{
			runId: rootRunId,
			store: createStore(),
			durableBackend: freshBackend,
			adapters: {
				agentSession: {
					async create(options, meta) {
						captures.push({
							metaRunId: meta?.runId,
							workflowRunId: options.orchestrationContext?.workflowRunId,
							intercomGroup: capturedGroup(options),
						});
						return mockSession();
					},
				},
			},
		},
	);

	assert.equal(resumed.status, "completed", resumed.error);
	assert.deepEqual(captures, [
		{
			metaRunId: firstChild.id,
			workflowRunId: firstChild.id,
			intercomGroup: `workflow:${rootRunId}`,
		},
	]);
	assert.notEqual(captures[0]?.intercomGroup, `workflow:${firstChild.id}`);
});

test("parallel and per-task group overrides take precedence over the workflow group", async () => {
	const groups: string[] = [];
	const definition = workflow({
		name: "parallel-invocation-group-overrides",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.parallel(
				[
					{ name: "parallel-group", prompt: "parallel" },
					{ name: "task-default", prompt: "default", group: "default" },
				],
				{ group: "parallel-reviewers" },
			);
			return {};
		},
	});

	const result = await run(
		definition,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						const group = capturedGroup(options);
						assert.ok(group);
						groups.push(group);
						return mockSession();
					},
				},
			},
		},
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(groups.sort(), ["default", "parallel-reviewers"]);
});

test("ordinary workflow traffic cannot reach an unrelated shared-default main chat", async () => {
	let workflowGroup: string | undefined;
	const definition = workflow({
		name: "default-main-chat-isolation",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.task("sender", { prompt: "send" });
			return {};
		},
	});
	await run(
		definition,
		{},
		{
			store: createStore(),
			adapters: {
				agentSession: {
					async create(options) {
						workflowGroup = capturedGroup(options);
						return mockSession();
					},
				},
			},
		},
	);
	assert.ok(workflowGroup);

	const stageSocket = {} as net.Socket;
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
		["stage", { socket: stageSocket, info: sessionInfo("stage", "workflow-stage", workflowGroup) }],
		["main", { socket: mainSocket, info: sessionInfo("main", "main-chat") }],
	]);
	const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
	const message: Message = {
		id: "workflow-message",
		timestamp: 1,
		content: { text: "workflow-only notice" },
	};
	handleBrokerSend(
		stageSocket,
		{ type: "send", to: "main", message },
		"stage",
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
		writes.some((write) => write.socket === stageSocket && write.message.type === "delivery_failed"),
		true,
	);
});
