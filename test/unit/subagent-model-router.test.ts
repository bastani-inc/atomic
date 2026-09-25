import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import {
	type Api,
	type ClassifierContext,
	type ClassifierResult,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentTools,
	type JsonObject,
	type Model,
} from "@bastani/pi-ai";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	AutoRoutingInferenceError,
	routeExecutionModel,
} from "../../packages/coding-agent/src/core/execution-model-router.js";
import { ROUTING_REQUEST_BYTES } from "../../packages/coding-agent/src/core/model-routing-bytes.js";
import { loadAgentsFromDirWithDiagnostics } from "../../packages/subagents/src/agents/agent-loaders.js";
import { applyAgentConfig } from "../../packages/subagents/src/agents/agent-management-helpers.js";
import {
	applyBuiltinOverrides,
	readMergedSubagentSettings,
} from "../../packages/subagents/src/agents/agent-overrides.js";
import { serializeAgent } from "../../packages/subagents/src/agents/agent-serializer.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";
import { parseFrontmatter } from "../../packages/subagents/src/agents/frontmatter.js";
import { routeSubagentModel } from "../../packages/subagents/src/runs/shared/model-router.js";
import { parseModelConstraints } from "../../packages/subagents/src/shared/model-constraints.js";
import {
	chatPayload,
	chatRouter,
	classifierOptions,
	DEFAULT_NEEDS,
	defaultClassifierChoice,
	offeredModels,
} from "../helpers/model-routing.js";
import {
	decisionMessage,
	decisionModel,
	messageStream,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

vi.mock("node:fs/promises", { spy: true });

beforeEach(() => vi.stubEnv("TYPESAFE_API_KEY", ""));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
const agent: AgentConfig = {
	name: "worker",
	description: "Implement approved work",
	systemPrompt: "Implement only approved changes",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "user",
	filePath: "",
	model: "auto",
};
async function fixture() {
	const infer = vi.fn<Parameters<typeof registeredDecisionRuntime>[0]>(chatRouter());
	const { registry } = await registeredDecisionRuntime(infer);
	const ctx = {
		model: decisionModel,
		modelRegistry: registry,
		getRouterModel: () => "decision-test/chat",
	} as ExtensionContext;
	return { ctx, infer, route: (task = "Fix the approved defect") => routeSubagentModel({ ctx, agent, task }) };
}

/** Candidate keys in catalog order (`pair_N`), independent of the task-seeded request order. */
function byCatalogOrder(keys: readonly string[]): string[] {
	return [...keys].sort((a, b) => Number(a.slice("pair_".length)) - Number(b.slice("pair_".length)));
}

function mockClassifier(
	f: Awaited<ReturnType<typeof fixture>>,
	select: (keys: string[], id: string, context: ClassifierContext) => string = defaultClassifierChoice,
) {
	const model = f.ctx.modelRegistry.getClassifierModel("typesafe", "jev-latest");
	assert.ok(model);
	f.ctx.getRouterModel = () => `${model.provider}/${model.id}`;
	return vi.spyOn(f.ctx.modelRegistry, "classify").mockImplementation(async (_selected, context) => {
		const answers: ClassifierResult["answers"] = {};
		for (const [id, question] of Object.entries(context.questions)) {
			assert.equal(question.type, "choice");
			if (question.type !== "choice") throw new Error("Expected Choice question");
			answers[id] = {
				type: "choice",
				choice: select(Object.keys(question.criteria), id, context),
				probabilities: {},
				confidence: 1,
			};
		}
		return {
			api: model.api,
			provider: model.provider,
			model: model.id,
			answers,
			stopReason: "stop",
			timestamp: Date.now(),
		};
	});
}

test("auto routing admits multimodal-input chat but excludes image and classifier models, even from a native provider", async () => {
	const { runtime, registry } = await registeredDecisionRuntime(() => messageStream(decisionMessage()));
	const multimodal = {
		...decisionModel,
		provider: "multimodal",
		id: "chat",
		input: ["text", "image"] as ("text" | "image")[],
	};
	runtime.registerProvider("multimodal", {
		api: decisionModel.api,
		baseUrl: decisionModel.baseUrl,
		apiKey: "test-key",
		models: [multimodal],
	});
	const image = {
		...decisionModel,
		type: "image" as const,
		provider: "leaky",
		id: "painter",
		api: "openrouter-images" as const,
		output: ["image" as const],
	};
	const classifier = {
		...decisionModel,
		type: "classifier" as const,
		provider: "leaky",
		id: "judge",
		api: "typesafe-system-one" as const,
	};
	runtime.registerNativeProvider({
		...createProvider({
			id: "leaky",
			auth: { apiKey: { name: "test", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
			models: [image, classifier],
			images: {
				"openrouter-images": {
					generateImages: async () => {
						throw new Error("No image request expected");
					},
				},
			},
			classifiers: {
				"typesafe-system-one": {
					classify: async () => {
						throw new Error("No classification expected");
					},
				},
			},
		}),
		// Runtime-loaded native providers can return entries outside the declared chat-only interface.
		getModels: () => [image, classifier] as never as Model<Api>[],
	});
	await runtime.setRuntimeApiKey("leaky", "test-key", {});
	await runtime.setRuntimeApiKey("openrouter", "test-key", {});
	await runtime.setRuntimeApiKey("typesafe", "test-key", {});
	const ctx = { model: decisionModel, getRouterModel: () => "decision-test/chat", modelRegistry: registry };
	const imageId = "black-forest-labs/flux.2-flex";
	assert.ok(runtime.getModelOfType("image", "openrouter", imageId));
	assert.equal(runtime.getModel("openrouter", imageId), undefined);
	assert.ok(runtime.getModelOfType("classifier", "typesafe", "jev-latest"));
	assert.ok((await runtime.getAvailableOfType("image", "openrouter")).some((model) => model.id === imageId));
	assert.ok((await runtime.getAvailableOfType("classifier", "typesafe")).some((model) => model.id === "jev-latest"));
	await assert.rejects(
		routeExecutionModel({
			ctx,
			task: "Route",
			agent,
			constraints: [{ allowedModels: ["leaky/painter", "leaky/judge"] }],
		}),
		/no eligible model\/effort pairs/,
	);
	const route = (model: string) =>
		routeExecutionModel({ ctx, task: "Route", agent, selection: { model, effort: null } });
	assert.ok(registry.getAvailable().some((model) => model.provider === "leaky" && model.id === "painter"));
	assert.equal((await route("multimodal/chat")).routerSelection.model, "multimodal/chat");
	for (const id of ["leaky/painter", "leaky/judge", `openrouter/${imageId}`, "typesafe/jev-latest"]) {
		await assert.rejects(route(id), /no longer eligible/);
	}
});

test("self-contained agents retain their task fallback without duplicate instructions metadata", async () => {
	const f = await fixture();
	await routeSubagentModel({ ctx: f.ctx, agent });
	const state = JSON.parse(
		f.infer.mock.calls[0]![1].messages.find((message) => message.role === "user")!.content as string,
	).state;
	assert.equal(state.task, agent.systemPrompt);
	assert.deepEqual(state.agent, { name: agent.name, description: agent.description });
});
test("hard constraints preserve exact input and nullable effort choices", () => {
	const constraints = {
		requiredInputs: ["text", "image"],
		allowedEfforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max", null],
	};
	assert.deepEqual(parseModelConstraints(constraints), constraints);
	assert.deepEqual(parseModelConstraints({ requiredInputs: [], allowedEfforts: [] }), {
		requiredInputs: [],
		allowedEfforts: [],
	});
	for (const input of ["audio", "", null, 1]) {
		assert.throws(() => parseModelConstraints({ requiredInputs: [input] }), /Invalid modelConstraints/);
	}
	for (const effort of ["bogus", "", "null", 1, false]) {
		assert.throws(() => parseModelConstraints({ allowedEfforts: [effort] }), /Invalid modelConstraints/);
	}
});
for (const invalid of [
	{ unknown: true },
	{ maxInputCost: -1 },
	{ maxOutputCost: Infinity },
	{ minContextWindow: NaN },
	{ allowedEfforts: ["bogus"] },
]) {
	test(`invalid hard constraints fail: ${JSON.stringify(invalid)}`, () =>
		assert.throws(() => parseModelConstraints(invalid), /Invalid modelConstraints/));
}
test("call allowlist cannot widen an agent restriction", async () => {
	const f = await fixture();
	await assert.rejects(
		routeSubagentModel({
			ctx: f.ctx,
			agent: { ...agent, modelConstraints: { allowedModels: ["other/model"] } },
			modelConstraints: { allowedModels: ["decision-test/chat"] },
		}),
		/no eligible/,
	);
	assert.equal(f.infer.mock.calls.length, 0);
});
const invalidPairs: JsonObject[] = [
	{ modelId: "auto", reasoningEffort: null },
	{ modelId: "decision-test/chat", reasoningEffort: "off" },
	{ modelId: "decision-test/chat", reasoningEffort: null, extra: true },
];
for (const answer of invalidPairs) {
	test(`invalid pair degrades to the current chat model: ${JSON.stringify(answer)} (#3206)`, async () => {
		const f = await fixture();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		f.infer.mockImplementation(() => messageStream(decisionMessage(answer)));
		assert.equal((await f.route()).modelOverride, "decision-test/chat");
		assert.equal(warning.mock.calls.length, 0, "the degrade is silent unless routing debugging is on");
		vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
		const route = await f.route();
		assert.deepEqual(route.routerSelection, { model: "decision-test/chat", effort: null });
		assert.equal(route.modelOverride, "decision-test/chat");
		assert.equal(warning.mock.calls.length, 1);
		assert.match(String(warning.mock.calls[0]![0]), /running "worker" on the current chat model/);
	});

	test(`invalid pair rejected without a current chat model: ${JSON.stringify(answer)} (#3206)`, async () => {
		const f = await fixture();
		f.ctx.model = undefined;
		f.infer.mockImplementation(() => messageStream(decisionMessage(answer)));
		await assert.rejects(f.route(), /Invalid structured output/);
	});
}

const reasoningModel: Model<Api> = {
	...decisionModel,
	provider: "second-provider",
	id: "reasoner",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 100000,
	cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 },
	thinkingLevelMap: { off: "off", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
};
test("explicit legacy effort constrains automatic selection and intersects hard constraints", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
	f.infer.mockImplementation(chatRouter(() => "second-provider/reasoner"));
	const { agents } = loadAgentsFromDirWithDiagnostics(join(process.cwd(), "packages/subagents/agents"), "builtin");
	const overridden = applyBuiltinOverrides(
		agents,
		{ overrides: { worker: { thinking: "low" } } },
		{ overrides: { worker: { thinking: "high" } } },
		"user-settings.json",
		"project-settings.json",
	);
	const builtinAgent = overridden.find((candidate) => candidate.name === "worker");
	assert.ok(builtinAgent);
	const route = await routeSubagentModel({ ctx: f.ctx, agent: builtinAgent });
	assert.equal(route.modelOverride, "second-provider/reasoner:high");
	assert.equal(route.allowsCandidate("second-provider/reasoner:low"), true);
	assert.equal(route.allowsCandidate("second-provider/reasoner:high"), true);
	await assert.rejects(
		routeSubagentModel({
			ctx: f.ctx,
			agent: builtinAgent,
			modelConstraints: { allowedEfforts: ["low"] },
		}),
		/no eligible/,
	);
	assert.equal(f.infer.mock.calls.length, 1);
});

test.each(["", false])(
	"saved builtin thinking %j clears inherited effort without weakening hard constraints",
	async (thinking) => {
		const f = await fixture();
		const dir = mkdtempSync(join(tmpdir(), "atomic-empty-thinking-"));
		try {
			const settingsPath = join(dir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({ subagents: { agentOverrides: { worker: { model: "auto", thinking } } } }),
			);
			const { settings } = readMergedSubagentSettings([settingsPath]);
			const { agents } = loadAgentsFromDirWithDiagnostics(
				join(process.cwd(), "packages/subagents/agents"),
				"builtin",
			);
			const builtinAgent = applyBuiltinOverrides(
				agents,
				{ overrides: { worker: { thinking: "high" } } },
				settings,
				"user-settings.json",
				settingsPath,
			).find((candidate) => candidate.name === "worker");
			assert.ok(builtinAgent);
			assert.equal(builtinAgent.thinking, thinking === false ? undefined : thinking);
			assert.equal(builtinAgent.model, "auto");
			const route = await routeSubagentModel({ ctx: f.ctx, agent: builtinAgent });
			assert.deepEqual(route.routerSelection, { model: "decision-test/chat", effort: null });
			assert.equal(f.infer.mock.calls.length, 1);
			await assert.rejects(
				routeSubagentModel({ ctx: f.ctx, agent: builtinAgent, modelConstraints: { allowedEfforts: ["high"] } }),
				/no eligible/,
			);
			assert.equal(f.infer.mock.calls.length, 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

test("builtin primary and fallback checks retain the same hard-constraint snapshot during inference", async () => {
	const f = await fixture();
	const allowedEfforts = ["low"];
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([reasoningModel]);
	f.infer.mockImplementation((model, context) => {
		allowedEfforts.push("high");
		return chatRouter()(model, context);
	});
	const route = await routeSubagentModel({
		ctx: f.ctx,
		agent: { ...agent, source: "builtin", thinking: "low" },
		modelConstraints: { allowedEfforts },
	});
	assert.equal(route.modelOverride, "second-provider/reasoner:low");
	assert.equal(route.allowsCandidate("second-provider/reasoner:high"), false);
	assert.equal(f.infer.mock.calls.length, 1);
});

test("full provider catalog preserves supported off, independent task decisions and fallback effort", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
	f.infer.mockImplementation((model, context) => {
		const { state } = chatPayload(context);
		const offered = offeredModels(context);
		if (offered) assert.deepEqual([...offered].sort(), ["decision-test/chat", "second-provider/reasoner"]);
		return chatRouter(() => "second-provider/reasoner", {
			difficulty: String(state.task).includes("proof") ? "hard" : "trivial",
		})(model, context);
	});
	const [proof, edit] = await Promise.all([f.route("Check a mathematical proof"), f.route("Edit a short heading")]);
	assert.equal(proof.modelOverride, "second-provider/reasoner:high");
	assert.equal(edit.modelOverride, "second-provider/reasoner:off");
	assert.equal(proof.allowsCandidate("second-provider/reasoner:low"), true);
	assert.equal(proof.allowsCandidate("second-provider/reasoner"), true);
	assert.equal(proof.allowsCandidate("second-provider/reasoner:max"), false);
});

test("cost, context, capability and effort constraints are enforced before inference and on fallback", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
	f.infer.mockImplementation(chatRouter(() => "second-provider/reasoner"));
	const route = await routeSubagentModel({
		ctx: f.ctx,
		agent,
		task: "Inspect the attached screenshot",
		modelConstraints: {
			maxInputCost: 2,
			maxOutputCost: 8,
			minContextWindow: 80000,
			requiredInputs: ["image"],
			allowedEfforts: ["low"],
		},
	});
	assert.equal(route.allowsCandidate("decision-test/chat"), false);
	assert.equal(route.allowsCandidate("second-provider/reasoner:high"), false);
	assert.equal(route.allowsCandidate("second-provider/reasoner:low"), true);
	assert.equal(route.allowsCandidate("second-provider/reasoner", "high"), false);
	await assert.rejects(
		routeSubagentModel({ ctx: f.ctx, agent, modelConstraints: { maxInputCost: 1, requiredInputs: ["image"] } }),
		/no eligible/,
	);
});

test("pricing tiers cannot evade a maximum token rate", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		{
			...reasoningModel,
			cost: {
				...reasoningModel.cost,
				tiers: [{ inputTokensAbove: 1000, input: 6, output: 15, cacheRead: 0, cacheWrite: 0 }],
			},
		},
	]);
	await assert.rejects(
		routeSubagentModel({ ctx: f.ctx, agent, modelConstraints: { maxInputCost: 3 } }),
		/no eligible/,
	);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("authored and management-created constraints round trip without widening", () => {
	const updated = { ...agent };
	const constraints = {
		allowedModels: ["second-provider/reasoner"],
		maxInputCost: 2,
		allowedEfforts: ["off", null],
		requiredInputs: ["image"],
	};
	assert.equal(applyAgentConfig(updated, { modelConstraints: constraints }), undefined);
	const parsed = parseFrontmatter(serializeAgent(updated));
	assert.deepEqual(parsed.modelConstraints, constraints);
	assert.equal(parsed.parseError, undefined);
	assert.match(
		parseFrontmatter("---\nname: worker\ndescription: test\nmodelConstraints:\n  latency: 1\n---\nWork").parseError ??
			"",
		/Invalid modelConstraints/,
	);
	const dir = mkdtempSync(join(tmpdir(), "atomic-auto-constraints-"));
	try {
		writeFileSync(join(dir, "worker.md"), serializeAgent(updated));
		const loaded = loadAgentsFromDirWithDiagnostics(dir, "project");
		assert.deepEqual(loaded.diagnostics, []);
		assert.equal(loaded.agents[0]?.model, "auto");
		assert.deepEqual(loaded.agents[0]?.modelConstraints, constraints);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("catalog availability is revalidated after inference and immediately before admission", async () => {
	const f = await fixture();
	const available = vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel]);
	const selected = await f.route();
	available.mockReturnValue([]);
	assert.throws(selected.assertCurrent, /no longer eligible/);
	available.mockReturnValue([decisionModel]);
	f.infer.mockImplementation((model, context) => {
		available.mockReturnValue([]);
		return chatRouter()(model, context);
	});
	await assert.rejects(f.route(), /no longer eligible/);
});

for (const evalsCase of ["missing", "empty"] as const) {
	test(`missing or empty evals fall back to the current chat model before inference: ${evalsCase}`, async () => {
		const f = await fixture();
		const readFile = fs.readFile;
		const read = vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof readFile>) => {
			if (!String(args[0]).endsWith("evals.md")) return readFile(...args);
			if (evalsCase === "missing") throw new Error("missing");
			return "";
		});
		try {
			assert.equal((await f.route()).modelOverride, `${decisionModel.provider}/${decisionModel.id}`);
			assert.equal(f.infer.mock.calls.length, 0);
		} finally {
			read.mockRestore();
		}
	});
}

test("an oversized evals document does not enlarge routing requests", async () => {
	const f = await fixture();
	vi.spyOn(fs, "readFile").mockResolvedValueOnce(
		`${"unmatched model ".repeat(5_000)}\n| slug | Model |\n| --- | --- |\n| unrelated | Example |`,
	);
	await f.route();
	const [, context] = f.infer.mock.calls[0]!;
	const payload = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string);
	assert.doesNotMatch(JSON.stringify(payload.state), /unmatched model/u);
	assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= ROUTING_REQUEST_BYTES);
});

