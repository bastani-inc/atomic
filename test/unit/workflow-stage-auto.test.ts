import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools } from "@bastani/pi-ai";
import { convertResponsesTools } from "@bastani/pi-ai/api/openai-responses-shared";
import { Compile } from "typebox/compile";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import classifyAndAct from "../../packages/workflows/builtin/classify-and-act.js";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { decodeToCheckpoint, encodeCheckpoint } from "../../packages/workflows/src/durable/dbos-envelope.js";
import { setDurableBackend } from "../../packages/workflows/src/durable/factory.js";
import {
	createDurableStagePrimitive,
	recordStageSessionCheckpoint,
} from "../../packages/workflows/src/durable/stage-primitive.js";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import {
	decisionMessage,
	decisionModel,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";
import { createStore, run, structuredOutputMockSession, Type, workflow } from "./executor-shared.js";
import { createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setDurableBackend(undefined);
});

interface ClassifierWireRequest {
	model: string;
	state: Record<string, unknown>;
	questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
}

function classifierWireResponse(request: ClassifierWireRequest) {
	return {
		answers: Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => {
				const keys = Object.keys(question.criteria);
				return [
					id,
					{
						type: "choice",
						choice: keys[0],
						confidence: 1,
						probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
					},
				];
			}),
		),
	};
}

async function fixture() {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const infer = vi.fn<Parameters<typeof registeredDecisionRuntime>[0]>(() =>
		messageStream(decisionMessage({ model: "decision-test/chat", effort: null })),
	);
	const { registry, runtime: decisionRuntime } = await registeredDecisionRuntime(infer);
	const models = workflowModelCatalogFromContext({
		model: decisionModel,
		modelRegistry: registry,
		getRouterModel: () => "decision-test/chat",
	});
	const admissions: string[] = [];
	const store = createStore();
	const adapters = {
		agentSession: {
			async create(options: import("./stage-runner-helpers.js").StageSessionCreateOptions) {
				admissions.push(
					typeof options.model === "string" ? options.model : `${options.model?.provider}/${options.model?.id}`,
				);
				return makeMockSession({
					model: options.model,
					async prompt() {
						return "done";
					},
					getLastAssistantText: () => "done",
				}).session;
			},
		},
	};
	return { infer, modelRegistry: registry, decisionRuntime, models, admissions, store, adapters };
}

