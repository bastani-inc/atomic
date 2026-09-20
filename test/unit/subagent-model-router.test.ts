// #3090: real shared inference with mocked provider transports, never live API calls.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@bastani/atomic";
import {
	type Api,
	createAssistantMessageEventStream,
	getCurrentTools,
	type JsonObject,
	type Model,
} from "@bastani/pi-ai";
import { Value } from "typebox/value";
import { afterEach, beforeEach, test, vi } from "vitest";
import { routeExecutionModel } from "../../packages/coding-agent/src/core/execution-model-router.js";
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
import { type JevFixtureRequest, jevFixtureResponse } from "../helpers/jev-tournament.js";
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
		messageStream(decisionMessage({ model: "decision-test/chat", effort: null })),
	);
	const { registry } = await registeredDecisionRuntime(infer);
	const ctx = {
		model: decisionModel,
		modelRegistry: registry,
		getRouterModel: () => "decision-test/chat",
	} as ExtensionContext;
	return { ctx, infer, route: (task = "Fix the approved defect") => routeSubagentModel({ ctx, agent, task }) };
}

function jevPayloadBytes(body: string): { total: number; stateAndLongestQuestion: number } {
	const request = JSON.parse(body) as JevFixtureRequest & { model?: string };
	return {
		total: Buffer.byteLength(body, "utf8"),
		stateAndLongestQuestion: Math.max(
			...Object.entries(request.questions).map(([id, question]) =>
				Buffer.byteLength(
					JSON.stringify({ model: request.model, state: request.state, questions: { [id]: question } }),
					"utf8",
				),
			),
		),
	};
}

const ROUTING_STATE_AND_LONGEST_BYTES = 30_000;
const ROUTING_STATE_AND_ALL_BYTES = 48_000;

test("execution routing keeps the real evals, 12KB task, and nine verbose candidates within Jev budgets", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const evals = await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8");
	const candidates = Array.from({ length: 9 }, (_, index) => ({
		...decisionModel,
		id: `candidate-${index + 1}`,
		name: `Verbose candidate ${index + 1} with a catalog description`,
		contextWindow: 128_000,
		cost: { input: 1.25, output: 7.5, cacheRead: 0.2, cacheWrite: 1.5 },
	}));
	const seen = new Set<string>();
	let maxTotal = 0;
	let maxStateAndLongest = 0;
	const transport = vi.fn(async (_url: string, init: RequestInit) => {
		const body = String(init.body);
		const size = jevPayloadBytes(body);
		maxTotal = Math.max(maxTotal, size.total);
		maxStateAndLongest = Math.max(maxStateAndLongest, size.stateAndLongestQuestion);
		const request = JSON.parse(body) as JevFixtureRequest;
		assert.equal(request.state.evals, evals);
		for (const question of Object.values(request.questions)) {
			for (const [key, value] of Object.entries(question.criteria)) {
				const candidate = JSON.parse(value) as { model: string };
				seen.add(candidate.model);
				assert.match(key, /^pair_\d+$/u);
			}
		}
		return Response.json(jevFixtureResponse(request));
	});
	vi.stubGlobal("fetch", transport);
	const result = await routeExecutionModel({
		ctx: {
			model: decisionModel,
			getRouterModel: () => "typesafe-ai/jev-latest",
			modelRegistry: {
				getAll: () => candidates,
				getAvailable: () => candidates,
				containsConfiguredCredential: async () => false,
				streamSimple: () => {
					throw new Error("Jev should make the decision");
				},
			},
		},
		task: taskNearRoutingLimit(),
		agent,
	});
	assert.equal(transport.mock.calls.length, 3);
	assert.equal(seen.size, candidates.length);
	assert.ok(
		maxStateAndLongest <= ROUTING_STATE_AND_LONGEST_BYTES,
		`${maxStateAndLongest} > ${ROUTING_STATE_AND_LONGEST_BYTES}`,
	);
	assert.ok(maxTotal <= ROUTING_STATE_AND_ALL_BYTES, `${maxTotal} > ${ROUTING_STATE_AND_ALL_BYTES}`);
	assert.equal(result.routerSelection.model, "decision-test/candidate-1");
});