test("empty catalogs fail before inference", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([]);
	await assert.rejects(f.route(), /no eligible/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("provider failure degrades to the current chat model; cancellation never becomes a selection (#3206)", async () => {
	const f = await fixture();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	f.infer.mockImplementation(() => {
		throw new Error("mock provider failure");
	});
	assert.equal((await f.route()).modelOverride, "decision-test/chat");
	f.ctx.model = undefined;
	await assert.rejects(f.route(), /provider request failed/);
	f.ctx.model = decisionModel;
	const stream = createAssistantMessageEventStream();
	const entered = Promise.withResolvers<void>();
	f.infer.mockImplementation(() => {
		entered.resolve();
		return stream;
	});
	const controller = new AbortController();
	const pending = routeSubagentModel({ ctx: f.ctx, agent, signal: controller.signal });
	await entered.promise;
	controller.abort();
	stream.push({
		type: "done",
		reason: "toolUse",
		message: decisionMessage({ modelId: "decision-test/chat", reasoningEffort: null }),
	});
	await assert.rejects(pending, /cancelled|abort/i);
});

for (const [allowed, degrades] of [
	["decision-test/chat", true],
	["second-provider/reasoner", false],
] as const) {
	test(`total routing failure with allowedModels=${allowed} ${degrades ? "degrades to" : "never runs"} the current chat model (#3206)`, async () => {
		const f = await fixture();
		vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
		f.infer.mockImplementation(() => {
			throw new Error("mock provider failure");
		});
		const routing = routeSubagentModel({ ctx: f.ctx, agent, modelConstraints: { allowedModels: [allowed] } });
		if (!degrades) {
			await assert.rejects(routing, /provider request failed/);
			assert.equal(warning.mock.calls.length, 0);
			return;
		}
		const route = await routing;
		assert.equal(route.modelOverride, "decision-test/chat");
		assert.equal(route.allowsCandidate("decision-test/chat"), true);
		assert.equal(route.allowsCandidate("second-provider/reasoner:high"), false);
		assert.equal(route.allowsModel(reasoningModel, "high"), false);
		assert.equal(warning.mock.calls.length, 1);
		assert.doesNotMatch(String(warning.mock.calls[0]![0]), /mock provider failure/);
	});
}

test("routing accepts a valid selection after the former deadline without retry", async () => {
	const f = await fixture();
	vi.useFakeTimers();
	const entered = Promise.withResolvers<void>();
	const stream = createAssistantMessageEventStream();
	f.infer.mockImplementation(() => {
		entered.resolve();
		return stream;
	});
	const pending = f.route();
	await entered.promise;
	await vi.advanceTimersByTimeAsync(120_000);
	stream.push({
		type: "done",
		reason: "toolUse",
		message: decisionMessage({ ...DEFAULT_NEEDS }),
	});
	assert.deepEqual((await pending).routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(f.infer.mock.calls.length, 1);
});

test("configured credential text is rejected before inference", async () => {
	const f = await fixture();
	await assert.rejects(f.route("Task contains mock-chat-secret"), /credential/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("default reasoning catalog does not invent extended effort support (#3206)", async () => {
	const f = await fixture();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([{ ...reasoningModel, thinkingLevelMap: undefined }]);
	f.infer.mockImplementation(() =>
		messageStream(decisionMessage({ modelId: "second-provider/reasoner", reasoningEffort: "max" })),
	);
	// The invented effort is never accepted. The current chat model is not in the
	// available catalog, so the launch cannot degrade to it and fails.
	await assert.rejects(f.route(), /Invalid structured output/);
	f.ctx.model = undefined;
	await assert.rejects(f.route(), /Invalid structured output/);
	f.ctx.model = decisionModel;
});

test("router defaults and auto use current chat while invalid explicit configuration fails", async () => {
	const f = await fixture();
	f.ctx.getRouterModel = () => "";
	await f.route();
	assert.equal(f.infer.mock.calls[0]![0].id, decisionModel.id);
	f.ctx.getRouterModel = () => "auto";
	await f.route();
	f.ctx.getRouterModel = () => "missing/model";
	await assert.rejects(f.route(), /Invalid routerModel/);
	assert.equal(f.infer.mock.calls.length, 2);
	assert.equal(f.ctx.model, decisionModel);
});

test("a stale model catalog fails before a classifier selection can launch a subagent", async () => {
	const f = await fixture();
	const catalog = vi
		.spyOn(f.ctx.modelRegistry, "getAvailable")
		.mockReturnValue(Array.from({ length: 256 }, (_, i) => ({ ...decisionModel, id: `m${i}` })));
	const classify = mockClassifier(f, (keys, id) => {
		catalog.mockReturnValue([]);
		if (id === "work") return "coding";
		return id === "needs_images" ? "no" : byCatalogOrder(keys)[0]!;
	});
	await assert.rejects(f.route(), /no longer eligible/);
	assert.ok(classify.mock.calls.length >= 1);
	assert.equal(f.infer.mock.calls.length, 1, "only the chat model reads the task");
});

test("classifier provider failure cannot return a route without a current chat model", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(
		Array.from({ length: 256 }, (_, i) => ({ ...decisionModel, id: `m${i}` })),
	);
	const classify = mockClassifier(f);
	f.ctx.model = undefined;
	classify.mockRejectedValue(new Error("HTTP 422 private provider detail"));
	await assert.rejects(routeTask(f, { taskNeeds: STATED_CODING_NEEDS }), /Classifier returned no valid decision/);
	assert.ok(classify.mock.calls.length >= 1, "the classifier is asked once and nothing retries on chat");
	assert.equal(f.infer.mock.calls.length, 0);
	await assert.rejects(
		routeTask(f),
		/needs a chat model to read the task/,
		"no chat model means nothing can read the task",
	);
});

test("long tasks reach the chat reader complete and never reach the classifier", async () => {
	const f = await fixture();
	const notice = vi.spyOn(console, "warn").mockImplementation(() => {});
	const task = `Review this change.\n${"reference data ".repeat(10000)}<keepContext>Review only.</keepContext>${"more data ".repeat(10000)}\nReport defects.`;
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
	const classify = mockClassifier(f);
	assert.equal((await f.route(task)).modelOverride, "decision-test/chat");
	assert.equal(f.infer.mock.calls.length, 1);
	assert.equal(chatPayload(f.infer.mock.calls[0]![1]).state.task, task);
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(classify.mock.calls[0]![1].state.task, undefined, "the classifier never receives the task");
	assert.deepEqual(notice.mock.calls, []);
});

test("auto routing screens credentials anywhere in a long task", async () => {
	const f = await fixture();
	await assert.rejects(f.route(`${"a".repeat(30_000)}mock-chat-secret${"b".repeat(30_000)}`), /credential/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("a classifier that rejects the choice falls back to chat without the task, quietly unless debugging", async () => {
	const f = await fixture();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
	const classify = mockClassifier(f);
	classify.mockRejectedValue(new Error("request too large"));
	const task = `<keepContext>${"required detail ".repeat(3000)}</keepContext>`;
	vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "");
	await f.route(task);
	assert.deepEqual(warn.mock.calls, [], "routing fallbacks stay out of the console by default");
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(classify.mock.calls[0]![1].state.task, undefined);
	const requests = f.infer.mock.calls.map(([, context]) => ({
		task: chatPayload(context).state.task,
		choice: offeredModels(context) !== undefined,
	}));
	assert.deepEqual(requests, [
		{ task, choice: false },
		{ task: undefined, choice: true },
	]);

	vi.stubEnv("ATOMIC_MODEL_ROUTING_DEBUG", "1");
	f.ctx.getRouterModel = () => "typesafe/jev-latest";
	await f.route(task);
	assert.ok(
		(warn.mock.calls as unknown[][]).some(([message]) =>
			/Classifier routing failed; falling back to current chat model/u.test(String(message)),
		),
	);
	vi.unstubAllEnvs();
});

const STATED_CODING_NEEDS = {
	work: "coding",
	difficulty: "hard",
	mistakeCost: "high",
	needsImages: false,
	longContext: false,
	latencySensitive: false,
} as const;

const routeTask = (
	f: Awaited<ReturnType<typeof fixture>>,
	extra: Partial<Parameters<typeof routeExecutionModel>[0]> = {},
) =>
	routeExecutionModel({
		ctx: f.ctx,
		task: "Open Xcode, build the app and verify the settings screen by screenshot.",
		agent: { name: agent.name, description: agent.description },
		...extra,
	});

const catalogModel = (provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> => ({
	...reasoningModel,
	provider,
	id,
	name: id,
	...overrides,
});

test("the chat reader is asked only for the task needs the caller did not state", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
	const classify = mockClassifier(f);
	const route = await routeTask(f, { taskNeeds: { work: "computer_use", needsImages: true } });
	assert.equal(classify.mock.calls.length, 0, "a single model able to read images leaves nothing to choose between");
	assert.equal(f.infer.mock.calls.length, 1);
	const request = f.infer.mock.calls[0]![1];
	const tool = getCurrentTools(request.messages)[0];
	assert.ok(tool);
	assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties), [
		"difficulty",
		"mistake_cost",
		"long_context",
		"latency_sensitive",
	]);
	assert.deepEqual(chatPayload(request).state.caller_says, { work: "computer_use", needs_images: "yes" });
	assert.equal(route.routerSelection.model, "second-provider/reasoner");
});

test("a caller that states every need gets one choice request whose options carry their own evidence", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		catalogModel("anthropic", "claude-opus-5-5"),
		catalogModel("openai-codex", "gpt-6-luna", { cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 } }),
	]);
	const requests: ClassifierContext[] = [];
	mockClassifier(f, (keys, _id, context) => {
		requests.push(context);
		return keys.find((key) => classifierOptions(context)[key] === "anthropic/claude-opus-5-5")!;
	});
	const route = await routeTask(f, { taskNeeds: STATED_CODING_NEEDS });
	assert.equal(f.infer.mock.calls.length, 0, "a caller that states every need skips the task reader");
	assert.equal(requests.length, 1);
	assert.deepEqual(Object.keys(requests[0]!.questions), ["model"]);
	assert.deepEqual(Object.keys(requests[0]!.state), ["agent", "needs"], "the choice request carries no task");
	assert.deepEqual(requests[0]!.state.needs, {
		work: "coding",
		difficulty: "hard",
		mistake_cost: "high",
		needs_images: false,
		long_context: false,
		latency_sensitive: false,
	});
	const question = requests[0]!.questions.model;
	assert.ok(question?.type === "choice");
	const options = Object.values(question.criteria).map((value) => JSON.parse(value) as Record<string, unknown>);
	for (const option of options)
		assert.deepEqual(Object.keys(option), ["model", "id", "released", "price", "reads_images", "coding", "overall"]);
	assert.match(
		String(options.find((option) => option.id === "anthropic/claude-opus-5-5")?.coding),
		/Terminal-Bench 4\.0 59\.6%/u,
	);
	assert.deepEqual(route.routerSelection.model, "anthropic/claude-opus-5-5");
	assert.equal(route.routerSelection.effort, "high", "effort follows the stated difficulty");
	assert.deepEqual(
		route.routerSelection.fallbacks?.map((pair) => pair.model),
		["openai-codex/gpt-6-luna"],
	);
});

test("a task that needs images never offers models that cannot read them", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		catalogModel("a", "sees-1"),
		catalogModel("a", "sees-2"),
		catalogModel("a", "text-only", { input: ["text"] }),
	]);
	const offered: string[][] = [];
	mockClassifier(f, (keys, id, context) => {
		if (id === "model") offered.push(Object.values(classifierOptions(context)));
		return defaultClassifierChoice(keys, id, context);
	});
	await routeTask(f, { taskNeeds: { needsImages: true } });
	assert.deepEqual(offered[0]?.sort(), ["a/sees-1", "a/sees-2"]);
});

