import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, onTestFinished, test } from "vitest";
import type { IntercomClient as Client } from "../../packages/intercom/broker/client.js";
import type { Message, SessionInfo } from "../../packages/intercom/types.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { openCompletedDurableWorkflow } from "../../packages/workflows/src/durable/completed-inspection.js";
import { createPostMortemHandleResolver } from "../../packages/workflows/src/extension/postmortem-deps.js";
import { registerReleasedStageIntercomRoutes } from "../../packages/workflows/src/extension/released-stage-intercom-route.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import { createPersistedStageFixture } from "../unit/persisted-stage-fixture.js";

const broker = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "stage-chat-continuity-")));
broker.overrideAgentDir();
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { ReleasedStagePeers } = await import("../../packages/intercom/released-stage-peers.js");

// The source broker compiles its modules before accepting connections.
const BROKER_START_TIMEOUT_MS = 90_000;
beforeAll(() => broker.startSourceBroker(BROKER_START_TIMEOUT_MS), BROKER_START_TIMEOUT_MS + 5_000);
afterAll(() => broker.cleanup());

async function connect(group: string) {
	const client = new IntercomClient();
	const now = Date.now();
	await client.connect(
		{
			cwd: broker.agentDir,
			model: "test",
			pid: process.pid,
			startedAt: now,
			lastActivity: now,
			group,
			groups: [group],
		},
		undefined,
		undefined,
		undefined,
		group,
	);
	onTestFinished(() => client.disconnect());
	return client;
}

const definition = workflow({
	name: "stage-chat-continuity",
	description: "",
	inputs: {},
	outputs: {},
	async run(ctx) {
		await ctx.task("review", { prompt: "review the change" });
		return {};
	},
});

test("inspecting a completed run keeps new questions in its open stage chat answerable (#5577)", async () => {
	const runId = randomUUID(),
		group = `workflow:${runId}`;
	const registry = createStageControlRegistry(),
		store = createStore();
	const stageUiBroker = new StageUiBroker(store);
	const durableBackend = await createMemoryTestBackend();
	let stageId = "";
	const asked = Promise.withResolvers<void>();
	const fixture = createPersistedStageFixture({
		reply: () => "done",
		async onPrompt(text, record) {
			if (text !== "ask me a question") return;
			record.emit({
				type: "tool_execution_start",
				toolName: "ask_user_question",
				toolCallId: "direction",
				args: {
					questions: [
						{ question: "Which way?", header: "Direction", options: [{ label: "Left" }, { label: "Right" }] },
					],
				},
			});
			const answer = stageUiBroker.requestCustomUi(runId, stageId, () => ({ render: () => [] }));
			asked.resolve();
			record.emit({
				type: "tool_execution_end",
				toolName: "ask_user_question",
				toolCallId: "direction",
				result: await answer,
				isError: false,
			});
		},
	});
	// Inspection recognizes the live SDK session by its manager's store and transcript ID.
	const adapter = fixture.adapters.agentSession!;
	const create = adapter.create.bind(adapter);
	adapter.create = async (...args) =>
		Object.assign(await create(...args), {
			sessionManager: args[0].sessionManager,
			state: { messages: [] },
			modelRuntime: {},
			getContextUsage: () => undefined,
		});
	const deps = { store, adapters: fixture.adapters, stageControlRegistry: registry, durableBackend, stageUiBroker };
	const sender = await connect(group),
		peer = await connect(group);
	let close: (() => void) | undefined, turn: Promise<void> | undefined;
	try {
		const result = await run(
			definition,
			{},
			{
				...deps,
				runId,
				onStageStart(id, stage) {
					stageId = stage.id;
					close = registry.peek(id, stage.id)!.subscribe(() => {});
				},
			},
		);
		assert.equal(result.status, "completed");
		const held = registry.peek(runId, stageId)!;
		assert.equal((await openCompletedDurableWorkflow(runId, deps)).ok, true);
		assert.equal(registry.peek(runId, stageId), held);
		peer.once("message", (_from: SessionInfo, message: Message) => {
			peer.acknowledgeReceived(message.id);
			turn = held.prompt(message.content.text);
		});
		assert.equal((await sender.send(peer.sessionId!, { text: "ask me a question" })).delivered, true);
		await asked.promise;
		assert.equal(stageUiBroker.answerStagePrompt(runId, stageId, { optionLabels: ["Left"] }), true);
		await turn;
	} finally {
		stageUiBroker.cancelStagePrompt(runId, stageId, new Error("test ended"));
		await turn?.catch(() => {});
		close?.();
		await registry.clear();
	}
});

