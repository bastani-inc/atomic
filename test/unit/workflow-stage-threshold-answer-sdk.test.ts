import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/atomic-ai/compat";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.js";
import { AuthStorage, ModelRuntime, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUILTINS = { subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const CONTEXT_WINDOW = 10_000;
const RESERVE_TOKENS = 1_000;
/** About 9,500 tokens: the faux provider reports usage from what it was sent, so the answer crosses the trigger. */
const LARGE_PROMPT = `review the change\n${"word ".repeat(7_600)}`;
const PREVIOUS_ANSWER = "PREVIOUS-STAGE-ANSWER";
const CURRENT_ANSWER = "CURRENT-FINAL-ANSWER";

test("a workflow stage whose answer crosses the compaction threshold returns that answer, not the previous stage's", async () => {
	const cwd = makeTempDirectory("atomic-stage-threshold-answer-");
	const faux = registerFauxProvider({ models: [{ id: "small-window", contextWindow: CONTEXT_WINDOW }] });
	const sessionStore = await resolveSessionStore(cwd, { agentDir: join(cwd, "agent"), settings: {} });
	try {
		const model = faux.getModel();
		faux.setResponses([fauxAssistantMessage(PREVIOUS_ANSWER), fauxAssistantMessage(CURRENT_ANSWER)]);
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
		const agentSession = createAgentSessionAdapter({
			cwd,
			agentDir: join(cwd, "agent"),
			model,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({
				retry: { enabled: false },
				compaction: { enabled: true, reserveTokens: RESERVE_TOKENS },
			}),
			builtins: BUILTINS,
			tools: [],
		});
		const answers: string[] = [];
		const definition = workflow({
			name: "threshold-answer-stage",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				answers.push(await ctx.stage("plan").prompt("plan the change"));
				answers.push(await ctx.stage("review").prompt(LARGE_PROMPT));
				return {};
			},
		});

		const result = await run(
			definition,
			{},
			{ cwd, store: createStore(), journal: { memory: true }, adapters: { sessionStore, agentSession } },
		);

		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(answers, [PREVIOUS_ANSWER, CURRENT_ANSWER]);
		assert.equal(faux.state.callCount, 2, "the stages made one request each");
	} finally {
		await sessionStore.close();
		faux.unregister();
		removeTempDirectory(cwd);
	}
});