test("allowedModels from the caller becomes the shortlist the router chooses from", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		catalogModel("anthropic", "claude-opus-5-5"),
		catalogModel("anthropic", "claude-opus-5-5-fast"),
		catalogModel("openai-codex", "gpt-6-astra"),
		catalogModel("openai-codex", "gpt-6-luna"),
	]);
	const offered: string[][] = [];
	mockClassifier(f, (keys, id, context) => {
		if (id === "model") offered.push(Object.values(classifierOptions(context)));
		return defaultClassifierChoice(keys, id, context);
	});
	const route = await routeTask(f, {
		constraints: [
			{ allowedModels: ["anthropic/claude-opus-5-5", "anthropic/claude-opus-5-5-fast", "openai-codex/gpt-6-astra"] },
		],
	});
	assert.deepEqual(offered[0]?.sort(), [
		"anthropic/claude-opus-5-5",
		"anthropic/claude-opus-5-5-fast",
		"openai-codex/gpt-6-astra",
	]);
	assert.ok(!JSON.stringify(route.routerSelection).includes("gpt-6-luna"));
});

test("without a caller list, one model's fast route and other providers share a single shortlist slot", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		catalogModel("anthropic", "claude-opus-5-5"),
		catalogModel("anthropic", "claude-opus-5-5-fast", {
			fastRoute: { baseModelId: "claude-opus-5-5", upstreamModelId: "claude-opus-5-5", speed: "fast" },
		}),
		catalogModel("github-copilot", "claude-opus-5.5"),
		catalogModel("openai-codex", "gpt-6-luna"),
	]);
	const offered: string[][] = [];
	mockClassifier(f, (keys, id, context) => {
		if (id === "model") offered.push(Object.values(classifierOptions(context)));
		return defaultClassifierChoice(keys, id, context);
	});
	await routeTask(f);
	assert.equal(offered[0]?.length, 2);
	assert.equal(offered[0]?.filter((model) => /opus-5[-.]5/u.test(model)).length, 1);
	assert.ok(offered[0]?.includes("openai-codex/gpt-6-luna"));
});

