import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type { StageSessionCreateOptions } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { testRunId } from "../helpers/run-id.js";
import { makeTempDirectory, moduleDir, sleep, spawnSyncCollect } from "../helpers/runtime.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const directory = makeTempDirectory("sdk-run-intercom-");
const broker = new IntercomBrokerFixture(directory);
broker.overrideAgentDir();
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { existsSync } = await import("node:fs");
const { run, workflow } = await import("../../packages/workflows/src/sdk-surface.js");
const { createStore } = await import("../../packages/workflows/src/shared/store.js");
const clients: InstanceType<typeof IntercomClient>[] = [];

beforeAll(async () => {
	const extensionDir = join(moduleDir(import.meta.url), "../../packages/intercom");
	broker.trackBroker(
		spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
			env: { ...process.env, PI_CODING_AGENT_DIR: undefined },
			stdio: "ignore",
		}),
	);
	const deadline = Date.now() + 10_000;
	while (!existsSync(getBrokerSocketPath())) {
		broker.assertRunning();
		assert.ok(Date.now() < deadline, "local broker starts");
		await sleep(25);
	}
});
afterEach(async () => {
	for (const client of clients.splice(0)) await client.disconnect();
});
afterAll(() => broker.cleanup());

async function connectClient(group: string) {
	const client = new IntercomClient();
	clients.push(client);
	broker.onCleanup(() => client.disconnect());
	client.on("error", () => {});
	await client.connect({
		cwd: directory,
		model: "test",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		group,
	});
	return client;
}

async function connectStage(options: StageSessionCreateOptions) {
	const context = options.orchestrationContext;
	assert.ok(context?.kind === "workflow-stage");
	const delivery = context.pendingStageDelivery;
	assert.ok(delivery);
	const group = context.intercomGroup;
	assert.ok(group);
	const client = await connectClient(group);
	await client.registerLiveWorkflowStageRoute(
		context.workflowRunId,
		[context.workflowStageId, context.workflowStageName],
		delivery.routeCapability,
	);
	return { client, context, group, delivery };
}

const definition = workflow({
	name: "standalone-intercom",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.task("worker", { prompt: "List the workflow peers" });
		return {};
	},
});

for (const ending of ["completed", "failed", "cancelled"] as const) {
	test(`standalone ${ending} run registers Intercom authority before its task connects and releases it on return (#3863)`, async () => {
		const store = createStore();
		let listedStage = false;
		let observer: InstanceType<typeof IntercomClient> | undefined;
		const withEnding = workflow({
			...definition,
			async run(ctx) {
				await definition.run(ctx);
				if (ending === "failed") throw new Error("failed after Intercom task");
				if (ending === "cancelled") ctx.exit({ status: "cancelled" });
				return {};
			},
		});
		const result = await run(
			withEnding,
			{},
			{
				cwd: directory,
				store,
				journal: { memory: true },
				executionMode: "non_interactive",
				adapters: {
					agentSession: {
						async create(options) {
							const { client, context, group } = await connectStage(options);
							observer = await connectClient(group);
							return makeMockSession({
								async prompt() {
									await client.listDirectory();
									const listed = await observer!.listDirectory();
									listedStage = listed.workflowStages.some(
										(stage) => stage.runId === context.workflowRunId && stage.sessionId === client.sessionId,
									);
									return "listed";
								},
							}).session;
						},
					},
				},
			},
		);
		assert.equal(result.status, ending, result.error);
		assert.equal(listedStage, true);
		assert.ok(observer);
		assert.deepEqual((await observer.listDirectory()).workflowStages, []);
		const send = await observer.send(`workflow:${result.runId}/**`, { text: "after completion" });
		assert.equal(send.delivered, false);
		assert.equal(send.queued, undefined);
	});
}