async function releasedStage(onPrompt?: (text: string) => Promise<void>) {
	const runId = randomUUID(),
		group = `workflow:${runId}`;
	const store = createStore(),
		registry = createStageControlRegistry();
	const fixture = createPersistedStageFixture({ reply: (text) => `answer: ${text.split("\n")[2] ?? text}`, onPrompt });
	const host = new IntercomClient();
	const peers = new ReleasedStagePeers({
		prepare: async () => {},
		createClient: () => host,
		cwd: () => broker.agentDir,
		relay: () => {},
	});
	const adoptions: Promise<void>[] = [],
		releasedAgain = Promise.withResolvers<void>();
	const stop = registerReleasedStageIntercomRoutes(
		{
			events: {
				emit: (_, route) => {
					const adopted = peers.adopt(route);
					adoptions.push(adopted);
					if (adoptions.length === 2) releasedAgain.resolve(adopted);
				},
			},
		},
		registry,
		store,
		createPostMortemHandleResolver({
			store,
			stageControlRegistry: registry,
			adapters: fixture.adapters,
			resolveDefaultStageSessionDir: () => undefined,
		}),
	);
	onTestFinished(async () => {
		stop();
		await registry.clear();
		await Promise.all(adoptions);
		await peers.disconnectAll();
	});
	assert.equal(
		(await run(definition, {}, { runId, store, adapters: fixture.adapters, stageControlRegistry: registry })).status,
		"completed",
	);
	await Promise.all(adoptions);
	const asker = await connect(group);
	const listed = () =>
		asker
			.listSessions(group)
			.then((sessions) => sessions.find((session) => session.status === "closed · reply: post-mortem only"));
	const before = await listed();
	assert.ok(before);
	return { fixture, host, asker, group, id: before.id, releasedAgain: releasedAgain.promise, listed };
}

async function ask(client: Client, to: string, text: string) {
	const messageId = randomUUID(),
		response = Promise.withResolvers<Message>();
	const receive = (_from: SessionInfo, message: Message) => {
		if (message.replyTo === messageId) response.resolve(message);
	};
	client.on("message", receive);
	try {
		assert.equal((await client.send(to, { text, messageId, expectsReply: true })).delivered, true);
		return (await response.promise).content.text;
	} finally {
		client.off("message", receive);
	}
}

test("two clients can ask the same released stage at its listed ID while the first turn is open (#5577)", async () => {
	const started = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>();
	const stage = await releasedStage(async (text) => {
		if (text.includes("first?")) {
			started.resolve();
			await finish.promise;
		}
	});
	const other = await connect(stage.group);
	const first = ask(stage.asker, stage.id, "first?");
	await started.promise;
	const received = Promise.withResolvers<void>();
	stage.host.once("hosted_message", () => received.resolve());
	const second = ask(other, stage.id, "second?");
	try {
		await received.promise;
	} finally {
		finish.resolve();
	}
	assert.deepEqual(await Promise.all([first, second]), ["answer: first?", "answer: second?"]);
	const messages = stage.fixture.sessions.at(-1)!.session.messages;
	assert.deepEqual(
		messages.filter((m) => m.role === "user").map((m) => String(m.content).split("\n")[2]),
		[undefined, "first?", "second?"],
	);
});

test("releasing the stage after a reply keeps its original listed ID reachable (#5577)", async () => {
	const stage = await releasedStage();
	assert.equal(await ask(stage.asker, stage.id, "still there?"), "answer: still there?");
	await stage.releasedAgain;
	const sent = await stage.asker.send(stage.id, { text: "thanks" });
	assert.equal(sent.delivered, true, sent.reason);
	assert.equal((await stage.listed())?.id, stage.id);
});
