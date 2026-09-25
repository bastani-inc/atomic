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
import { Value } from "typebox/value";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	MODEL_SELECTION_GUIDE,
	routeExecutionModel,
} from "../../packages/coding-agent/src/core/execution-model-router.js";
import {
	MODEL_ROUTING_TASK_BYTES,
	ROUTING_REQUEST_BYTES,
	TRUNCATED_MARKER,
} from "../../packages/coding-agent/src/core/model-routing-task.js";
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
	const infer = vi.fn<Parameters<typeof registeredDecisionRuntime>[0]>(() =>
		messageStream(decisionMessage({ modelId: "decision-test/chat", reasoningEffort: null })),
	);
	const { registry } = await registeredDecisionRuntime(infer);
	const ctx = {
		model: decisionModel,
		modelRegistry: registry,
		getRouterModel: () => "decision-test/chat",
	} as ExtensionContext;
	return { ctx, infer, route: (task = "Fix the approved defect") => routeSubagentModel({ ctx, agent, task }) };
}

function mockClassifier(
	f: Awaited<ReturnType<typeof fixture>>,
	select: (keys: string[], id: string, context: ClassifierContext) => string = (keys) => keys[0]!,
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

test("explicit classifier routing receives evals, guide, task, and all eligible candidates", async () => {
	const f = await fixture();
	const candidates = Array.from({ length: 9 }, (_, index) => ({
		...decisionModel,
		id: `candidate-${index + 1}`,
		name: `Verbose candidate ${index + 1} with a catalog description`,
		contextWindow: 128_000,
		cost: { input: 1.25, output: 7.5, cacheRead: 0.2, cacheWrite: 1.5 },
	}));
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(candidates);
	const expectedEvals = await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8");
	const seen = new Set<string>();
	const classify = mockClassifier(f, (keys, _id, context) => {
		assert.equal(context.state.evals, expectedEvals);
		assert.equal(context.state.model_selection_guide, MODEL_SELECTION_GUIDE);
		for (const question of Object.values(context.questions)) {
			assert.equal(question.type, "choice");
			if (question.type !== "choice") continue;
			for (const [key, value] of Object.entries(question.criteria)) {
				seen.add((JSON.parse(value) as { model: string }).model);
				assert.match(key, /^pair_\d+$/u);
			}
		}
		return keys[0]!;
	});
	const result = await f.route(taskNearRoutingLimit());
	assert.equal(classify.mock.calls.length, 3);
	assert.equal(seen.size, candidates.length);
	assert.equal(result.routerSelection.model, "decision-test/candidate-1");
});

function taskNearRoutingLimit(): string {
	const seed = 'Route this exact task; preserve JSON characters {"quoted":"value\\n"} and Unicode Ω界. ';
	const protectedRequirement =
		"<keepContext>Keep this exact protected requirement Ω and do not drop it.</keepContext>";
	let task = `${seed}${"context ".repeat(1000)}${protectedRequirement}`;
	while (Buffer.byteLength(JSON.stringify(`${task} tail`), "utf8") <= MODEL_ROUTING_TASK_BYTES - 100)
		task = `${task} tail`;
	return task;
}

test("a ~240-pair catalog truncates the routing copy of evals and task to fit Jev's input limit", async () => {
	const f = await fixture();
	const candidates = Array.from({ length: 240 }, (_, index) => ({
		...decisionModel,
		id: `candidate-${index + 1}`,
		contextWindow: 400_000,
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	}));
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(candidates);
	const requests: ClassifierContext[] = [];
	mockClassifier(f, (keys, _id, context) => {
		requests.push(context);
		return keys[0]!;
	});
	const task = `<keepContext>${"Protected requirement. ".repeat(2_000)}</keepContext>`;
	const result = await f.route(task);
	assert.equal(result.routerSelection.model, "decision-test/candidate-1");
	assert.equal(requests.length, 3);
	const [first] = requests;
	assert.ok(first);
	const question = first.questions.pair;
	assert.equal(question?.type, "choice");
	if (question?.type !== "choice") return;
	assert.equal(Object.keys(question.criteria).length, candidates.length);
	assert.ok(String(first.state.evals).endsWith(TRUNCATED_MARKER));
	assert.ok(String(first.state.task).includes(TRUNCATED_MARKER));
	for (const request of requests) {
		assert.ok(Buffer.byteLength(JSON.stringify(request), "utf8") <= ROUTING_REQUEST_BYTES);
	}
});
test("auto routing receives the shipped evals document verbatim", async () => {
	const f = await fixture();
	const selected = await f.route();
	assert.deepEqual(selected.routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(selected.modelOverride, "decision-test/chat");
	assert.ok(Object.isFrozen(selected.routerSelection));
	assert.equal(f.infer.mock.calls.length, 1);
	const [, context, options] = f.infer.mock.calls[0]!;
	const state = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string).state;
	assert.equal(state.task, "Fix the approved defect");
	assert.deepEqual(state.agent, { name: agent.name, description: agent.description });
	assert.equal(state.policy, undefined);
	assert.equal(state.evidence, undefined);
	assert.equal(state.model_selection_guide, MODEL_SELECTION_GUIDE);
	assert.match(state.model_selection_guide, /^## Benchmarks are evidence, not policy\n/);
	assert.match(state.model_selection_guide, /## Role-based thinking effort/);
	assert.match(state.model_selection_guide, /\| Deterministic checks \| No model call \|/);
	assert.match(
		state.model_selection_guide,
		/If `xhigh` is unavailable, use `high` rather than automatically promoting to `max`/,
	);
	assert.match(state.evals, /# Evals/);
	assert.match(state.evals, /top 26 catalog models/);
	assert.equal(state.evals, await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8"));
	assert.ok(Buffer.byteLength(JSON.stringify(context)) < 30_000);
	assert.equal(options?.maxRetries, 0);
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
	f.infer.mockImplementation((_model, context) => {
		const payload = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string);
		assert.deepEqual(
			Object.values(payload.questions.pair.criteria).map((entry) => JSON.parse(entry as string).effort),
			["high"],
		);
		return messageStream(decisionMessage({ modelId: "second-provider/reasoner", reasoningEffort: "high" }));
	});
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
	f.infer.mockImplementation(() => {
		allowedEfforts.push("high");
		return messageStream(decisionMessage({ modelId: "second-provider/reasoner", reasoningEffort: "low" }));
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
	f.infer.mockImplementation((_model, context) => {
		const { state, questions } = JSON.parse(
			context.messages.find((message) => message.role === "user")!.content as string,
		);
		const candidates = Object.values(questions.pair.criteria).map((entry) => JSON.parse(entry as string));
		if (candidates.length === 1)
			return messageStream(decisionMessage({ modelId: "decision-test/chat", reasoningEffort: null }));
		assert.deepEqual(
			[...new Set(candidates.map((entry) => entry.model))],
			["decision-test/chat", "second-provider/reasoner"],
		);
		assert.deepEqual(
			candidates.filter((entry) => entry.model === "second-provider/reasoner").map((entry) => entry.effort),
			["off", "low", "high"],
		);
		return messageStream(
			decisionMessage(
				state.task.includes("proof")
					? { modelId: "second-provider/reasoner", reasoningEffort: "high" }
					: { modelId: "second-provider/reasoner", reasoningEffort: "off" },
			),
		);
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
	f.infer.mockImplementation(() =>
		messageStream(decisionMessage({ modelId: "second-provider/reasoner", reasoningEffort: "low" })),
	);
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
	f.infer.mockImplementation(() => {
		available.mockReturnValue([]);
		return messageStream(decisionMessage({ modelId: "decision-test/chat", reasoningEffort: null }));
	});
	await assert.rejects(f.route(), /no longer eligible/);
});

for (const evalsCase of ["missing", "empty", "oversized"] as const) {
	test(`missing, empty and oversized evals fail before inference: ${evalsCase}`, async () => {
		const f = await fixture();
		const read = vi.spyOn(fs, "readFile");
		if (evalsCase === "missing") read.mockRejectedValueOnce(new Error("missing"));
		if (evalsCase === "empty") read.mockResolvedValueOnce("");
		if (evalsCase === "oversized") read.mockResolvedValueOnce("evals ".repeat(3_000));
		await assert.rejects(
			f.route(),
			/Auto routing requires a nonempty evals\.md document within 14,200 JSON-encoded bytes/,
		);
		assert.equal(f.infer.mock.calls.length, 0);
	});
}

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

test("a failed optional fallback-ranking pass keeps the selected primary (#3206)", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([decisionModel, reasoningModel]);
	f.infer
		.mockImplementationOnce(() =>
			messageStream(decisionMessage({ modelId: "second-provider/reasoner", reasoningEffort: "high" })),
		)
		.mockImplementation(() => {
			throw new Error("mock provider failure");
		});
	const route = await routeExecutionModel({
		ctx: f.ctx,
		task: "Fix the approved defect",
		agent: { name: agent.name, description: agent.description },
	});
	assert.deepEqual(route.routerSelection, { model: "second-provider/reasoner", effort: "high" });
	assert.equal(route.modelOverride, "second-provider/reasoner:high");
	assert.deepEqual(route.fallbackModels, []);
	assert.equal(f.infer.mock.calls.length, 2);
});

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
		message: decisionMessage({ modelId: "decision-test/chat", reasoningEffort: null }),
	});
	assert.deepEqual((await pending).routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(f.infer.mock.calls.length, 1);
});

test("an explicit registered classifier selects complete pairs and falls back from invalid answers", async () => {
	const f = await fixture();
	f.ctx.getRouterModel = () => "";
	assert.deepEqual((await f.route()).routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(f.infer.mock.calls.length, 1);
	let choice = "pair_0";
	const classify = mockClassifier(f, (_keys, _id, context) => {
		assert.equal(context.state.task, "Fix the approved defect");
		assert.deepEqual(context.state.agent, { name: agent.name, description: agent.description });
		return choice;
	});
	assert.deepEqual((await f.route()).routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 1);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	choice = "bogus";
	assert.deepEqual((await f.route()).routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(f.infer.mock.calls.length, 2);
	f.ctx.model = undefined;
	await assert.rejects(f.route(), /Classifier returned no valid decision/);
});

test("registered classifiers and chat routers both receive all 1997 eligible model pairs", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(
		Array.from({ length: 1997 }, (_, index) => ({ ...decisionModel, id: `m${index}` })),
	);
	const seen = new Set<string>();
	const classify = mockClassifier(f, (keys, id, context) => {
		assert.equal(id, "pair");
		const question = context.questions[id];
		assert.equal(question?.type, "choice");
		if (question?.type !== "choice") throw new Error("Expected Choice question");
		for (const key of Object.keys(question.criteria)) seen.add(key);
		return keys[0]!;
	});
	assert.equal((await f.route()).routerSelection.model, "decision-test/m0");
	assert.equal(seen.size, 1997);
	assert.ok(classify.mock.calls.length >= 1);
	f.ctx.getRouterModel = () => "decision-test/chat";
	let rank = 255;
	f.infer.mockImplementation(() =>
		messageStream(decisionMessage({ modelId: `decision-test/m${rank++}`, reasoningEffort: null })),
	);
	assert.equal((await f.route()).routerSelection.model, "decision-test/m255");
	assert.equal(f.infer.mock.calls.length, 3);
	const context = f.infer.mock.calls[0]![1];
	assert.equal(
		Object.keys(
			JSON.parse(context.messages.find((message) => message.role === "user")!.content as string).questions.pair
				.criteria,
		).length,
		1997,
	);
	const tools = getCurrentTools(context.messages);
	assert.ok(tools[0]);
	for (let index = 0; index < 1997; index++)
		assert.equal(
			Value.Check(tools[0].parameters, { modelId: `decision-test/m${index}`, reasoningEffort: null }),
			true,
		);
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
	const classify = mockClassifier(f, (keys) => {
		catalog.mockReturnValue([]);
		return keys[0]!;
	});
	await assert.rejects(f.route(), /no longer eligible/);
	assert.ok(classify.mock.calls.length >= 1);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("classifier provider failure cannot return a route without a current chat model", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(
		Array.from({ length: 256 }, (_, i) => ({ ...decisionModel, id: `m${i}` })),
	);
	const classify = mockClassifier(f);
	f.ctx.model = undefined;
	classify.mockRejectedValue(new Error("HTTP 422 private provider detail"));
	await assert.rejects(f.route(), /Classifier returned no valid decision/);
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("a registered classifier receives a complete short subagent task and its evals", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([{ ...decisionModel, id: "gpt-5.6-luna" }]);
	const expectedEvals = await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8");
	const classify = mockClassifier(f, (keys, _id, context) => {
		assert.equal(context.state.task, "Reply with exactly: Hello, world! No tools or file changes.");
		assert.equal(context.state.evals, expectedEvals);
		assert.equal(context.state.model_selection_guide, MODEL_SELECTION_GUIDE);
		assert.equal(context.state.policy, undefined);
		assert.equal(context.state.evidence, undefined);
		return keys[0]!;
	});
	const result = await f.route("Reply with exactly: Hello, world! No tools or file changes.");
	assert.equal(result.modelOverride, "decision-test/gpt-5.6-luna");
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("a classifier receives the intact near-limit task, evals, and two eligible pairs", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([
		{ ...decisionModel, id: "small-a" },
		{ ...decisionModel, id: "small-b", cost: { ...decisionModel.cost, input: 0.25, output: 0.5 } },
	]);
	const task = taskNearRoutingLimit();
	assert.ok(Buffer.byteLength(JSON.stringify(task), "utf8") > MODEL_ROUTING_TASK_BYTES - 200);
	const expectedEvals = await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8");
	const classify = mockClassifier(f, (keys, _id, context) => {
		assert.equal(context.state.task, task);
		assert.equal(context.state.evals, expectedEvals);
		assert.match(String(context.state.task), /{"quoted":"value\\n"}/);
		assert.match(String(context.state.task), /Ω界/);
		return keys[1] ?? keys[0]!;
	});
	const result = await f.route(task);
	assert.equal(result.modelOverride, "decision-test/small-b");
	assert.equal(classify.mock.calls.length, 2);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("long auto-routing tasks preserve protected requirements and both ends for a classifier", async () => {
	const f = await fixture();
	const notice = vi.spyOn(console, "warn").mockImplementation(() => {});
	const protectedText = "<keepContext>Review only. Never edit files.</keepContext>";
	const task = `Review this change.\n${"reference data ".repeat(10000)}${protectedText}${"more data ".repeat(10000)}\nReport defects.`;
	const classify = mockClassifier(f, (keys, _id, context) => {
		assert.ok(String(context.state.task).includes(protectedText));
		assert.match(String(context.state.task), /Review this change/);
		assert.match(String(context.state.task), /Report defects/);
		assert.ok(String(context.state.task).includes(TRUNCATED_MARKER));
		return keys[0]!;
	});
	assert.equal((await f.route(task)).modelOverride, "decision-test/chat");
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 0);
	assert.deepEqual(notice.mock.calls, []);
});

test("auto routing screens credentials even in omitted middle text", async () => {
	const f = await fixture();
	await assert.rejects(f.route(`${"a".repeat(30_000)}mock-chat-secret${"b".repeat(30_000)}`), /credential/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("classifier size rejection falls back to chat with the same truncated protected excerpt", async () => {
	const f = await fixture();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const classify = mockClassifier(f);
	classify.mockRejectedValue(new Error("request too large"));
	const task = `<keepContext>${"required detail ".repeat(3000)}</keepContext>`;
	await f.route(task);
	f.ctx.getRouterModel = () => "";
	await f.route(task);
	assert.equal(classify.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 2);
	const routed = String(
		JSON.parse(f.infer.mock.calls[0]![1].messages.find((message) => message.role === "user")!.content as string).state
			.task,
	);
	assert.equal(classify.mock.calls[0]![1].state.task, routed);
	assert.match(routed, /<keepContext>required detail/);
	assert.ok(routed.includes(TRUNCATED_MARKER));
	assert.ok(routed.endsWith("required detail </keepContext>"));
	assert.ok(Buffer.byteLength(JSON.stringify(routed), "utf8") <= MODEL_ROUTING_TASK_BYTES);
});

test("auto ranks three distinct models, excludes their other efforts, and replays without inference", async () => {
	const f = await fixture();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const models = ["a", "b", "c", "d"].map((id) => ({ ...reasoningModel, id }));
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(models);
	const ranked = [
		{ model: "second-provider/c", effort: "high" },
		{ model: "second-provider/a", effort: "low" },
		{ model: "second-provider/d", effort: "off" },
	];
	let index = 0;
	f.infer.mockImplementation((_model, context) => {
		now += 60_000;
		const { questions } = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string);
		const candidates = Object.values(questions.pair.criteria).map((entry) => JSON.parse(entry as string));
		for (const prior of ranked.slice(0, index)) assert.ok(candidates.every((pair) => pair.model !== prior.model));
		return messageStream(
			decisionMessage({ modelId: ranked[index]!.model, reasoningEffort: ranked[index++]!.effort }),
		);
	});
	const route = await f.route();
	assert.deepEqual(route.routerSelection, { ...ranked[0], fallbacks: ranked.slice(1) });
	assert.deepEqual(route.fallbackModels, ["second-provider/a:low", "second-provider/d:off"]);
	assert.ok(Object.isFrozen(route.routerSelection.fallbacks));
	const restored = await routeExecutionModel({ ctx: f.ctx, task: "replay", agent, selection: route.routerSelection });
	assert.deepEqual(restored.fallbackModels, route.fallbackModels);
	assert.equal(f.infer.mock.calls.length, 3);
	await assert.rejects(
		routeExecutionModel({
			ctx: f.ctx,
			task: "replay",
			agent,
			selection: {
				...ranked[0]!,
				fallbacks: [ranked[0]!],
			},
		}),
		/distinct models/,
	);
});

test.each([
	{ catalog: "reasoning-only", nullable: false },
	{ catalog: "mixed reasoning and non-reasoning", nullable: true },
])("the effort schema declares a type every enum value matches for a $catalog catalog", async ({ nullable }) => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(
		nullable ? [reasoningModel, decisionModel] : [reasoningModel],
	);
	const effortSchemas: JsonObject[] = [];
	f.infer.mockImplementation((_model, context) => {
		const [tool] = getCurrentTools(context.messages);
		const parameters = tool!.parameters as { properties: { reasoningEffort: JsonObject } };
		effortSchemas.push(parameters.properties.reasoningEffort);
		return messageStream(decisionMessage({ modelId: "second-provider/reasoner", reasoningEffort: "high" }));
	});
	const route = await f.route();
	assert.equal(route.modelOverride, "second-provider/reasoner:high");
	const strings = { type: "string", enum: ["off", "low", "high"] };
	assert.deepEqual(effortSchemas[0], nullable ? { anyOf: [strings, { type: "null" }] } : strings);
});

test("auto routing retains the full benchmark snapshot and distinct provider model IDs", async () => {
	const f = await fixture();
	const models = ["anthropic", "github-copilot"].map((provider) => ({
		...decisionModel,
		provider,
		id: "claude-fable-5",
	}));
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(models);
	const evals = await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8");
	let rank = 0;
	f.infer.mockImplementation((_model, context) => {
		const { state } = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string);
		assert.match(String(state.evals), /## Artificial Analysis Intelligence Index/);
		assert.match(String(state.evals), /\| claude-fable-5 \| Claude Fable 5 \(/);
		assert.match(String(state.evals), /`Cod`: Coding Index points/);
		assert.match(String(state.evals), /`Agt`: Agentic Index points/);
		assert.equal(state.evals, evals);
		assert.equal(state.model_selection_guide, MODEL_SELECTION_GUIDE);
		return messageStream(
			decisionMessage({ modelId: `${models[rank++]!.provider}/claude-fable-5`, reasoningEffort: null }),
		);
	});
	await f.route();
	assert.equal(rank, 2);
});