test("builtin child workflow routes every default stage through the real executor and router", async () => {
	const f = await fixture();
	const cwd = mkdtempSync(join(tmpdir(), "atomic-builtin-auto-execution-"));
	try {
		const parent = workflow({
			name: "builtin-auto-parent",
			description: "Compose a builtin without choosing its models",
			outputs: {},
			run: async (ctx) => {
				const child = await ctx.workflow(classifyAndAct, {
					inputs: { prompt: "Inspect the parser", categories: ["analysis"], confidence_threshold: 0.75 },
				});
				assert.equal(child.exited, false);
				assert.equal(child.outputs.category, "analysis");
				assert.equal(
					JSON.parse(readFileSync(child.outputs.classification_path!, "utf8")).selected_category,
					"analysis",
				);
				return {};
			},
		});
		const result = await run(
			parent,
			{},
			{
				...f,
				cwd,
				adapters: {
					agentSession: {
						async create(options) {
							f.admissions.push(
								typeof options.model === "string"
									? options.model
									: `${options.model?.provider}/${options.model?.id}`,
							);
							const session = structuredOutputMockSession(
								{ customTools: options.customTools },
								{ category: "analysis", confidence: 1, rationale: "Read-only inspection" },
							);
							return { ...session, model: options.model, thinkingLevel: "off" as const };
						},
					},
				},
			},
		);
		assert.equal(result.status, "completed", result.error);
		assert.deepEqual(f.admissions, ["decision-test/chat", "decision-test/chat"]);
		assert.equal(f.infer.mock.calls.length, 2);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("public stage auto uses actual prompt and shipped evals before admission", async () => {
	const f = await fixture();
	const def = workflow({
		name: "auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const stage = ctx.stage("not the task", { model: "auto" });
			assert.equal(f.admissions.length, 0);
			await stage.prompt("  Solve this actual task verbatim.  ");
			return {};
		},
	});
	const result = await run(def, {}, f);
	assert.equal(result.status, "completed", result.error);
	assert.deepEqual(f.admissions, ["decision-test/chat"]);
	assert.equal(f.infer.mock.calls.length, 1);
	assert.deepEqual(f.store.runs()[0]?.stages[0]?.routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(f.store.runs()[0]?.stages[0]?.model, "decision-test/chat");
	const state = JSON.parse(
		f.infer.mock.calls[0]![1].messages.find((message) => message.role === "user")!.content as string,
	).state;
	assert.equal(state.task, "  Solve this actual task verbatim.  ");
	assert.deepEqual(state.agent, { name: "not the task", description: "Workflow stage" });
	assert.deepEqual(Object.keys(state).sort(), ["agent", "evals", "model_selection_guide", "task"]);
	assert.equal(state.policy, undefined);
	assert.equal(state.evidence, undefined);
	assert.match(state.evals, /# Evals/);
	assert.match(state.evals, /top 26 catalog models/);
	assert.equal(state.evals, readFileSync("packages/coding-agent/docs/models/evals.md", "utf8"));
	assert.match(state.model_selection_guide, /^## Benchmarks are evidence, not policy\n/);
	assert.match(state.model_selection_guide, /## Role-based thinking effort/);
	assert.ok(Buffer.byteLength(JSON.stringify(state)) < 30_000);
});

test("long stage prompts are excerpted only for routing, never for execution", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	const task = `Review this implementation.\n${"reference ".repeat(20_000)}\n<keepContext>Read-only review.</keepContext>\nReport defects.`;
	const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		assert.match(String(url), /\/systemone$/);
		const body = JSON.parse(String(init?.body)) as ClassifierWireRequest;
		assert.ok(Buffer.byteLength(String(init?.body)) < 30_000);
		assert.equal(body.model, "jev-latest");
		assert.match(String(body.state.task), /omitted/);
		assert.match(String(body.state.task), /<keepContext>Read-only review.<\/keepContext>/);
		return Response.json(classifierWireResponse(body));
	});
	vi.stubGlobal("fetch", transport);
	const models = workflowModelCatalogFromContext({
		model: decisionModel,
		modelRegistry: f.modelRegistry,
		getRouterModel: () => "typesafe/jev-latest",
	});
	const executed: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			models,
			stageOptions: { model: "auto" },
			adapters: {
				agentSession: {
					async create(options) {
						return makeMockSession({
							model: options.model,
							async prompt(text) {
								executed.push(text);
								return "done";
							},
							getLastAssistantText: () => "done",
						}).session;
					},
				},
			},
		}),
	);
	try {
		await ctx.prompt(task);
		assert.deepEqual(executed, [task]);
		assert.equal(transport.mock.calls.length, 1);
		assert.equal(f.infer.mock.calls.length, 0);
	} finally {
		await ctx.__dispose();
	}
});

test("malformed stage decision admits no execution session without a current chat model", async () => {
	const f = await fixture();
	// No catalog currentModel: the total-routing failure stays fatal (#3206).
	f.models = workflowModelCatalogFromContext({
		modelRegistry: f.modelRegistry,
		getRouterModel: () => "decision-test/chat",
	});
	f.infer.mockImplementation(() => messageStream(decisionMessage({ model: "decision-test/chat", effort: "high" })));
	const def = workflow({
		name: "invalid-auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("task", { model: "auto" }).prompt("Solve task");
			return {};
		},
	});
	const result = await run(def, {}, f);
	assert.equal(result.status, "failed");
	assert.equal(f.admissions.length, 0);
	assert.equal(f.infer.mock.calls.length, 4);
});

test("auto stage total routing failure runs on the current chat model (#3206)", async () => {
	const f = await fixture();
	f.infer.mockImplementation(() => {
		throw new Error("mock router outage");
	});
	const def = workflow({
		name: "degraded-auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("task", { model: "auto" }).prompt("Solve task");
			return {};
		},
	});
	const result = await run(def, {}, f);
	assert.equal(result.status, "completed");
	assert.deepEqual(f.admissions, ["decision-test/chat"]);
	assert.equal(f.infer.mock.calls.length, 1);
});

for (const [allowed, status, admissions] of [
	["decision-test/chat", "completed", ["decision-test/chat"]],
	["second-provider/other", "failed", []],
] as const) {
	test(`auto stage total routing failure with allowedModels=${allowed} ${status === "completed" ? "degrades to" : "never runs"} the current chat model (#3206)`, async () => {
		const f = await fixture();
		vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([
			decisionModel,
			{ ...decisionModel, provider: "second-provider", id: "other" },
		]);
		f.infer.mockImplementation(() => {
			throw new Error("mock router outage");
		});
		const def = workflow({
			name: "constrained-degraded-auto",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx
					.stage("task", { model: "auto", modelConstraints: { allowedModels: [allowed] } })
					.prompt("Solve task");
				return {};
			},
		});
		const result = await run(def, {}, f);
		// A provider-classified routing failure blocks the stage; the run stays resumable.
		if (status === "completed") assert.equal(result.status, "completed");
		else {
			assert.notEqual(result.status, "completed");
			assert.equal(result.stages[0]?.status, "failed");
		}
		assert.deepEqual(f.admissions, [...admissions]);
		assert.equal(f.infer.mock.calls.length, 1);
	});
}