test("ending one standalone run does not retire a concurrent run's Intercom owner (#3863)", async () => {
	const store = createStore();
	const firstId = testRunId("sdk-intercom-first");
	const secondId = testRunId("sdk-intercom-second");
	const firstStarted = Promise.withResolvers<void>();
	const secondStarted = Promise.withResolvers<void>();
	const finishFirst = Promise.withResolvers<void>();
	const finishSecond = Promise.withResolvers<void>();
	const secondDefinition = workflow({
		...definition,
		async run(ctx) {
			await definition.run(ctx);
			await ctx.task("later", { prompt: "Connect after the other run ended" });
			return {};
		},
	});
	const launch = (runId: string) =>
		run(
			runId === secondId ? secondDefinition : definition,
			{},
			{
				runId,
				cwd: directory,
				store,
				journal: { memory: true },
				adapters: {
					agentSession: {
						async create(options) {
							const { client, context } = await connectStage(options);
							return makeMockSession({
								async prompt() {
									await client.listDirectory();
									if (context.workflowStageName === "worker") {
										(runId === firstId ? firstStarted : secondStarted).resolve();
										await (runId === firstId ? finishFirst : finishSecond).promise;
									}
									return "done";
								},
							}).session;
						},
					},
				},
			},
		);
	const first = launch(firstId);
	const second = launch(secondId);
	try {
		await Promise.race([
			Promise.all([firstStarted.promise, secondStarted.promise]),
			...[first, second].map(async (execution) => {
				const result = await execution;
				assert.fail(`Run ended before its barrier: ${JSON.stringify(result)}`);
			}),
		]);
		const { Type } = await import("typebox");
		const needsInput = workflow({ ...definition, inputs: { required: Type.String() } });
		await assert.rejects(
			run(needsInput, {} as never, {
				runId: firstId,
				store,
				cwd: directory,
				journal: { memory: true },
			}),
			/required input/,
		);
		const firstObserver = await connectClient(`workflow:${firstId}`);
		assert.ok((await firstObserver.listDirectory()).workflowStages.some((stage) => stage.runId === firstId));
		finishFirst.resolve();
		assert.equal((await first).status, "completed");
		const observer = await connectClient(`workflow:${secondId}`);
		assert.ok((await observer.listDirectory()).workflowStages.some((stage) => stage.runId === secondId));
		finishSecond.resolve();
		assert.equal((await second).status, "completed");
		assert.deepEqual((await observer.listDirectory()).workflowStages, []);
	} finally {
		finishFirst.resolve();
		finishSecond.resolve();
		await Promise.allSettled([first, second]);
	}
});

test("standalone Intercom queues a future nested-stage send and settles it before returning (#3863)", async () => {
	const store = createStore();
	const rootId = testRunId("sdk-intercom-nested");
	const received: string[] = [];
	const child = workflow({ ...definition, name: "nested" });
	const parent = workflow({
		...definition,
		async run(ctx) {
			await definition.run(ctx);
			await ctx.workflow(child, { stageName: "nested" });
			return {};
		},
	});
	let observer: InstanceType<typeof IntercomClient> | undefined;
	const result = await run(
		parent,
		{},
		{
			runId: rootId,
			cwd: directory,
			store,
			journal: { memory: true },
			adapters: {
				agentSession: {
					async create(options) {
						const { client, context, group, delivery } = await connectStage(options);
						await delivery.deliverPending((_from, message) => {
							received.push(message.content.text);
						});
						return makeMockSession({
							async prompt() {
								await client.listDirectory();
								if (context.workflowRunId === rootId) {
									observer = await connectClient(group);
									const sent = await observer.send(`workflow:${rootId}/nested/worker`, {
										text: "nested instruction",
									});
									assert.equal(sent.queued, true, JSON.stringify(sent));
								}
								return "done";
							},
						}).session;
					},
				},
			},
		},
	);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(received, ["nested instruction"]);
	assert.ok(observer);
	assert.deepEqual((await observer.listDirectory()).workflowStages, []);
	assert.equal(store.runs().find((entry) => entry.id === rootId)?.pendingStageMessages?.[0]?.status, "delivered");
});

test("the default run() session adapter gives a stage working builtin Intercom (#3863)", async () => {
	const { fauxAssistantMessage, fauxToolCall, registerFauxProvider } = await import("@bastani/pi-ai/compat");
	const { Type } = await import("typebox");
	const { InMemoryCodingAgentModelsStore } = await import("../../packages/coding-agent/src/core/models-store.js");
	const { AuthStorage, ModelRuntime, SettingsManager } = await import("../../packages/coding-agent/src/index.js");
	const faux = registerFauxProvider();
	try {
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				cost: registered.cost,
			})),
		});
		let intercomResult: { isError?: boolean } | undefined;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("intercom", { action: "list" })], { stopReason: "toolUse" }),
			(context) => {
				intercomResult = context.messages.findLast((message) => message.role === "toolResult");
				return fauxAssistantMessage("done");
			},
		]);
		const definition = workflow({
			name: "default-adapter-intercom",
			description: "",
			inputs: {},
			outputs: { reply: Type.String() },
			async run(ctx) {
				const result = await ctx.task("lister", {
					prompt: "List the Intercom peers",
					model,
					modelRuntime,
					agentDir: join(directory, "agent"),
					settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
					builtins: { workflows: false, subagents: false, intercom: true, mcp: false, "web-access": false },
					tools: ["intercom"],
				});
				return { reply: result.text };
			},
		});
		const result = await run(definition, {}, { cwd: directory, journal: { memory: true }, store: createStore() });
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(result.result, { reply: "done" });
		assert.ok(intercomResult, "the intercom tool ran and its result reached the model");
		assert.notEqual(intercomResult.isError, true, JSON.stringify(intercomResult));
		assert.equal(faux.state.callCount, 2);
	} finally {
		faux.unregister();
	}
});

