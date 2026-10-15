import { join } from "node:path";
import { describe, test } from "vitest";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import type { StageSessionCreateResult } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { WorkflowModelValidationError } from "../../packages/workflows/src/runs/shared/model-fallback.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";
import type {
	AgentSession,
	AgentSessionAdapter,
	InternalStageContext,
	StageSessionCreateOptions,
	WorkflowModelInfo,
} from "./stage-runner-helpers.js";
import { assert, createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

type SdkModel = NonNullable<StageSessionCreateOptions["model"]>;

function fakeModel(provider: string, id: string): SdkModel {
	return { provider, id, name: id } as unknown as SdkModel;
}

const HIGH = fakeModel("openai", "gpt-high");
const PLAIN = fakeModel("anthropic", "plain");
const catalog: readonly WorkflowModelInfo[] = [
	{ provider: "openai", id: "gpt-high", fullId: "openai/gpt-high", model: HIGH },
	{ provider: "anthropic", id: "plain", fullId: "anthropic/plain", model: PLAIN },
];

async function scopedModelsSentToSession(
	scopedModels: StageOptions["scopedModels"],
): Promise<{ created: StageSessionCreateOptions[]; error?: unknown }> {
	const created: StageSessionCreateOptions[] = [];
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			created.push(options);
			return makeMockSession({
				async prompt() {},
				getLastAssistantText: () => "done",
			}).session;
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { scopedModels },
			models: { listModels: async () => catalog },
		}),
	) as InternalStageContext;
	try {
		await ctx.prompt("go");
		return { created };
	} catch (error) {
		return { created, error };
	} finally {
		await ctx.__dispose();
	}
}

describe("stage scopedModels", () => {
	test("a model string with a reasoning suffix becomes a resolved model with that thinking level", async () => {
		const { created, error } = await scopedModelsSentToSession([{ model: "openai/gpt-high:high" }]);
		assert.equal(error, undefined);
		assert.deepEqual(created[0]?.scopedModels, [{ model: HIGH, thinkingLevel: "high" }]);
	});

	test("a model string without a suffix becomes a resolved model without a thinking level", async () => {
		const { created, error } = await scopedModelsSentToSession([{ model: "plain" }]);
		assert.equal(error, undefined);
		assert.deepEqual(created[0]?.scopedModels, [{ model: PLAIN }]);
	});

	test("a model object is forwarded as the resolved model", async () => {
		const { created, error } = await scopedModelsSentToSession([{ model: PLAIN }, { model: "openai/gpt-high:low" }]);
		assert.equal(error, undefined);
		assert.deepEqual(created[0]?.scopedModels, [{ model: PLAIN }, { model: HIGH, thinkingLevel: "low" }]);
	});

	test("an unknown model fails with the same validation error as an unknown primary model", async () => {
		const scoped = await scopedModelsSentToSession([{ model: "missing-model:high" }]);
		assert.ok(scoped.error instanceof WorkflowModelValidationError);
		assert.match(scoped.error.message, /missing-model:high \(not available\)/);
		assert.equal(scoped.created.length, 0, "no session may start with an unresolved scoped model");
	});

	test("provider-qualified scoped model strings resolve through the stage model runtime", async () => {
		const cwd = makeTempDirectory("atomic-stage-scoped-models-");
		const agentDir = join(cwd, "agent");
		await writeFileEnsuringDir(
			join(agentDir, "auth.json"),
			JSON.stringify({ custom: { type: "api_key", key: "test" } }),
		);
		await writeFileEnsuringDir(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					custom: {
						baseUrl: "http://localhost:1/v1",
						api: "openai-completions",
						models: [
							{
								id: "catalog-model",
								name: "Catalog",
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 10000,
								maxTokens: 1000,
							},
						],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const catalogModel = runtime.getModel("custom", "catalog-model");
		assert.ok(catalogModel);
		let factoryCalls = 0;
		const adapters = buildRuntimeAdapters(
			{
				getChildSessionOptions: (options) => ({
					cwd,
					agentDir,
					modelRuntime: runtime,
					settingsManager: SettingsManager.inMemory(),
					sessionManager: SessionManager.inMemory(cwd),
					builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
					tools: [],
					model: catalogModel,
					...options,
				}),
			},
			{
				createAgentSession: async (options) => {
					factoryCalls++;
					return (await createAgentSession(options)) as StageSessionCreateResult;
				},
			},
		);
		const stageScoped = (models: readonly { model: string; thinkingLevel?: "high" }[]) =>
			({ scopedModels: models }) as unknown as StageSessionCreateOptions;
		try {
			const result = await adapters.agentSession!.create(
				stageScoped([{ model: "custom/catalog-model", thinkingLevel: "high" }, { model: "custom/catalog-model" }]),
			);
			const session = ("session" in result ? result.session : result) as unknown as AgentSession;
			try {
				assert.deepEqual(session.scopedModels, [
					{ model: catalogModel, thinkingLevel: "high" },
					{ model: catalogModel },
				]);
			} finally {
				await session.dispose();
			}
			await assert.rejects(
				adapters.agentSession!.create(stageScoped([{ model: "custom/missing-model" }])),
				/Workflow stage model unavailable: custom\/missing-model/,
			);
			assert.equal(factoryCalls, 1, "an unavailable scoped model must fail before session creation");
		} finally {
			removeTempDirectory(cwd);
		}
	});
});