function taskNearRoutingLimit(): string {
	const seed = 'Route this exact task; preserve JSON characters {"quoted":"value\\n"} and Unicode Ω界. ';
	const protectedRequirement =
		"<keepContext>Keep this exact protected requirement Ω and do not drop it.</keepContext>";
	let task = `${seed}${"context ".repeat(1000)}${protectedRequirement}`;
	while (Buffer.byteLength(JSON.stringify(`${task} tail`), "utf8") <= 11_900) task = `${task} tail`;
	return task;
}
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
	assert.equal(state.model_selection_guide, undefined);
	assert.equal(state.evals, await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8"));
	assert.match(state.evals, /# Evals/);
	assert.match(state.evals, /DeepSWE/);
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
	{ model: "auto", effort: null },
	{ model: "decision-test/chat", effort: "off" },
	{ model: "decision-test/chat", effort: null, extra: true },
];
for (const answer of invalidPairs) {
	test(`invalid pair rejected: ${JSON.stringify(answer)}`, async () => {
		const f = await fixture();
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
		return messageStream(decisionMessage({ model: "second-provider/reasoner", effort: "high" }));
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
		return messageStream(decisionMessage({ model: "second-provider/reasoner", effort: "low" }));
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
		if (candidates.length === 1) return messageStream(decisionMessage({ model: "decision-test/chat", effort: null }));
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
					? { model: "second-provider/reasoner", effort: "high" }
					: { model: "second-provider/reasoner", effort: "off" },
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
		messageStream(decisionMessage({ model: "second-provider/reasoner", effort: "low" })),
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
		return messageStream(decisionMessage({ model: "decision-test/chat", effort: null }));
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
			/Auto routing requires a nonempty evals\.md document within 16,000 JSON-encoded bytes/,
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

test("provider failure, cancellation and late responses never become selections", async () => {
	const f = await fixture();
	f.infer.mockImplementation(() => {
		throw new Error("mock provider failure");
	});
	await assert.rejects(f.route(), /provider request failed/);
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
		message: decisionMessage({ model: "decision-test/chat", effort: null }),
	});
	await assert.rejects(pending, /cancelled|abort/i);
});

test("routing timeout is bounded with no semantic retry", async () => {
	const f = await fixture();
	vi.useFakeTimers();
	const entered = Promise.withResolvers<void>();
	f.infer.mockImplementation(() => {
		entered.resolve();
		return createAssistantMessageEventStream();
	});
	const rejected = assert.rejects(f.route(), /timed out/);
	await entered.promise;
	await vi.advanceTimersByTimeAsync(30001);
	await rejected;
	assert.equal(f.infer.mock.calls.length, 1);
});

test("Jev uses one Choice over complete pairs and deterministically maps the selected key", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	f.ctx.getRouterModel = () => "";
	const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(init?.body as string);
		assert.equal(body.model, "jev-latest");
		assert.equal(body.state.task, "Fix the approved defect");
		assert.deepEqual(body.state.agent, { name: agent.name, description: agent.description });
		return Response.json({
			model: "jev-latest",
			answers: { pair: { type: "choice", choice: "pair_0", probabilities: { pair_0: 1 }, confidence: 1 } },
			usage: { input_tokens: 1, output_tokens: 1 },
		});
	});
	vi.stubGlobal("fetch", fetch);
	assert.deepEqual((await f.route()).routerSelection, { model: "decision-test/chat", effort: null });
	assert.equal(fetch.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 0);
	f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	fetch.mockImplementation(async () =>
		Response.json({
			answers: { pair: { type: "choice", choice: "bogus", probabilities: { bogus: 1 }, confidence: 1 } },
		}),
	);
	await assert.rejects(f.route(), /choice|invalid|malformed/i);
});