test("auto stage malformed routing decisions degrade to the current chat model (#3206)", async () => {
	const f = await fixture();
	f.infer.mockImplementation(() => messageStream(decisionMessage({ model: "decision-test/chat", effort: "high" })));
	const def = workflow({
		name: "degraded-malformed-auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("task", { model: "auto" }).prompt("Solve task");
			return {};
		},
	});
	const result = await run(def, {}, f);
	assert.equal(result.status, "completed");
	assert.deepEqual(f.admissions, ["decision-test/chat"]);
	assert.equal(f.infer.mock.calls.length, 4);
});

test("chain and parallel inherit auto and route expanded previous context", async () => {
	const f = await fixture();
	const def = workflow({
		name: "composed-auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			const results = await ctx.chain(
				[
					{ name: "first", prompt: "First task" },
					{ name: "second", prompt: "Use {previous}" },
				],
				{ model: "auto" },
			);
			assert.deepEqual(
				results.map((r) => r.routerSelection),
				[
					{ model: "decision-test/chat", effort: null },
					{ model: "decision-test/chat", effort: null },
				],
			);
			await ctx.parallel(
				[
					{ name: "third", prompt: "Third task", previous: "Provided context" },
					{ name: "fourth", prompt: "Fourth task" },
				],
				{ model: "auto", concurrency: 2 },
			);
			return {};
		},
	});
	const result = await run(def, {}, f);
	assert.equal(result.status, "completed", result.error);
	const tasks = f.infer.mock.calls.map(
		(call) => JSON.parse(call[1].messages.find((message) => message.role === "user")!.content as string).state.task,
	);
	assert.deepEqual(tasks.slice(0, 2), ["First task", "Use done"]);
	assert.deepEqual(tasks.slice(2).sort(), ["Third task\n\n---\nContext:\nProvided context", "Fourth task"].sort());
	assert.equal(f.admissions.length, 4);
});

test("caller constraints cannot widen inherited parallel restrictions", async () => {
	const f = await fixture();
	const def = workflow({
		name: "constraints-auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.parallel(
				[{ name: "task", prompt: "Task", modelConstraints: { allowedModels: ["decision-test/chat"] } }],
				{ model: "auto", modelConstraints: { allowedModels: [] } },
			);
			return {};
		},
	});
	assert.equal((await run(def, {}, f)).status, "failed");
	assert.equal(f.infer.mock.calls.length, 0);
	assert.equal(f.admissions.length, 0);
});

for (const model of [undefined, "decision-test/chat"] as const) {
	test(`non-auto stage ${model} keeps ordinary admission without routing`, async () => {
		const f = await fixture();
		const def = workflow({
			name: "concrete",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("task", { model }).prompt("Task");
				return {};
			},
		});
		assert.equal((await run(def, {}, f)).status, "completed");
		assert.equal(f.infer.mock.calls.length, 0);
		assert.equal(f.admissions.length, 1);
	});
}

test("auto stage cancellation during decision admits no child", async () => {
	const f = await fixture();
	const controller = new AbortController();
	f.infer.mockImplementation((_model, _context, options) => {
		assert.ok(options?.signal);
		controller.abort();
		return messageStream(decisionMessage({ model: "decision-test/chat", effort: null }));
	});
	const def = workflow({
		name: "cancel-auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.stage("task", { model: "auto" }).prompt("Task");
			return {};
		},
	});
	assert.notEqual((await run(def, {}, { ...f, signal: controller.signal })).status, "completed");
	assert.equal(f.admissions.length, 0);
});

test("stale catalog and explicit unsupported effort fail before admission", async () => {
	for (const stale of [false, true]) {
		const f = await fixture();
		if (stale)
			f.infer.mockImplementation(() => {
				vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([]);
				return messageStream(decisionMessage({ model: "decision-test/chat", effort: null }));
			});
		const def = workflow({
			name: "stale-auto",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx
					.stage("task", { model: "auto", ...(stale ? {} : { thinkingLevel: "high" as const }) })
					.prompt("Task");
				return {};
			},
		});
		assert.equal((await run(def, {}, f)).status, "failed");
		assert.equal(f.admissions.length, 0);
		assert.equal(f.infer.mock.calls.length, stale ? 1 : 0);
	}
});

