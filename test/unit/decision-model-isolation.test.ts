// #3089/#3090/#4358: an SDK structured-output call chooses its own model; the structured_output tool without its own
// model starts on the session's configured decision model.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { afterEach, test, vi } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { generateStructuredOutput } from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	createStructuredOutputCapture,
	createStructuredOutputTool,
} from "../../packages/coding-agent/src/core/tools/structured-output.js";
import {
	classifierResult,
	decisionChatModel,
	decisionMessage,
	decisionRequest,
	decisionSchema,
	inferenceRequestTools,
	messageStream,
	parseInferenceUserPayload,
	registeredDecisionRuntime,
	routeModel,
	structuredOutputRequest,
} from "../helpers/structured-output.js";

function classifierWireResponse(body: string) {
	const request = JSON.parse(body) as { questions: Record<string, { criteria: Record<string, string> }> };
	return {
		model: "jev-latest",
		usage: { input_tokens: 20, output_tokens: 10 },
		answers: Object.fromEntries(
			Object.entries(request.questions).map(([id, question]) => {
				const keys = Object.keys(question.criteria);
				const choice = keys.find((key) => key === "review" || key === '"review"' || key === "exact") ?? keys[0]!;
				return [id, { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 }];
			}),
		),
	};
}

/**
 * Structural cost, not a slow test: each case builds a real AgentSession with its
 * resource loader and tool registry, which takes over half the default budget on
 * Windows runners. Do not reuse this budget for a test that merely inspects data.
 */
const AGENT_SESSION_CONSTRUCTION_TIMEOUT_MS = 90_000;

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

for (const decisionModel of ["typesafe/jev-latest", "auto", "missing/model"]) {
	test(`general structured-output inference ignores decisionModel=${decisionModel} and environment preference`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const transport = vi.fn(async () => Response.json(classifierResult()));
		vi.stubGlobal("fetch", transport);
		const settings = SettingsManager.inMemory({ decisionModel });
		const readSetting = vi.spyOn(settings, "getDecisionModel");
		const dispatch = vi.fn((model) => {
			assert.equal(model.provider, decisionChatModel.provider);
			assert.equal(model.id, decisionChatModel.id);
			return messageStream(decisionMessage());
		});
		const { registry } = await registeredDecisionRuntime(dispatch);
		const result = await generateStructuredOutput({
			...structuredOutputRequest(),
			schema: decisionSchema,
			modelRegistry: registry,
			model: "decision-test/chat",
		});
		assert.equal(result.model, "decision-test/chat");
		assert.deepEqual(result.value, { route: "review", limit: 1.23456789 });
		assert.equal(dispatch.mock.calls.length, 1);
		assert.equal(transport.mock.calls.length, 0);
		assert.equal(readSetting.mock.calls.length, 0);
	});
}

test("general structured-output can explicitly select a registered classifier without reading router settings", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
		Response.json(classifierWireResponse(String(init?.body))),
	);
	vi.stubGlobal("fetch", transport);
	const settings = SettingsManager.inMemory({ decisionModel: "decision-test/chat" });
	const readSetting = vi.spyOn(settings, "getDecisionModel");
	const { registry } = await registeredDecisionRuntime(() => messageStream(decisionMessage()));
	const result = await generateStructuredOutput({
		...structuredOutputRequest(),
		modelRegistry: registry,
		model: "typesafe/jev-latest",
	});
	assert.equal(result.model, "typesafe/jev-latest");
	assert.deepEqual(result.value, { route: "review" });
	assert.equal(readSetting.mock.calls.length, 0);
	assert.equal(transport.mock.calls.length, 1);
});

test("general structured output defaults to the current chat model, not decisionModel or a TypeSafe key", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () => Response.json(classifierResult()));
	vi.stubGlobal("fetch", transport);
	const dispatch = vi.fn(() => messageStream(decisionMessage()));
	const result = await generateStructuredOutput({
		...structuredOutputRequest(),
		schema: decisionSchema,
		modelRegistry: { getAll: () => [decisionChatModel], streamSimple: dispatch },
	});
	assert.equal(result.model, "decision-test/chat");
	assert.equal(dispatch.mock.calls.length, 1);
	await assert.rejects(
		generateStructuredOutput({ ...structuredOutputRequest(), currentModel: undefined }),
		/currentModel/,
	);
	assert.equal(dispatch.mock.calls.length, 1);
	assert.equal(transport.mock.calls.length, 0);
});