test("the bundled standalone SDK can start its own Intercom broker (#3863)", () => {
	const result = spawnSyncCollect(
		[process.execPath, join(moduleDir(import.meta.url), "../fixtures/workflow-sdk-intercom-standalone.mjs")],
		{
			env: { ...process.env, ATOMIC_CODING_AGENT_DIR: join(directory, "bundled"), PI_CODING_AGENT_DIR: undefined },
			timeout: 20_000,
		},
	);
	assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
});

test("SDK run reuses an extension's adopted-store Intercom owner (#3863)", async () => {
	const { adoptStore } = await import("../../packages/workflows/src/shared/store-factory.js");
	const { registerPendingStageIntercomBridge } = await import(
		"../../packages/workflows/src/extension/pending-stage-intercom.js"
	);
	const { createWorkflowRouteOwner } = await import("../../packages/intercom/workflow-route-owner.js");
	const previousScope = {};
	adoptStore(previousScope);
	const adopted = adoptStore({});
	const owner = createWorkflowRouteOwner(directory);
	const bridge = registerPendingStageIntercomBridge(owner, adopted);
	const runId = testRunId("adopted-sdk-intercom");
	try {
		const result = await run(
			definition,
			{},
			{
				runId,
				cwd: directory,
				journal: { memory: true },
				adapters: {
					agentSession: {
						async create(options) {
							const { client } = await connectStage(options);
							return makeMockSession({
								async prompt() {
									await client.listDirectory();
									return "done";
								},
							}).session;
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed", result.error);
		await bridge.flush();
		const observer = await connectClient(`workflow:${runId}`);
		const sent = await observer.send(`workflow:${runId}/**`, { text: "after SDK return" });
		assert.match(sent.reason ?? "", /terminated with status completed/);
	} finally {
		bridge();
		await owner.closeGroup(`workflow:${runId}`);
		adoptStore(previousScope);
	}
});

test("a standalone route owner reauthorizes notifications after disconnecting (#3863)", async () => {
	const { createWorkflowRouteOwner } = await import("../../packages/intercom/workflow-route-owner.js");
	const owner = createWorkflowRouteOwner(directory);
	const runId = testRunId("sdk-route-notification");
	const group = `workflow:${runId}`;
	const connections = vi.spyOn(IntercomClient.prototype, "connect");
	try {
		const route = {
			runId,
			group,
			capability: "notification-capability",
			stages: [],
			completion: undefined as Promise<void> | undefined,
		};
		owner.events.emit("atomic:workflow-pending-stage-route", route);
		await route.completion;
		const routeClient = connections.mock.instances[0];
		assert.ok(routeClient instanceof IntercomClient);
		await routeClient.disconnect();
		const receiver = await connectClient(group);
		const notices: string[] = [];
		receiver.on(
			"pending_stage_notification",
			(request: import("../../packages/intercom/broker/client.js").PendingStageNotificationRequest) => {
				notices.push(request.message.content.text);
				receiver.respondPendingStageNotification(request.requestId, true);
			},
		);
		const notice = {
			handled: false,
			completion: undefined as Promise<boolean> | undefined,
			runId,
			senderId: receiver.sessionId!,
			messageId: "queued-message",
			notificationId: "failed-notice",
			reason: "run ended",
		};
		owner.events.emit("atomic:workflow-pending-stage-undeliverable", notice);
		assert.equal(notice.handled, true);
		assert.equal(await notice.completion, true);
		assert.deepEqual(notices, ["Pending workflow stage could not receive intercom message: run ended"]);
	} finally {
		await owner.closeGroup(group);
		assert.ok(
			connections.mock.instances
				.filter((_, index) => connections.mock.calls[index]?.[0].recipientPurpose === "control")
				.every((client) => client instanceof IntercomClient && !client.isConnected()),
		);
		connections.mockRestore();
	}
});