test("reusing an auto stage session makes only one decision and retains selected metadata", async () => {
	const f = await fixture();
	const ctx = createStageContext(
		makeOpts({ adapters: f.adapters, models: f.models, stageOptions: { model: "auto" } }),
	);
	await ctx.__ensureSession();
	assert.equal(f.admissions.length, 0);
	await ctx.prompt("Actual task");
	await ctx.prompt("Next prompt");
	assert.equal(f.infer.mock.calls.length, 1);
	assert.deepEqual(ctx.__modelFallbackMeta().routerSelection, { model: "decision-test/chat", effort: null });
	await ctx.__dispose();
});

test("restored verified selection revalidates without inference; stale restored selection never reroutes", async () => {
	for (const model of ["decision-test/chat", "missing/model"]) {
		const f = await fixture();
		const ctx = createStageContext(
			makeOpts({
				adapters: f.adapters,
				models: f.models,
				stageOptions: { model: "auto", routerSelection: { model, effort: null } },
			}),
		);
		if (model === "decision-test/chat") await ctx.prompt("Resume");
		else await assert.rejects(ctx.prompt("Resume"), /no longer eligible/);
		assert.equal(f.infer.mock.calls.length, 0);
		assert.equal(f.admissions.length, model === "decision-test/chat" ? 1 : 0);
		await ctx.__dispose();
	}
});

test("model-dependent pre-prompt operations do not fabricate auto tasks; setModel is deliberate", async () => {
	const f = await fixture();
	const ctx = createStageContext(
		makeOpts({ adapters: f.adapters, models: f.models, stageOptions: { model: "auto" } }),
	);
	await assert.rejects(ctx.compact(), /requires prompt text/);
	await ctx.setModel(decisionModel);
	assert.equal(f.admissions.length, 1);
	assert.equal(f.infer.mock.calls.length, 0);
	await ctx.__dispose();
});

test("credential-bearing task is rejected before deciding inference without leaking the task", async () => {
	const f = await fixture();
	const secret = "sk-123456789012345678901234567890";
	const ctx = createStageContext(
		makeOpts({ adapters: f.adapters, models: f.models, stageOptions: { model: "auto" } }),
	);
	await assert.rejects(
		ctx.prompt(`Use ${secret}`),
		(error: Error) => !error.message.includes(secret) && /credential material/.test(error.message),
	);
	assert.equal(f.infer.mock.calls.length, 0);
	assert.equal(f.admissions.length, 0);
	await ctx.__dispose();
});

test("stage decisions survive the actual strict Responses schema conversion", async () => {
	const f = await fixture();
	const ctx = createStageContext(
		makeOpts({ adapters: f.adapters, models: f.models, stageOptions: { model: "auto" } }),
	);
	await ctx.prompt("Actual task");
	const tool = getCurrentTools(f.infer.mock.calls[0]![1].messages)[0]!;
	const converted = convertResponsesTools([tool], { strict: true })[0]!;
	assert.equal(converted.type, "function");
	if (converted.type !== "function") throw new Error("Expected function");
	for (const validator of [Compile(tool.parameters), Compile(converted.parameters as typeof tool.parameters)]) {
		assert.equal(validator.Check({ model: "decision-test/chat", effort: null }), true);
		for (const invalid of [
			{ model: "decision-test/chat" },
			{ model: "decision-test/chat", effort: "off" },
			{ model: "decision-test/chat", effort: null, extra: 1 },
		])
			assert.equal(validator.Check(invalid), false);
	}
	assert.equal(f.infer.mock.calls.length, 1);
	await ctx.__dispose();
});

test("reasoning fallback preserves explicit and inherited efforts and immutable selection", async () => {
	for (const suffix of ["", ":low"]) {
		const f = await fixture();
		const primary = {
			...decisionModel,
			id: "primary",
			reasoning: true,
			thinkingLevelMap: { high: "high", low: "low", off: null, minimal: null, medium: null, xhigh: null, max: null },
		};
		const fallback = { ...primary, id: "fallback" };
		vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([decisionModel, primary, fallback]);
		f.infer.mockImplementation((_model, context) => {
			const { questions } = JSON.parse(
				context.messages.find((message) => message.role === "user")!.content as string,
			);
			const candidates = Object.values(questions.pair.criteria).map((entry) => JSON.parse(entry as string));
			const model = candidates.some((pair) => pair.model === "decision-test/primary")
				? "decision-test/primary"
				: "decision-test/fallback";
			return messageStream(decisionMessage({ model, effort: "high" }));
		});
		const efforts: string[] = [];
		const ctx = createStageContext(
			makeOpts({
				models: f.models,
				stageOptions: {
					model: "auto",
					fallbackModels: [`decision-test/fallback${suffix}`],
					modelConstraints: { allowedEfforts: ["high", "low"] },
				},
				adapters: {
					agentSession: {
						async create(options) {
							efforts.push(options.thinkingLevel!);
							assert.equal(options.isFallbackModelAllowed?.(fallback, "off"), false);
							assert.equal(options.isFallbackModelAllowed?.(fallback, "high"), true);
							return makeMockSession({
								model: options.model,
								thinkingLevel: options.thinkingLevel!,
								async prompt() {
									if (options.model?.id === "primary") throw new Error("429 rate limit");
									return "done";
								},
								getLastAssistantText: () => "done",
							}).session;
						},
					},
				},
			}),
		);
		await ctx.prompt("Prove correctness");
		assert.deepEqual(efforts, ["high", "high"]);
		assert.deepEqual(ctx.__modelFallbackMeta().routerSelection, {
			model: "decision-test/primary",
			effort: "high",
			fallbacks: [{ model: "decision-test/fallback", effort: "high" }],
		});
		assert.equal(ctx.__modelFallbackMeta().model, "decision-test/fallback");
		assert.equal(f.infer.mock.calls.length, 2);
		await ctx.__dispose();
	}
});

