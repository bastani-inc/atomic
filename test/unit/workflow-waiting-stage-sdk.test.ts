import assert from "node:assert/strict";
import { join } from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import {
	AuthStorage,
	ModelRuntime,
	SettingsManager,
	type ToolDefinition,
} from "../../packages/coding-agent/src/index.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import type { StageLifecycleEvent } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const STAGES = 6;
/**
 * Structural cost: six stages run on the real `AgentSession` runtime with the SQLite session store, which loads the
 * model runtime and tool registry per stage, and the test forces collections to count the released sessions.
 */
const REAL_AGENT_SESSION_TIMEOUT_MS = 120_000;

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();

/** Collect until finalizers that the collections scheduled have run. */
async function collectFully(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A detachable tool whose calls end only when the test finishes them. */
function waitForCi(): { readonly tool: ToolDefinition; readonly pending: Map<string, () => void>; calls: number } {
	const pending = new Map<string, () => void>();
	const state = {
		pending,
		calls: 0,
		tool: {
			name: "wait_for_ci",
			label: "Wait for CI",
			description: "Waits for the CI run of the change",
			parameters: Type.Object({}),
			detachable: true,
			execute: (toolCallId: string) => {
				state.calls += 1;
				return new Promise<AgentToolResult>((resolve) => {
					pending.set(toolCallId, () =>
						resolve({ content: [{ type: "text", text: "ci passed" }], details: undefined }),
					);
				});
			},
		} satisfies ToolDefinition,
	};
	return state;
}

test(
	"real SDK stages waiting on a detachable tool release their sessions and continue the same turn (#4309)",
	async () => {
		const cwd = makeTempDirectory("atomic-waiting-stage-sdk-");
		const faux = registerFauxProvider();
		const sessionStore = await resolveSessionStore(cwd, { agentDir: join(cwd, "agent"), settings: {} });
		try {
			const model = faux.getModel();
			faux.setResponses(
				Array.from(
					{ length: 2 * STAGES },
					() => (context: { messages: readonly { role: string }[] }) =>
						context.messages.at(-1)?.role === "toolResult"
							? fauxAssistantMessage("ci passed; merging")
							: fauxAssistantMessage([fauxToolCall("wait_for_ci", {})], { stopReason: "toolUse" }),
				),
			);
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
			const ci = waitForCi();
			const sdkAdapter = createAgentSessionAdapter({
				cwd,
				agentDir: join(cwd, "agent"),
				model,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
				builtins: BUILTINS,
				tools: ["wait_for_ci"],
			});
			let live = 0;
			let liveWhileWaiting: number | undefined;
			let collected = 0;
			let collectedWhileWaiting: number | undefined;
			const sessions = new FinalizationRegistry<number>(() => {
				collected += 1;
			});
			const events: StageLifecycleEvent[] = [];
			const allWaiting = Promise.withResolvers<void>();
			const store = createStore();
			const definition = workflow({
				name: "waiting-stage-sdk",
				description: "",
				inputs: {},
				outputs: {},
				run: async (ctx) => {
					const tasks = Array.from({ length: STAGES }, (_, index) =>
						ctx.task(`stage-${index}`, { prompt: `ship change ${index}`, customTools: [ci.tool] }),
					);
					await allWaiting.promise;
					liveWhileWaiting = live;
					await collectFully();
					collectedWhileWaiting = collected;
					for (const finish of ci.pending.values()) finish();
					await Promise.all(tasks);
					return {};
				},
			});

			const result = await run(
				definition,
				{},
				{
					cwd,
					store,
					journal: { memory: true },
					releaseWhenWaiting: { afterMs: 0 },
					onStageLifecycleEvent: (_runId, event) => {
						events.push(event);
						if (events.filter((candidate) => candidate.type === "stage_waiting").length === STAGES)
							allWaiting.resolve();
					},
					adapters: {
						sessionStore,
						agentSession: {
							async create(...args) {
								const created = await sdkAdapter.create(...args);
								const session = "session" in created ? created.session : created;
								live += 1;
								sessions.register(session, live);
								const dispose = session.dispose.bind(session);
								session.dispose = async () => {
									live -= 1;
									await dispose();
								};
								return created;
							},
						},
					},
				},
			);

			assert.equal(result.status, "completed", result.error);
			assert.equal(liveWhileWaiting, 0, "no stage kept a live session while it waited");
			// Nothing keeps a waiting stage's disposed session reachable: its whole object graph is gone, not only closed.
			assert.equal(collectedWhileWaiting, STAGES, "every released session was garbage collected");
			assert.equal(ci.calls, STAGES);
			assert.equal(faux.state.callCount, 2 * STAGES);
			for (const stage of store.runs()[0]!.stages) {
				const saved = await sessionStore.load(stage.sessionId!);
				const roles = saved.entries
					.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []))
					.filter((role) => role !== "system");
				assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"], stage.name);
				assert.equal(stage.result, "ci passed; merging");
			}
			assert.equal(events.filter((event) => event.type === "stage_rehydrated").length, STAGES);
		} finally {
			await sessionStore.close();
			faux.unregister();
			removeTempDirectory(cwd);
		}
	},
	REAL_AGENT_SESSION_TIMEOUT_MS,
);