test("Jev covers 1997 pairs without filtering; ordinary router retains full catalog", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(
		Array.from({ length: 1997 }, (_, index) => ({ ...decisionModel, id: `m${index}` })),
	);
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	f.ctx.getRouterModel = () => "";
	const seen = new Set<string>();
	const fetch = vi.fn(async (_url: string, init: RequestInit) => {
		const request = JSON.parse(String(init.body)) as JevFixtureRequest;
		for (const q of Object.values(request.questions)) {
			assert.ok(Object.keys(q.criteria).length <= 255);
			for (const key of Object.keys(q.criteria)) seen.add(key);
		}
		return Response.json(jevFixtureResponse(request));
	});
	vi.stubGlobal("fetch", fetch);
	assert.equal((await f.route()).routerSelection.model, "decision-test/m0");
	assert.equal(seen.size, 1997);
	assert.ok(fetch.mock.calls.length > 1);
	f.ctx.getRouterModel = () => "decision-test/chat";
	let rank = 255;
	f.infer.mockImplementation(() =>
		messageStream(decisionMessage({ model: `decision-test/m${rank++}`, effort: null })),
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
		assert.equal(Value.Check(tools[0].parameters, { model: `decision-test/m${index}`, effort: null }), true);
});

test("configured credential text is rejected before inference", async () => {
	const f = await fixture();
	await assert.rejects(f.route("Task contains mock-chat-secret"), /credential/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("default reasoning catalog does not invent extended effort support", async () => {
	const f = await fixture();
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([{ ...reasoningModel, thinkingLevelMap: undefined }]);
	f.infer.mockImplementation(() =>
		messageStream(decisionMessage({ model: "second-provider/reasoner", effort: "max" })),
	);
	await assert.rejects(f.route(), /Invalid structured output/);
});

test("router model precedence preserves chat fallback and rejects recursive or invalid explicit configuration", async () => {
	const f = await fixture();
	f.ctx.getRouterModel = () => "";
	await f.route();
	assert.equal(f.infer.mock.calls[0]![0].id, decisionModel.id);
	f.ctx.getRouterModel = () => "auto";
	await assert.rejects(f.route(), /auto|concrete/i);
	f.ctx.getRouterModel = () => "missing/model";
	await assert.rejects(f.route(), /Invalid routerModel/);
	assert.equal(f.infer.mock.calls.length, 1);
	assert.equal(f.ctx.model, decisionModel);
});

for (const failure of ["stale", "provider"] as const) {
	test(`overflow subagent ${failure} fails before returning a route`, async () => {
		const f = await fixture();
		const catalog = vi
			.spyOn(f.ctx.modelRegistry, "getAvailable")
			.mockReturnValue(Array.from({ length: 256 }, (_, i) => ({ ...decisionModel, id: `m${i}` })));
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
		f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			const request = JSON.parse(String(init.body)) as JevFixtureRequest;
			if (request.questions.pair) {
				if (failure === "provider") return new Response("private", { status: 422 });
				catalog.mockReturnValue([]);
			}
			return Response.json(jevFixtureResponse(request));
		});
		vi.stubGlobal("fetch", fetch);
		await assert.rejects(f.route(), failure === "stale" ? /no longer eligible/ : /HTTP 422/);
		assert.ok(fetch.mock.calls.length > 1);
		assert.equal(f.infer.mock.calls.length, 0);
	});
}

test("hello-world routing receives evals and fits one small Jev request", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue([{ ...decisionModel, id: "gpt-5.6-luna" }]);
	const transport = vi.fn(async (_url: string, init: RequestInit) =>
		Response.json(jevFixtureResponse(JSON.parse(String(init.body)) as JevFixtureRequest)),
	);
	vi.stubGlobal("fetch", transport);
	const result = await f.route("Reply with exactly: Hello, world! No tools or file changes.");
	assert.equal(result.modelOverride, "decision-test/gpt-5.6-luna");
	assert.equal(transport.mock.calls.length, 1);
	const body = String(transport.mock.calls[0]![1].body);
	const payload = JSON.parse(body);
	assert.equal(payload.state.task, "Reply with exactly: Hello, world! No tools or file changes.");
	assert.equal(payload.state.evals, await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8"));
	const stateAndQuestionBytes = Math.max(
		...Object.entries(payload.questions as Record<string, unknown>).map(([id, question]) =>
			Buffer.byteLength(
				JSON.stringify({ model: payload.model, state: payload.state, questions: { [id]: question } }),
				"utf8",
			),
		),
	);
	assert.ok(Buffer.byteLength(body) <= 48_000);
	assert.ok(stateAndQuestionBytes <= 30_000);
	assert.match(payload.state.evals, /# Evals/);
	assert.equal(payload.state.model_selection_guide, undefined);
	assert.equal(payload.state.policy, undefined);
	assert.equal(payload.state.evidence, undefined);
});

test("maximal real eval routing payload preserves prompt and stays under conservative Jev bytes", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	const models = [
		{ ...decisionModel, id: "small-a" },
		{ ...decisionModel, id: "small-b", cost: { ...decisionModel.cost, input: 0.25, output: 0.5 } },
	];
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(models);
	const evals = await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8");
	const task = taskNearRoutingLimit();
	assert.ok(Buffer.byteLength(JSON.stringify(task), "utf8") > 11_800);
	const transport = vi.fn(async (_url: string, init: RequestInit) => {
		const body = String(init.body);
		const bytes = jevPayloadBytes(body);
		assert.ok(bytes.stateAndLongestQuestion <= 30_000, String(bytes.stateAndLongestQuestion));
		assert.ok(bytes.total <= 48_000, String(bytes.total));
		const request = JSON.parse(body) as JevFixtureRequest & { model: string };
		assert.equal(request.state.task, task);
		assert.equal(request.state.evals, evals);
		assert.match(String(request.state.task), /{"quoted":"value\\n"}/);
		assert.match(String(request.state.task), /Ω界/);
		assert.ok(Object.keys(request.questions.pair.criteria).length <= 2);
		return Response.json(jevFixtureResponse(request, (keys) => keys[1] ?? keys[0]!));
	});
	vi.stubGlobal("fetch", transport);
	const result = await f.route(task);
	assert.equal(result.modelOverride, "decision-test/small-b");
	assert.equal(transport.mock.calls.length, 2);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("real eval routing tournament preserves evals in every Jev request", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(
		Array.from({ length: 9 }, (_, index) => ({ ...decisionModel, id: `candidate-${index}` })),
	);
	const evals = await fs.readFile("packages/coding-agent/docs/models/evals.md", "utf8");
	const seen = new Set<string>();
	const transport = vi.fn(async (_url: string, init: RequestInit) => {
		const body = String(init.body);
		const bytes = jevPayloadBytes(body);
		assert.ok(bytes.stateAndLongestQuestion <= 30_000, String(bytes.stateAndLongestQuestion));
		assert.ok(bytes.total <= 48_000, String(bytes.total));
		const request = JSON.parse(body) as JevFixtureRequest;
		assert.equal(request.state.evals, evals);
		for (const question of Object.values(request.questions)) {
			for (const criterion of Object.values(question.criteria)) seen.add(JSON.parse(criterion).model as string);
		}
		return Response.json(jevFixtureResponse(request));
	});
	vi.stubGlobal("fetch", transport);
	const result = await f.route("Select among a practical tournament catalog without editing the execution prompt.");
	assert.equal(result.modelOverride, "decision-test/candidate-0");
	assert.equal(seen.size, 9);
	assert.ok(transport.mock.calls.length > 1);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("long auto-routing tasks fit Jev while preserving protected requirements and both ends", async () => {
	const f = await fixture();
	const notice = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	const protectedText = "<keepContext>Review only. Never edit files.</keepContext>";
	const task = `Review this change.\n${"reference data ".repeat(10000)}${protectedText}${"more data ".repeat(10000)}\nReport defects.`;
	const transport = vi.fn(async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		assert.ok(Buffer.byteLength(String(init.body)) < 30_000);
		assert.ok(body.state.task.includes(protectedText));
		assert.match(body.state.task, /Review this change/);
		assert.match(body.state.task, /Report defects/);
		assert.match(body.state.task, /omitted/);
		return Response.json(jevFixtureResponse(body));
	});
	vi.stubGlobal("fetch", transport);
	assert.equal((await f.route(task)).modelOverride, "decision-test/chat");
	assert.equal(transport.mock.calls.length, 1);
	assert.equal(f.infer.mock.calls.length, 0);
	// Routing-only truncation is invisible to the user: no console notice.
	assert.deepEqual(notice.mock.calls, []);
});

test("auto routing screens credentials even in omitted middle text", async () => {
	const f = await fixture();
	await assert.rejects(f.route(`${"a".repeat(30_000)}mock-chat-secret${"b".repeat(30_000)}`), /credential/);
	assert.equal(f.infer.mock.calls.length, 0);
});

test("oversized protected tasks still fall back intact or fail when Jev is pinned", async () => {
	const f = await fixture();
	vi.stubEnv("TYPESAFE_API_KEY", "synthetic-jev-key");
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const transport = vi.fn();
	vi.stubGlobal("fetch", transport);
	const task = `<keepContext>${"required detail ".repeat(3000)}</keepContext>`;
	f.ctx.getRouterModel = () => "typesafe-ai/jev-latest";
	await assert.rejects(f.route(task), /conservative input budget/);
	f.ctx.getRouterModel = () => "";
	await f.route(task);
	assert.equal(transport.mock.calls.length, 0);
	assert.equal(f.infer.mock.calls.length, 1);
	assert.equal(
		JSON.parse(f.infer.mock.calls[0]![1].messages.find((message) => message.role === "user")!.content as string).state
			.task,
		task,
	);
});

test("auto ranks three distinct models, excludes their other efforts, and replays without inference", async () => {
	const f = await fixture();
	const models = ["a", "b", "c", "d"].map((id) => ({ ...reasoningModel, id }));
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(models);
	const ranked = [
		{ model: "second-provider/c", effort: "high" },
		{ model: "second-provider/a", effort: "low" },
		{ model: "second-provider/d", effort: "off" },
	];
	let index = 0;
	f.infer.mockImplementation((_model, context) => {
		const { questions } = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string);
		const candidates = Object.values(questions.pair.criteria).map((entry) => JSON.parse(entry as string));
		for (const prior of ranked.slice(0, index)) assert.ok(candidates.every((pair) => pair.model !== prior.model));
		return messageStream(decisionMessage(ranked[index++]));
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

test("auto routing keeps exact benchmark identity and provenance distinctions", async () => {
	const f = await fixture();
	const models = ["anthropic", "github-copilot"].map((provider) => ({
		...decisionModel,
		provider,
		id: "claude-fable-5",
	}));
	vi.spyOn(f.ctx.modelRegistry, "getAvailable").mockReturnValue(models);
	let rank = 0;
	f.infer.mockImplementation((_model, context) => {
		const { state } = JSON.parse(context.messages.find((message) => message.role === "user")!.content as string);
		assert.match(state.evals, /Fable 5 fallback=Opus 4\.8/);
		assert.match(state.evals, /Fable 5\.1 Default Fallback/);
		assert.match(state.evals, /Inkling AA `xhigh` is distinct from Frontier `0\.99`/);
		assert.match(state.evals, /Harness: `cc`=claude-code, `gb`=grok-build, `msa`=mini-swe-agent/);
		assert.match(state.evals, /`—`=source null, not 0/);
		assert.match(state.evals, /\| GPT-6 Astra \| max \| codex \| 53\.3 \| 58\.8 \| — \| 4\.59 \| 30\.1 \|/);
		assert.match(state.evals, /\| Claude Fable 5\.1 \| medium \| cc \| 50\.9 \| 55\.5 \| 0\.0 \| 3\.28 \| 26\.1 \|/);
		assert.equal(state.model_selection_guide, undefined);
		return messageStream(decisionMessage({ model: `${models[rank++]!.provider}/claude-fable-5`, effort: null }));
	});
	await f.route();
	assert.equal(rank, 2);
});