for (const auth of ["stored", "env"] as const) {
	test(`stage auto routes through an explicit registered classifier with ${auth} auth without classifier execution`, async () => {
		const f = await fixture();
		const key = "synthetic-stage-jev-key";
		if (auth === "env") vi.stubEnv("TYPESAFE_API_KEY", key);
		else await f.decisionRuntime.saveCredential("typesafe", { type: "api_key", key });
		const classify = vi.spyOn(f.modelRegistry, "classify");
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
			const body = JSON.parse(String(init?.body)) as ClassifierWireRequest;
			assert.equal(JSON.stringify(body).includes(key), false);
			return Response.json(classifierWireResponse(body));
		});
		vi.stubGlobal("fetch", fetch);
		const models = workflowModelCatalogFromContext({
			model: decisionModel,
			modelRegistry: f.modelRegistry,
			getRouterModel: () => "typesafe/jev-latest",
		});
		const ctx = createStageContext(makeOpts({ adapters: f.adapters, models, stageOptions: { model: "auto" } }));
		await ctx.prompt("Actual task");
		assert.deepEqual(f.admissions, ["decision-test/chat"]);
		assert.equal(classify.mock.calls.length, 1);
		assert.equal(classify.mock.calls[0]?.[0].id, "jev-latest");
		assert.equal(f.infer.mock.calls.length, 0);
		assert.equal(fetch.mock.calls.length, 1);
		await ctx.__dispose();
	});
}

for (const routerModel of ["", "auto"]) {
	test(`stage auto with routerModel=${JSON.stringify(routerModel)} routes on the current chat model even with classifier credentials`, async () => {
		const f = await fixture();
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-stage-jev-key");
		await f.decisionRuntime.saveCredential("typesafe", { type: "api_key", key: "synthetic-stored-jev-key" });
		const classify = vi.spyOn(f.modelRegistry, "classify");
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const models = workflowModelCatalogFromContext({
			model: decisionModel,
			modelRegistry: f.modelRegistry,
			getRouterModel: () => routerModel,
		});
		const ctx = createStageContext(makeOpts({ adapters: f.adapters, models, stageOptions: { model: "auto" } }));
		await ctx.prompt("Actual task");
		assert.deepEqual(f.admissions, ["decision-test/chat"]);
		assert.equal(classify.mock.calls.length, 0);
		assert.equal(fetch.mock.calls.length, 0);
		assert.equal(f.infer.mock.calls.length, 1);
		await ctx.__dispose();
	});
}