test("caller task needs are validated before any inference", async () => {
	const f = await fixture();
	await assert.rejects(
		routeSubagentModel({ ctx: f.ctx, agent, task: "x", taskNeeds: { difficulty: "extreme" } as never }),
		/Invalid taskNeeds\.difficulty/u,
	);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("a caller's shortlist is described with standings among every model the user could route to", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		catalogModel("anthropic", "claude-opus-5-5"),
		catalogModel("anthropic", "claude-fable-5-1"),
		catalogModel("openai-codex", "gpt-6-astra"),
		catalogModel("openai-codex", "gpt-6-sol"),
		catalogModel("openai-codex", "gpt-6-luna"),
	]);
	const options: Record<string, unknown>[] = [];
	mockClassifier(f, (keys, id, context) => {
		const question = context.questions[id];
		if (id === "model" && question?.type === "choice")
			for (const value of Object.values(question.criteria))
				options.push(JSON.parse(value) as Record<string, unknown>);
		return defaultClassifierChoice(keys, id, context);
	});
	const route = await routeTask(f, {
		taskNeeds: { work: "coding", difficulty: "hard", mistakeCost: "high", needsImages: false },
		constraints: [{ allowedModels: ["anthropic/claude-opus-5-5", "openai-codex/gpt-6-luna"] }],
	});
	assert.deepEqual(options.map((option) => option.id).sort(), [
		"anthropic/claude-opus-5-5",
		"openai-codex/gpt-6-luna",
	]);
	for (const option of options)
		assert.doesNotMatch(String(option.overall), /^measured/u, "two listed models alone could not be ranked");
	assert.ok(
		[route.routerSelection, ...(route.routerSelection.fallbacks ?? [])].every((pair) =>
			["anthropic/claude-opus-5-5", "openai-codex/gpt-6-luna"].includes(pair.model),
		),
		"fallbacks stay within the caller's list",
	);
});

