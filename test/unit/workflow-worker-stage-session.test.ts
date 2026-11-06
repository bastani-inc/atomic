import assert from "node:assert/strict";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { PendingStageMessage } from "../../packages/workflows/src/shared/store-types.js";
import { workerStageAdapter } from "../../packages/workflows/src/workers/pooled-stage-delivery.js";
import type { WorkerDeliver } from "../../packages/workflows/src/workers/protocol.js";
import { RemoteStageInbox } from "../../packages/workflows/src/workers/remote-stage-inbox.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";
import {
	type AgentSessionAdapter,
	createStageContext,
	type InternalStageContext,
	makeOpts,
} from "./stage-runner-helpers.js";

useTemporaryAgentDir();

const ROOT = "worker-stage-session-root";
/** The stage `makeOpts` runs. */
const STAGE = { runId: "run-xyz", stageId: "stage-abc", stageName: "My Stage" };

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

function answer(model: { api: AssistantMessage["api"]; provider: string; id: string }) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

/**
 * The adapter a worker's base adapter stands for: it creates a real `AgentSession` and, as Intercom's extension does
 * when the session starts, drains the stage's pending-stage delivery into `sink` under the session's own id.
 */
function realSessionAdapter(sink: WorkerDeliver, sessions: StageSessionRuntime[]): AgentSessionAdapter {
	return {
		async create(options) {
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory({ p: { type: "api_key", key: "x" } }),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider("p", {
				api: "openai-completions",
				baseUrl: "https://example.invalid",
				apiKey: "x",
				models: [spec],
				streamSimple: (model) => answer(model),
			});
			const { session } = await createAgentSession({
				cwd: process.cwd(),
				agentDir: process.cwd(),
				builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
				modelRuntime,
				model: modelRuntime.getModel("p", "m")!,
				settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
				sessionManager: options.sessionManager ?? SessionManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
				orchestrationContext: options.orchestrationContext,
			});
			const runtime = session as unknown as StageSessionRuntime;
			await options.orchestrationContext?.pendingStageDelivery?.deliverPending(sink, {
				sessionId: runtime.sessionId,
				receivedMessageIds: [],
			});
			sessions.push(runtime);
			// The shape the Atomic adapter returns a session in.
			return { session: runtime };
		},
	};
}

test("a real stage session a worker created on another host leaves its attempt's inbox when the stage closes it (#4505)", async () => {
	const store = createStore();
	store.recordRunStart({
		id: STAGE.runId,
		name: "child",
		inputs: {},
		status: "running",
		startedAt: 0,
		stages: [{ id: STAGE.stageId, name: STAGE.stageName, status: "running", parentIds: [], toolEvents: [] }],
		toolNodes: [],
	});
	const queued: PendingStageMessage = {
		id: "before-start",
		runId: STAGE.runId,
		stageKey: STAGE.stageId,
		from: { id: "sender-id", name: "sender" },
		message: { id: "before-start", timestamp: 1, content: { text: "before start" } },
		queuedAt: new Date(1).toISOString(),
		admissionOrder: 1,
		status: "queued",
	};
	const inbox = new RemoteStageInbox();
	const received: string[] = [];
	const sessions: StageSessionRuntime[] = [];
	const adapter = workerStageAdapter({
		base: realSessionAdapter((_from, message) => {
			received.push(message.id);
		}, sessions),
		store,
		inbox,
		shared: { host: "host-b", routes: false },
		request: async () => undefined,
		published: () => undefined,
		journal: {
			getWorkflow: (id: string) => (id === ROOT ? { pendingStageMessages: [queued] } : undefined),
			listCheckpoints: () => [],
			catchUpWorkflow: async () => {},
		} as never,
		root: ROOT,
	});
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession: adapter },
			stageOptions: { model: "p/m" },
			pendingStageDelivery: { deliverPending: async () => {}, ready: () => undefined, fail: () => {} },
		}),
	) as InternalStageContext;
	try {
		assert.equal(await ctx.prompt("go"), "ok");
		const [session] = sessions;
		assert.ok(session !== undefined);
		assert.ok(Object.hasOwn(session, "dispose"), "the real session closes through the worker's own dispose");
		assert.deepEqual(store.run(STAGE.runId)?.stages[0]?.intercomReceipts, {
			sessionId: session.sessionId,
			messageIds: ["before-start"],
		});
		const stage = { runId: STAGE.runId, stageId: STAGE.stageId };
		const sender = { id: "sender-id", name: "sender" } as Parameters<WorkerDeliver>[0];
		const message = (id: string) => ({ id, timestamp: 2, content: { text: id } }) as Parameters<WorkerDeliver>[1];
		assert.deepEqual(await inbox.deliver(stage, session.sessionId, sender, message("live")), {});
		assert.deepEqual(received, ["before-start", "live"]);
		await ctx.__dispose();
		const closed = await inbox.deliver(stage, session.sessionId, sender, message("after-close"));
		assert.equal(closed.error?.code, "intercom_unavailable", "the closed session's sink is gone from the inbox");
		assert.deepEqual(received, ["before-start", "live"]);
	} finally {
		await ctx.__dispose();
	}
});