test("stage auto sends stored classifier auth to the session's configured TypeSafe classifier endpoint", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const dir = mkdtempSync(join(tmpdir(), "workflow-stage-jev-endpoint-"));
	try {
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { typesafe: { baseUrl: "https://proxy.example/v1" } } }));
		const runtime = await ModelRuntime.create({
			modelsPath,
			credentials: AuthStorage.inMemory(),
			refreshOnCreate: false,
		});
		runtime.registerProvider(decisionModel.provider, {
			api: decisionModel.api,
			baseUrl: decisionModel.baseUrl,
			apiKey: "mock-chat-secret",
			models: [decisionModel],
			streamSimple: () => messageStream(decisionMessage({ model: "decision-test/chat", effort: null })),
		});
		const key = "synthetic-stored-proxy-jev-key";
		await runtime.saveCredential("typesafe", { type: "api_key", key });
		const modelRegistry = new ModelRegistry(runtime);
		assert.equal(modelRegistry.getClassifierModel("typesafe", "jev-latest")?.baseUrl, "https://proxy.example/v1");
		const endpoints: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				endpoints.push(String(url));
				assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
				return Response.json(classifierWireResponse(JSON.parse(String(init?.body)) as ClassifierWireRequest));
			}),
		);
		const models = workflowModelCatalogFromContext({
			model: decisionModel,
			modelRegistry,
			getRouterModel: () => "typesafe/jev-latest",
		});
		assert.ok(models?.routeModel);
		const route = await models.routeModel({ task: "Actual task", stageName: "analyze", constraints: [] });
		assert.equal(route.routerSelection.model, "decision-test/chat");
		assert.ok(endpoints.length > 0);
		assert.deepEqual([...new Set(endpoints)], ["https://proxy.example/v1/systemone"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("durable session checkpoint roundtrip restores selection without another inference", async () => {
	const f = await fixture();
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({ workflowId: "auto", name: "auto", inputs: {}, createdAt: 1, status: "running" });
	const selection = { model: "decision-test/chat", effort: null };
	await recordStageSessionCheckpoint(
		{ backend, workflowId: "auto", nextCheckpointId: () => "cp", nextReplayKey: () => "stage:test" },
		{
			id: "s",
			name: "task",
			status: "running",
			parentIds: [],
			toolEvents: [],
			replayKey: "stage:test",
			sessionFile: "/synthetic/session.jsonl",
			routerSelection: selection,
			model: "different/actual",
		},
	);
	const checkpoint = backend.listCheckpoints("auto")[0]!;
	const encoded = encodeCheckpoint(checkpoint);
	const decoded = decodeToCheckpoint("auto", checkpoint.checkpointId, encoded);
	assert.ok(decoded?.kind === "stage");
	assert.deepEqual(decoded.routerSelection, selection);
	assert.equal(decoded.model, "different/actual");
	for (const invalid of [
		{ model: "decision-test/chat" },
		{ ...selection, extra: 1 },
		{ ...selection, effort: "unknown" },
	])
		assert.equal(
			decodeToCheckpoint("auto", checkpoint.checkpointId, { ...encoded, routerSelection: invalid }),
			undefined,
		);
	const restored = new InMemoryDurableBackend();
	restored.registerWorkflow({ workflowId: "auto", name: "auto", inputs: {}, createdAt: 1, status: "running" });
	restored.recordCheckpoint(decoded);
	assert.deepEqual(restored.getStageSession("auto", "stage:test")?.routerSelection, selection);
	const stage = createDurableStagePrimitive({
		workflowId: "auto",
		backend: restored,
		nextReplayKey: () => "stage:test",
		stage: (_name, options) => {
			assert.deepEqual(options?.routerSelection, selection);
			// Test selection readmission independently of opening the synthetic file.
			return createStageContext(
				makeOpts({
					models: f.models,
					adapters: f.adapters,
					stageOptions: { model: "auto", routerSelection: options?.routerSelection },
				}),
			);
		},
	})("task", { model: "auto" });
	await stage.prompt("Original prompt");
	assert.equal(f.infer.mock.calls.length, 0);
	assert.equal(f.admissions.length, 1);
	restored.recordCheckpoint({
		...decoded,
		checkpointId: "completed",
		output: "Saved result",
		result: "Saved result",
		topology: { ...decoded.topology!, status: "completed" },
	});
	const cached = createDurableStagePrimitive({
		workflowId: "auto",
		backend: restored,
		nextReplayKey: () => "stage:test",
		stage: () => {
			throw new Error("Replay must not construct a live stage");
		},
	})("task", { model: "auto" });
	assert.equal(await cached.prompt("Ignored on replay"), "Saved result");
	assert.equal(f.infer.mock.calls.length, 0);
});

test("parallel failure cancels no-longer-needed sibling routing before any child admission", async () => {
	const f = await fixture();
	// No catalog currentModel: the malformed decision stays a fatal routing
	// failure instead of degrading to the chat model (#3206).
	f.models = workflowModelCatalogFromContext({
		modelRegistry: f.modelRegistry,
		getRouterModel: () => "decision-test/chat",
	});
	const failure = createAssistantMessageEventStream();
	let siblingSignal: AbortSignal | undefined;
	f.infer.mockImplementation((_model, context, options) => {
		const task = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string).state
			.task;
		if (task === "Fail") return failure;
		siblingSignal = options?.signal;
		failure.push({ type: "done", reason: "toolUse", message: decisionMessage({ model: "missing", effort: null }) });
		return createAssistantMessageEventStream();
	});
	const def = workflow({
		name: "parallel-cancel-auto",
		description: "",
		inputs: {},
		outputs: {},
		run: async (ctx) => {
			await ctx.parallel(
				[
					{ name: "fail", prompt: "Fail" },
					{ name: "pending", prompt: "Pending" },
				],
				{ model: "auto", concurrency: 2 },
			);
			return {};
		},
	});
	assert.equal((await run(def, {}, f)).status, "failed");
	assert.ok(siblingSignal?.aborted);
	assert.equal(f.admissions.length, 0);
});

test("stage routing receives interpolated workflow inputs, not the template or stage name", async () => {
	const f = await fixture();
	const def = workflow({
		name: "input-auto",
		description: "",
		inputs: { objective: Type.String() },
		outputs: {},
		run: async (ctx) => {
			await ctx
				.stage("Analyze", { model: "auto" })
				.prompt(`Analyze ${ctx.inputs.objective} with the supplied context.`);
			return {};
		},
	});
	assert.equal((await run(def, { objective: "literal objective" }, f)).status, "completed");
	assert.equal(
		JSON.parse(f.infer.mock.calls[0]![1].messages.find((message) => message.role === "user")!.content as string).state
			.task,
		"Analyze literal objective with the supplied context.",
	);
});

test("catalog changes during route authority wait prevent child admission", async () => {
	const f = await fixture();
	const ctx = createStageContext(
		makeOpts({
			models: f.models,
			adapters: f.adapters,
			stageOptions: { model: "auto" },
			routeAuthorityReady: () => ({
				completion: Promise.resolve().then(() => {
					vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([]);
				}),
				assertCurrent() {},
			}),
		}),
	);
	await assert.rejects(ctx.prompt("Task"), /no longer eligible/);
	assert.equal(f.admissions.length, 0);
	await ctx.__dispose();
});

test("prompt and complete adapters receive a concrete routed model rather than auto", async () => {
	for (const method of ["prompt", "complete"] as const) {
		const f = await fixture();
		let selected: string | undefined;
		const ctx = createStageContext(
			makeOpts({
				models: f.models,
				stageOptions: { model: "auto" },
				adapters:
					method === "prompt"
						? {
								prompt: {
									async prompt(_text, meta) {
										selected = String(meta?.stageOptions?.model);
										return "done";
									},
								},
							}
						: {
								complete: {
									async complete(_text, _options, meta) {
										selected = String(meta?.stageOptions?.model);
										return "done";
									},
								},
							},
			}),
		);
		assert.equal(await ctx[method]("Actual adapter task"), "done");
		assert.equal(selected, "decision-test/chat");
		assert.equal(f.infer.mock.calls.length, 1);
		await ctx.__dispose();
	}
});

for (const method of ["prompt", "complete"] as const) {
	for (const model of [undefined, "decision-test/chat"]) {
		test(`non-auto ${method} adapter preserves immediate execution for ${model ?? "default"}`, async () => {
			const f = await fixture();
			const execute = vi.fn(async () => "done");
			const ctx = createStageContext(
				makeOpts({
					models: f.models,
					stageOptions: model === undefined ? {} : { model },
					adapters: method === "prompt" ? { prompt: { prompt: execute } } : { complete: { complete: execute } },
				}),
			);
			try {
				const pending = ctx[method]("Task");
				assert.equal(execute.mock.calls.length, 1);
				assert.equal(f.infer.mock.calls.length, 0);
				assert.equal(await pending, "done");
			} finally {
				await ctx.__dispose();
			}
		});
	}
	test(`auto ${method} adapter rejects cancellation after selection before execution`, async () => {
		const f = await fixture();
		const abort = new AbortController();
		const execute = vi.fn(async () => "done");
		const ctx = createStageContext(
			makeOpts({
				models: f.models,
				signal: abort.signal,
				stageOptions: { model: "auto" },
				onModelFallbackMetaChange: () => abort.abort(),
				adapters: method === "prompt" ? { prompt: { prompt: execute } } : { complete: { complete: execute } },
			}),
		);
		try {
			await assert.rejects(ctx[method]("Task"));
			assert.equal(execute.mock.calls.length, 0);
			assert.equal(f.infer.mock.calls.length, 1);
		} finally {
			await ctx.__dispose();
		}
	});
	test(`auto ${method} adapter revalidates catalog before each execution without rerouting`, async () => {
		const f = await fixture();
		const execute = vi.fn(async () => "done");
		const ctx = createStageContext(
			makeOpts({
				models: f.models,
				stageOptions: { model: "auto" },
				adapters: method === "prompt" ? { prompt: { prompt: execute } } : { complete: { complete: execute } },
			}),
		);
		try {
			assert.equal(await ctx[method]("Task"), "done");
			vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([]);
			await assert.rejects(ctx[method]("Next task"));
			assert.equal(execute.mock.calls.length, 1);
			assert.equal(f.infer.mock.calls.length, 1);
		} finally {
			await ctx.__dispose();
		}
	});
}

for (const change of ["empty catalog", "price exceeds maxInputCost", "still eligible"] as const) {
	test(`public live auto resume with ${change} retains one selection and session`, async () => {
		setDurableBackend(new InMemoryDurableBackend());
		const f = await fixture();
		const controls = createStageControlRegistry();
		const started = Promise.withResolvers<void>();
		let runId = "";
		let rejectPrompt: (error: Error) => void = () => {};
		const prompts: string[] = [];
		let sessions = 0;
		const definition = workflow({
			name: "public-auto-pause",
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				assert.ok(ctx.runId);
				runId = ctx.runId;
				await ctx.stage("work", { model: "auto", modelConstraints: { maxInputCost: 1 } }).prompt("Original task");
				return {};
			},
		});
		const running = run(
			definition,
			{},
			{
				...f,
				stageControlRegistry: controls,
				adapters: {
					agentSession: {
						async create(options) {
							sessions++;
							return makeMockSession({
								model: options.model,
								async prompt(text) {
									prompts.push(text);
									if (prompts.length === 1) {
										started.resolve();
										return new Promise<string>((_, reject) => {
											rejectPrompt = reject;
										});
									}
									return "done";
								},
								async abort() {
									rejectPrompt(new Error("paused"));
								},
							}).session;
						},
					},
				},
			},
		);
		await started.promise;
		const handle = controls.forRun(runId)[0];
		assert.ok(handle);
		await handle.pause();
		if (change === "empty catalog") vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([]);
		if (change === "price exceeds maxInputCost") {
			vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([
				{ ...decisionModel, cost: { ...decisionModel.cost, input: 2 } },
			]);
		}
		await handle.resume("Authorized resumed task");
		const result = await running;
		assert.deepEqual(
			prompts,
			change === "still eligible" ? ["Original task", "Authorized resumed task"] : ["Original task"],
		);
		assert.equal(result.status, change === "still eligible" ? "completed" : "failed");
		assert.equal(sessions, 1);
		assert.equal(f.infer.mock.calls.length, 1);
	});
}

