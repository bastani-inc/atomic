import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getApiProvider,
	type Model,
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { OrchestrationContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";

function model(provider: string, api: Api): Model<Api> {
	return {
		id: `${provider}-model`, name: `${provider} model`, provider, api,
		baseUrl: `https://${provider}.invalid`, reasoning: false, input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8_000, maxTokens: 1_000,
	};
}

function done(requestModel: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "text", text }], api: requestModel.api,
		provider: requestModel.provider, model: requestModel.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	};
	stream.end(message);
	return stream;
}

describe("registry-owned custom stream dispatch", () => {
	test("keeps handlers scoped by registry and selects the exact provider when APIs are shared", () => {
		const api = "registry-owned-shared-api" as Api;
		const first = ModelRegistry.inMemory(AuthStorage.inMemory());
		const second = ModelRegistry.inMemory(AuthStorage.inMemory());
		const firstHandler = (requestModel: Model<Api>) => done(requestModel, "first");
		const secondHandler = (requestModel: Model<Api>) => done(requestModel, "second");
		const aliasHandler = (requestModel: Model<Api>) => done(requestModel, "alias");
		first.registerProvider("shared-provider", { api, streamSimple: firstHandler });
		second.registerProvider("shared-provider", { api, streamSimple: secondHandler });
		first.registerProvider("alias-provider", { api, streamSimple: aliasHandler });
		try {
			assert.equal(first.getRegisteredStreamSimple(model("shared-provider", api)), firstHandler);
			assert.equal(second.getRegisteredStreamSimple(model("shared-provider", api)), secondHandler);
			assert.equal(first.getRegisteredStreamSimple(model("alias-provider", api)), aliasHandler);
			assert.equal(first.getRegisteredStreamSimple(model("shared-provider", "other-api" as Api)), undefined);
			assert.equal(first.getRegisteredStreamSimple(model("missing-provider", api)), undefined);
		} finally {
			first.unregisterProvider("alias-provider");
			second.unregisterProvider("shared-provider");
			first.unregisterProvider("shared-provider");
		}
	});

	test("preserves the public API-level custom stream capability query", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const api = "registry-capability-api" as Api;
		assert.equal(registry.hasRegisteredStreamSimpleForApi(api), false);
		registry.registerProvider("capability-provider", { api, streamSimple: (requestModel) => done(requestModel, "capability") });
		try {
			assert.equal(registry.hasRegisteredStreamSimpleForApi(api), true);
			assert.equal(registry.hasRegisteredStreamSimpleForApi("other-api" as Api), false);
		} finally {
			registry.unregisterProvider("capability-provider");
		}
		assert.equal(registry.hasRegisteredStreamSimpleForApi(api), false);
	});

	test("retains global compatibility fallback for a standard API without a registry handler", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-provider-stream-fallback-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const source = `standard-fallback-${Date.now()}-${Math.random()}`;
		const requestModel = model("standard-provider", "openai-completions");
		let globalCalls = 0;
		registerApiProvider({
			api: requestModel.api,
			stream: (streamModel) => { globalCalls += 1; return done(streamModel, "global"); },
			streamSimple: (streamModel) => { globalCalls += 1; return done(streamModel, "global"); },
		}, source);
		try {
			const auth = AuthStorage.inMemory();
			auth.setRuntimeApiKey(requestModel.provider, "test-key");
			const registry = ModelRegistry.inMemory(auth);
			assert.equal(registry.getRegisteredStreamSimple(requestModel), undefined);
			const sessions: Array<{ dispose(): void }> = [];
			const create = async (orchestrationContext?: OrchestrationContext) => {
				const settings = SettingsManager.inMemory();
				const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
				await loader.reload();
				const created = await createAgentSession({
					cwd, agentDir, authStorage: auth, modelRegistry: registry, model: requestModel,
					settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
					orchestrationContext,
				});
				sessions.push(created.session);
				return created.session;
			};
			try {
				const main = await create();
				const workflow = await create({
					kind: "workflow-stage", workflowRunId: "standard-run", workflowStageId: "standard-stage",
					workflowStageName: "Standard stage", constraints: { disableWorkflowTool: true, maxSubagentDepth: 0 },
				});
				const run = async (session: typeof main) => (await session.agent.streamFunction(requestModel, { messages: [] })).result();
				const [mainResult, workflowResult] = await Promise.all([run(main), run(workflow)]);
				for (const result of [mainResult, workflowResult]) {
					assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "global");
				}
				assert.equal(globalCalls, 2);
				assert.equal(getApiProvider(requestModel.api)?.streamSimple !== undefined, true);
			} finally {
				for (const session of sessions.reverse()) session.dispose();
			}
		} finally {
			unregisterApiProviders(source);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