test("ordinary routing keeps the complete candidate set beyond one provider's Choice limit", async () => {
	const request = decisionRequest();
	const candidates = Array.from({ length: 256 }, (_, index) => ({
		id: `candidate-${index}`,
		description: `Exact candidate ${index}`,
	}));
	const criteria = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.description]));
	const dispatch = vi.fn((_model, context) => {
		assert.deepEqual(parseInferenceUserPayload(context).state?.candidates, candidates);
		return messageStream(decisionMessage({ route: "review" }));
	});
	const { registry } = await registeredDecisionRuntime(dispatch);
	const result = await routeModel({
		...request,
		modelRegistry: registry,
		state: { ...request.state, candidates },
		classifier: {
			questions: { result: { instructions: "Select from the complete candidates", criteria } },
			decode: () => ({ route: "review" as const }),
		},
	});
	assert.deepEqual(result.value, { route: "review" });
	assert.equal(dispatch.mock.calls.length, 1);
});

test("routing entrypoint alone applies the decisionModel setting", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () => Response.json(classifierResult()));
	vi.stubGlobal("fetch", transport);
	const { registry } = await registeredDecisionRuntime(() => messageStream(decisionMessage()));
	const result = await routeModel({
		...decisionRequest(),
		modelRegistry: registry,
		settings: SettingsManager.inMemory({ decisionModel: "typesafe/jev-latest" }),
	});
	assert.equal(result.model, "typesafe/jev-latest");
	assert.equal(transport.mock.calls.length, 1);
});

const routeSchema = Type.Object(
	{ route: Type.Union([Type.Literal("none"), Type.Literal("review")]) },
	{ additionalProperties: false },
);

for (const [decisionModel, classified] of [
	["typesafe/jev-latest", true],
	["auto", false],
] as const) {
	test(
		`structured_output session tool starts on the decision model and keeps the chat model with decisionModel=${decisionModel} (#4358)`,
		async () => {
			vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
			const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
				Response.json(classifierWireResponse(String(init?.body))),
			);
			vi.stubGlobal("fetch", transport);
			let calls = 0;
			const dispatch = vi.fn((model, context) => {
				assert.equal(model.id, decisionChatModel.id);
				assert.equal(model.provider, decisionChatModel.provider);
				assert.ok(inferenceRequestTools(context).some((tool) => tool.name === "structured_output"));
				return messageStream(
					decisionMessage(
						++calls === 1
							? { instructions: "Return the review route.", state: { task: "Review the patch" } }
							: { route: "review" },
					),
				);
			});
			const { runtime } = await registeredDecisionRuntime(dispatch);
			const settings = SettingsManager.inMemory({
				decisionModel,
				defaultModel: "chat",
				defaultProvider: "decision-test",
			});
			const readSetting = vi.spyOn(settings, "getDecisionModel");
			const cwd = mkdtempSync(join(tmpdir(), "atomic-router-isolation-"));
			const capture = createStructuredOutputCapture<Static<typeof routeSchema>>();
			const tool = createStructuredOutputTool({ schema: routeSchema, capture });
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir: cwd,
				settingsManager: settings,
				builtinPackagePaths: [],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			try {
				await loader.reload();
				const { session } = await createAgentSession({
					cwd,
					agentDir: cwd,
					modelRuntime: runtime,
					model: decisionChatModel,
					settingsManager: settings,
					sessionManager: SessionManager.inMemory(cwd),
					resourceLoader: loader,
					builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: true },
					customTools: [tool],
					tools: ["structured_output"],
				});
				try {
					await session.prompt("Return the structured result.");
					assert.equal(session.model?.id, decisionChatModel.id);
					assert.equal(session.model?.provider, decisionChatModel.provider);
					assert.equal(capture.called, true);
					assert.deepEqual(capture.value, { route: "review" });
					assert.equal(dispatch.mock.calls.length, classified ? 1 : 2);
					assert.equal(transport.mock.calls.length, classified ? 1 : 0);
					assert.ok(readSetting.mock.calls.length > 0);
				} finally {
					session.dispose();
				}
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
		AGENT_SESSION_CONSTRUCTION_TIMEOUT_MS,
	);
}