test("ranked stage candidates run before configured fallback and survive checkpoint encoding", async () => {
	const f = await fixture();
	vi.spyOn(f.modelRegistry, "getAvailable").mockReturnValue([
		decisionModel,
		...["a", "b", "c", "d"].map((id) => ({ ...decisionModel, id })),
	]);
	const order = ["c", "a", "b"];
	let rank = 0;
	f.infer.mockImplementation(() =>
		messageStream(decisionMessage({ model: `decision-test/${order[rank++]}`, effort: null })),
	);
	const attempts: string[] = [];
	const ctx = createStageContext(
		makeOpts({
			models: f.models,
			stageOptions: { model: "auto", fallbackModels: ["decision-test/c", "decision-test/d"] },
			adapters: {
				agentSession: {
					async create(options) {
						const id = options.model!.id;
						attempts.push(id);
						return makeMockSession({
							model: options.model,
							async prompt() {
								if (id !== "d") throw new Error("429 rate limit");
								return "done";
							},
							getLastAssistantText: () => "done",
						}).session;
					},
				},
			},
		}),
	);
	try {
		await ctx.prompt("Inspect the approved task");
		assert.deepEqual(attempts, ["c", "a", "b", "d"]);
		const selection = ctx.__modelFallbackMeta().routerSelection!;
		assert.deepEqual(selection.fallbacks, [
			{ model: "decision-test/a", effort: null },
			{ model: "decision-test/b", effort: null },
		]);
		const backend = new InMemoryDurableBackend();
		backend.registerWorkflow({ workflowId: "ranked", name: "ranked", inputs: {}, createdAt: 1, status: "running" });
		await recordStageSessionCheckpoint(
			{ backend, workflowId: "ranked", nextCheckpointId: () => "cp", nextReplayKey: () => "stage:ranked" },
			{
				id: "s",
				name: "ranked",
				status: "running",
				parentIds: [],
				toolEvents: [],
				replayKey: "stage:ranked",
				sessionFile: "/synthetic/session.jsonl",
				routerSelection: selection,
			},
		);
		const checkpoint = backend.listCheckpoints("ranked")[0]!;
		const decoded = decodeToCheckpoint("ranked", checkpoint.checkpointId, encodeCheckpoint(checkpoint));
		assert.ok(decoded?.kind === "stage");
		assert.deepEqual(decoded.routerSelection, selection);
	} finally {
		await ctx.__dispose();
	}
});
