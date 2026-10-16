import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { AuthStorage, ModelRuntime, SessionManager, SettingsManager } from "../../packages/coding-agent/src/index.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import { requireStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import type { RunOpts, RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createWorkflowPendingStageDelivery } from "../../packages/workflows/src/runs/foreground/pending-stage-delivery.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { adoptStore, currentWorkflowStore, store } from "../../packages/workflows/src/shared/store-factory.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

interface StageRunOutcome {
	readonly status: string;
	readonly error?: string;
	readonly reply: RunResult<{ reply: string }>["result"];
	readonly callCount: number;
	readonly sessionFile: string | undefined;
}

/** Runs one faux-model `ctx.task` stage through `run()` with the given run options. */
async function runOneTaskStage(
	cwd: string,
	runOpts: (cwd: string) => RunOpts,
	stageOptions: { sessionDir?: string } = {},
): Promise<StageRunOutcome> {
	const faux = registerFauxProvider();
	try {
		const model = faux.getModel();
		faux.setResponses([fauxAssistantMessage("stage reply from the default adapter")]);
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
		let sessionFile: string | undefined = "unset";
		const def = workflow({
			name: "sdk-run-default-adapter",
			description: "One task stage with no caller-supplied adapters.",
			inputs: {},
			outputs: { reply: Type.String() },
			run: async (ctx) => {
				const result = await ctx.task("reply", {
					prompt: "say hello",
					model,
					modelRuntime,
					agentDir: join(cwd, "agent"),
					settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
					builtins: BUILTINS,
					tools: [],
					...stageOptions,
				});
				sessionFile = result.sessionFile;
				return { reply: result.text };
			},
		});

		const result = await run(def, {}, { ...runOpts(cwd), journal: { memory: true } });
		return {
			status: result.status,
			...(result.error !== undefined ? { error: result.error } : {}),
			reply: result.result,
			callCount: faux.state.callCount,
			sessionFile,
		};
	} finally {
		faux.unregister();
	}
}

test("run() executes a ctx.task stage without RunOpts.adapters (#3472)", async () => {
	const cwd = makeTempDirectory("atomic-sdk-run-default-adapter-");
	try {
		const outcome = await runOneTaskStage(cwd, (dir) => ({ cwd: dir }));

		assert.equal(outcome.status, "completed", outcome.error);
		assert.deepEqual(outcome.reply, { reply: "stage reply from the default adapter" });
		assert.equal(outcome.callCount, 1);
		assert.equal(outcome.sessionFile, undefined, "the default stage session must not persist to disk");
	} finally {
		removeTempDirectory(cwd);
	}
});

for (const [label, runOpts] of [
	["run() cwd", (dir: string): RunOpts => ({ cwd: dir })],
	[
		"createAgentSessionAdapter() cwd",
		(dir: string): RunOpts => ({ adapters: { agentSession: createAgentSessionAdapter({ cwd: dir }) } }),
	],
] as const) {
	test(`a sessionDir stage records the ${label}, not the host directory (#3472)`, async () => {
		const cwd = makeTempDirectory("atomic-sdk-run-default-adapter-cwd-");
		try {
			assert.notEqual(cwd, process.cwd());
			const outcome = await runOneTaskStage(cwd, runOpts, { sessionDir: join(cwd, "sessions") });

			assert.equal(outcome.status, "completed", outcome.error);
			assert.ok(outcome.sessionFile, "a sessionDir stage persists its session");
			assert.equal((await SessionManager.open(outcome.sessionFile)).getCwd(), cwd);
		} finally {
			removeTempDirectory(cwd);
		}
	});
}

async function runStandaloneStringModelStage(
	cwd: string,
	selectModel: (reference: string) => { model: string; fallbackModels?: string[] },
	runOpts: RunOpts = {},
) {
	const faux = registerFauxProvider({ models: [{ id: "sdk-reasoning", reasoning: true }] });
	try {
		const model = faux.getModel();
		let selectedModel: string | undefined;
		let reasoning: string | undefined;
		faux.setResponses([
			(_context, options, _state, selected) => {
				selectedModel = `${selected.provider}/${selected.id}`;
				reasoning = options?.reasoning;
				return fauxAssistantMessage("standalone reply");
			},
		]);
		const agentDir = join(cwd, "agent");
		await writeFileEnsuringDir(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[model.provider]: { baseUrl: model.baseUrl, apiKey: "faux-key", api: faux.api, models: faux.models },
				},
			}),
		);
		const reference = `${model.provider}/${model.id}`;
		const def = workflow({
			name: "sdk-standalone-string-model",
			description: "Resolve standalone stage model references.",
			inputs: {},
			outputs: { reply: Type.String() },
			run: async (ctx) => {
				const result = await ctx.task("reply", {
					...selectModel(reference),
					prompt: "Reply OK",
					agentDir,
					settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
					builtins: BUILTINS,
					tools: [],
				});
				return { reply: result.text };
			},
		});
		const result = await run(def, {}, { cwd, journal: { memory: true }, ...runOpts });
		return { result, reference, selectedModel, reasoning, callCount: faux.state.callCount };
	} finally {
		faux.unregister();
	}
}