test("a task that needs images falls back to the current chat model when no eligible model can read them", async () => {
	const f = await fixture();
	const current = { ...decisionModel, input: ["text" as const] };
	f.ctx.model = current;
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		current,
		catalogModel("a", "text-2", { input: ["text"] }),
	]);
	mockClassifier(f, defaultClassifierChoice);
	await assert.rejects(routeTask(f, { taskNeeds: { needsImages: true } }), (error: unknown) => {
		assert.ok(error instanceof AutoRoutingInferenceError);
		assert.match(error.message, /needs a model that can read images/u);
		assert.equal(error.currentModelRoute?.routerSelection.model, `${current.provider}/${current.id}`);
		return true;
	});
});

test("a caller list is offered whole while it fits one choice request, and falls back beyond that", async () => {
	const f = await fixture();
	const listed = (count: number) => Array.from({ length: count }, (_, index) => `model-${index}`);
	const available = vi.spyOn(f.ctx.modelRegistry, "getAvailable");
	const offered: number[] = [];
	mockClassifier(f, (keys, id, context) => {
		if (id === "model") offered.push(keys.length);
		return defaultClassifierChoice(keys, id, context);
	});
	const forty = listed(40);
	available.mockReturnValue(forty.map((id) => catalogModel("a", id)));
	await routeTask(f, {
		taskNeeds: STATED_CODING_NEEDS,
		constraints: [{ allowedModels: forty.map((id) => `a/${id}`) }],
	});
	assert.deepEqual(offered, [40], "no fixed cap below what one request holds");

	const tooMany = listed(300);
	available.mockReturnValue(tooMany.map((id) => catalogModel("a", id)));
	await assert.rejects(
		routeTask(f, {
			taskNeeds: STATED_CODING_NEEDS,
			constraints: [{ allowedModels: tooMany.map((id) => `a/${id}`) }],
		}),
		(error: unknown) =>
			error instanceof AutoRoutingInferenceError && /cannot compare 300 different models/u.test(error.message),
	);
});
