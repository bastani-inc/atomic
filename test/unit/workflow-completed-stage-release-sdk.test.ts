import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { AgentSessionAdapter } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

/** The SDK stage adapter over a faux model, with a count of how many real sessions it disposed. */
async function fauxSdkAdapter(
	cwd: string,
	replies: readonly string[],
): Promise<{
	readonly faux: ReturnType<typeof registerFauxProvider>;
	readonly agentSession: AgentSessionAdapter;
	disposals(): number;
}> {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	faux.setResponses(replies.map((reply) => fauxAssistantMessage(reply)));
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
	const sdkAdapter = createAgentSessionAdapter({
		cwd,
		agentDir: join(cwd, "agent"),
		model,
		modelRuntime,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		builtins: BUILTINS,
		tools: [],
	});
	let disposals = 0;
	return {
		faux,
		disposals: () => disposals,
		agentSession: {
			async create(...args) {
				const created = await sdkAdapter.create(...args);
				const session = "session" in created ? created.session : created;
				const dispose = session.dispose.bind(session);
				session.dispose = async () => {
					disposals += 1;
					await dispose();
				};
				return created;
			},
		},
	};
}

const oneStageWorkflow = workflow({
	name: "released-sdk-stage",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await ctx.stage("reply").prompt("say hello");
		return {};
	},
});

test("a completed stage backed by a real SDK session is released and reopens from its saved transcript (#3622)", async () => {
	const cwd = makeTempDirectory("atomic-released-stage-sdk-");
	const sessionStore = await resolveSessionStore(cwd, { agentDir: join(cwd, "agent"), settings: {} });
	const registry = createStageControlRegistry();
	const sdk = await fauxSdkAdapter(cwd, ["first reply", "follow-up reply"]);
	try {
		const adapters = { sessionStore, agentSession: sdk.agentSession };
		const store = createStore();

		const result = await run(
			oneStageWorkflow,
			{},
			{ cwd, adapters, stageControlRegistry: registry, store, journal: { memory: true } },
		);

		assert.equal(result.status, "completed", result.error);
		const runSnapshot = store.runs()[0]!;
		const stage = runSnapshot.stages[0]!;
		assert.equal(sdk.disposals(), 1, "the real session was disposed when the run ended");
		assert.equal(registry.get(runSnapshot.id, stage.id), undefined);
		assert.equal(sdk.faux.state.callCount, 1);

		const reopened = await ensurePostMortemStageHandle(runSnapshot.id, stage, { registry, adapters, cwd });
		assert.equal(reopened.ok, true);
		if (!reopened.ok) return;
		await reopened.handle.ensureAttached();
		assert.deepEqual(
			reopened.handle.messages.map((message) => message.role).filter((role) => role !== "system"),
			["user", "assistant"],
			"the reopened SDK session holds the saved conversation",
		);
		await reopened.handle.prompt("and again?");

		assert.equal(sdk.faux.state.callCount, 2);
		const saved = await sessionStore.load(stage.sessionId!);
		assert.deepEqual(
			saved.entries
				.flatMap((entry) => (entry.type === "message" ? [entry.message.role] : []))
				.filter((role) => role !== "system"),
			["user", "assistant", "user", "assistant"],
		);
		assert.equal(store.runs()[0]!.stages[0]!.status, "completed");
	} finally {
		await registry.clear();
		await sessionStore.close();
		sdk.faux.unregister();
		removeTempDirectory(cwd);
	}
});

test("a real SDK session that owns its store is kept, because disposing it would close the transcript (#3622)", async () => {
	const cwd = makeTempDirectory("atomic-owned-store-stage-sdk-");
	const registry = createStageControlRegistry();
	const sdk = await fauxSdkAdapter(cwd, ["first reply"]);
	try {
		const store = createStore();

		const result = await run(
			oneStageWorkflow,
			{},
			{
				cwd,
				adapters: { agentSession: sdk.agentSession },
				stageControlRegistry: registry,
				store,
				journal: { memory: true },
			},
		);

		assert.equal(result.status, "completed", result.error);
		const runSnapshot = store.runs()[0]!;
		assert.ok(registry.get(runSnapshot.id, runSnapshot.stages[0]!.id));
		assert.equal(sdk.disposals(), 0);
	} finally {
		await registry.clear();
		sdk.faux.unregister();
		removeTempDirectory(cwd);
	}
});