test("standalone run() resolves a string stage model without an explicit runtime (#3629)", async () => {
	const cwd = makeTempDirectory("atomic-sdk-string-model-");
	try {
		const outcome = await runStandaloneStringModelStage(cwd, (model) => ({ model }));
		assert.equal(outcome.result.status, "completed", outcome.result.error);
		assert.deepEqual(outcome.result.result, { reply: "standalone reply" });
		assert.equal(outcome.selectedModel, outcome.reference);
		assert.equal(outcome.callCount, 1);
	} finally {
		removeTempDirectory(cwd);
	}
});

for (const fallback of [false, true]) {
	test(`standalone run() resolves ${fallback ? "fallback" : "primary"} model thinking suffixes (#3629)`, async () => {
		const cwd = makeTempDirectory("atomic-sdk-string-thinking-");
		try {
			const outcome = await runStandaloneStringModelStage(cwd, (reference) =>
				fallback
					? { model: "missing-provider/missing-model", fallbackModels: [`${reference}:high`] }
					: { model: `${reference}:high` },
			);
			assert.equal(outcome.result.status, "completed", outcome.result.error);
			assert.deepEqual(outcome.result.result, { reply: "standalone reply" });
			assert.equal(outcome.selectedModel, outcome.reference);
			assert.equal(outcome.reasoning, "high");
			assert.equal(outcome.callCount, 1);
		} finally {
			removeTempDirectory(cwd);
		}
	});
}

test("standalone SDK adapter reports an unavailable string model without a TypeError (#3629)", async () => {
	const cwd = makeTempDirectory("atomic-sdk-missing-model-");
	try {
		const adapter = createAgentSessionAdapter({ cwd });
		let modelError: Error | undefined;
		const outcome = await runStandaloneStringModelStage(cwd, () => ({ model: "missing-provider/missing-model" }), {
			adapters: {
				agentSession: {
					async create(options, meta) {
						try {
							return await adapter.create(options, meta);
						} catch (error) {
							if (error instanceof Error) modelError = error;
							throw error;
						}
					},
				},
			},
		});
		assert.equal(modelError?.name, "Error");
		assert.equal(modelError?.message, "Workflow stage model unavailable: missing-provider/missing-model");
		assert.equal(outcome.callCount, 0);
	} finally {
		removeTempDirectory(cwd);
	}
});

test("SDK run without an explicit store keeps its journal with the root in the adopted scope (#3674)", async () => {
	setDurableBackend(undefined);
	const cwd = makeTempDirectory("atomic-sdk-adopted-store-");
	const firstScope = {};
	const secondScope = {};
	const firstStore = adoptStore(firstScope);
	const firstRuns = structuredClone(firstStore.runs());
	const adoptedStore = adoptStore(secondScope);
	assert.notEqual(adoptedStore, firstStore);
	const delivered: string[] = [];
	try {
		const outcome = await runOneTaskStage(cwd, (dir) => {
			const adapter = createAgentSessionAdapter({ cwd: dir });
			return {
				cwd: dir,
				adapters: {
					agentSession: {
						async create(options, meta) {
							assert.ok(meta);
							const delivery = createWorkflowPendingStageDelivery(
								store,
								meta.runId,
								meta.stageId,
								meta.stageName,
							);
							// Intercom drains even an empty queue when the stage joins.
							await delivery.deliverPending((_from, message) => {
								delivered.push(message.id);
							});
							const backend = requireStoreDurableBackend(store, meta.runId);
							assert.equal(requireStoreDurableBackend(adoptedStore, meta.runId), backend);
							assert.equal(backend.getWorkflow(meta.runId)?.workflowId, meta.runId);
							const group = `workflow:${meta.runId}`;
							const queued = await store.queueStageMessage(
								{
									runId: meta.runId,
									stageKey: "reply",
									from: { id: "planner", name: "planner", group },
									message: {
										id: "adopted-instruction",
										timestamp: Date.now(),
										content: { text: "say hello" },
									},
									queuedAt: new Date().toISOString(),
								},
								group,
								group,
								backend,
							);
							assert.equal(queued?.ok, true);
							await delivery.deliverPending((_from, message) => {
								delivered.push(message.id);
							});
							assert.deepEqual(store.pendingStageMessagesFor(meta.runId, "reply"), []);
							return adapter.create(options, meta);
						},
					},
				},
			};
		});
		assert.equal(outcome.status, "completed", outcome.error);
		assert.deepEqual(outcome.reply, { reply: "stage reply from the default adapter" });
		assert.deepEqual(delivered, ["adopted-instruction"]);
		assert.equal(currentWorkflowStore(), adoptedStore);
		assert.equal(adoptedStore.runs().length, 1);
		assert.deepEqual(firstStore.runs(), firstRuns);
	} finally {
		adoptedStore.clear();
		adoptStore(firstScope);
		removeTempDirectory(cwd);
	}
});
