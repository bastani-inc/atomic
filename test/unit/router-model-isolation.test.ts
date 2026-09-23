// #3089/#3090: routerModel is routing-only, never a general structured-output model override.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Static } from "typebox";
import { afterEach, test, vi } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	inferRouterDecision,
	inferStructuredOutput,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	createStructuredOutputCapture,
	createStructuredOutputTool,
} from "../../packages/coding-agent/src/core/tools/structured-output.js";
import {
	decisionMessage,
	decisionModel,
	decisionRequest,
	decisionSchema,
	inferenceRequestTools,
	jevResponse,
	messageStream,
	parseInferenceUserPayload,
	registeredDecisionRuntime,
} from "../helpers/structured-output.js";

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

for (const routerModel of ["typesafe/jev-latest", "auto", "missing/model"]) {
	test(`general structured-output inference ignores routerModel=${routerModel} and environment preference`, async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
		const transport = vi.fn(async () => Response.json(jevResponse()));
		vi.stubGlobal("fetch", transport);
		const settings = SettingsManager.inMemory({ routerModel });
		const readSetting = vi.spyOn(settings, "getRouterModel");
		const dispatch = vi.fn((model) => {
			assert.equal(model.provider, decisionModel.provider);
			assert.equal(model.id, decisionModel.id);
			return messageStream(decisionMessage());
		});
		const { registry } = await registeredDecisionRuntime(dispatch);
		const request = {
			...decisionRequest(),
			settings,
			modelRegistry: registry,
			model: { kind: "chat" as const, fullId: "decision-test/chat", model: decisionModel },
		};
		const result = await inferStructuredOutput(request);
		assert.equal(result.model, "decision-test/chat");
		assert.equal(dispatch.mock.calls.length, 1);
		assert.equal(transport.mock.calls.length, 0);
		assert.equal(readSetting.mock.calls.length, 0);
	});
}

test("general structured-output can explicitly select Jev without reading router settings", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () => Response.json(jevResponse()));
	vi.stubGlobal("fetch", transport);
	const request = decisionRequest();
	const result = await inferStructuredOutput({ ...request, model: { kind: "jev", fullId: "typesafe/jev-latest" } });
	assert.equal(result.model, "typesafe/jev-latest");
	assert.equal(request.settings.getRouterModel(), "decision-test/chat");
	assert.equal(transport.mock.calls.length, 1);
});

test("general structured output requires an explicit model even with router settings and a TypeSafe key", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () => Response.json(jevResponse()));
	vi.stubGlobal("fetch", transport);
	// @ts-expect-error General calls do not inherit a router/chat selection, at compile time or runtime.
	await assert.rejects(inferStructuredOutput(decisionRequest()), /requires an explicit concrete inference model/);
	assert.equal(transport.mock.calls.length, 0);
});

test("ordinary routing keeps the complete candidate set beyond Jev's Choice limit", async () => {
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
	const result = await inferRouterDecision({
		...request,
		modelRegistry: registry,
		state: { ...request.state, candidates },
		jev: {
			questions: { result: { instructions: "Select from the complete candidates", criteria } },
			decode: () => ({ route: "review" as const }),
		},
	});
	assert.deepEqual(result.value, { route: "review" });
	assert.equal(dispatch.mock.calls.length, 1);
});

test("routing entrypoint alone applies the routerModel setting", async () => {
	vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
	const transport = vi.fn(async () => Response.json(jevResponse()));
	vi.stubGlobal("fetch", transport);
	const result = await inferRouterDecision({
		...decisionRequest(),
		settings: SettingsManager.inMemory({ routerModel: "typesafe/jev-latest" }),
	});
	assert.equal(result.model, "typesafe/jev-latest");
	assert.equal(transport.mock.calls.length, 1);
});

for (const routerModel of ["typesafe/jev-latest", "auto"]) {
	test(
		`structured_output session tool keeps the chat model with routerModel=${routerModel}`,
		async () => {
			vi.stubEnv("TYPESAFE_API_KEY", "mock-key");
			const transport = vi.fn(async () => Response.json(jevResponse()));
			vi.stubGlobal("fetch", transport);
			const dispatch = vi.fn((model, context) => {
				assert.equal(model.id, decisionModel.id);
				assert.equal(model.provider, decisionModel.provider);
				assert.ok(inferenceRequestTools(context).some((tool) => tool.name === "structured_output"));
				return messageStream(decisionMessage({ route: "review" }));
			});
			const { runtime } = await registeredDecisionRuntime(dispatch);
			const settings = SettingsManager.inMemory({
				routerModel,
				defaultModel: "chat",
				defaultProvider: "decision-test",
			});
			const readSetting = vi.spyOn(settings, "getRouterModel");
			const cwd = mkdtempSync(join(tmpdir(), "atomic-router-isolation-"));
			const capture = createStructuredOutputCapture<Static<typeof decisionSchema>>();
			const tool = createStructuredOutputTool({ schema: decisionSchema, capture });
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
					model: decisionModel,
					settingsManager: settings,
					sessionManager: SessionManager.inMemory(cwd),
					resourceLoader: loader,
					builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: true },
					customTools: [tool],
					tools: ["structured_output"],
				});
				try {
					await session.prompt("Return the structured result.");
					assert.equal(session.model?.id, decisionModel.id);
					assert.equal(session.model?.provider, decisionModel.provider);
					assert.equal(capture.called, true);
					assert.deepEqual(capture.value, { route: "review" });
					assert.equal(dispatch.mock.calls.length, 1);
					assert.equal(transport.mock.calls.length, 0);
					assert.equal(readSetting.mock.calls.length, 0);
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
