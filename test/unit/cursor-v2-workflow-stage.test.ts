import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { getCursorRouteReference, mapCursorCatalogToProviderModels } from "../../packages/cursor/src/model-mapper.js";
import { parseHistoricalTurns } from "../../packages/cursor/src/proto/protobuf-codec-request.js";
import { CursorProtobufProtocolCodec } from "../../packages/cursor/src/transport.js";

const workflow = { runId: "cursor-run", stageId: "cursor-stage", stageName: "Cursor Stage" };
const orchestrationContext = {
	kind: "workflow-stage" as const,
	workflowRunId: workflow.runId,
	workflowStageId: workflow.stageId,
	workflowStageName: workflow.stageName,
	constraints: { disableWorkflowTool: true as const, maxSubagentDepth: 1 },
};

function createRegistry(): { auth: AuthStorage; registry: ModelRegistry } {
	const auth = AuthStorage.inMemory({ cursor: { type: "oauth", access: "opaque-access", refresh: "opaque-refresh", expires: Date.now() + 60_000 } });
	const registry = ModelRegistry.create(auth, []);
	registry.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: "https://api2.cursor.sh",
		api: "cursor-agent",
		requiresExactSelectionPersistence: true,
		requiresHostOAuth: true,
		oauth: {
			name: "Cursor",
			login: async () => ({ access: "opaque-access", refresh: "opaque-refresh", expires: Date.now() + 60_000 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		},
		models: mapCursorCatalogToProviderModels({
			accountScope: "cursor-account-v1:workflow",
			clientVersion: "workflow-client",
			fetchedAt: 1,
			catalogGeneration: 1,
			providerInstanceGeneration: 1,
			credentialGeneration: auth.getCredentialSnapshot("cursor").generation,
			rows: [{ modelId: "A", maxMode: false }, { modelId: "A", maxMode: false }],
		}),
	});
	return { auth, registry };
}

function appendCanonicalStageHistory(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: "stage prompt", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "stage thought" },
			{ type: "text", text: "using tool" },
			{ type: "toolCall", id: "stage-tool", name: "echo", arguments: { text: "hello" } },
		],
		api: "cursor-agent", provider: "cursor", model: "A",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse", timestamp: 2,
	});
	manager.appendMessage({ role: "toolResult", toolCallId: "stage-tool", toolName: "echo", content: [{ type: "text", text: "echoed" }], isError: false, timestamp: 3 });
	manager.appendMessage({ role: "user", content: "continue stage", timestamp: 4 });
}

describe("Cursor exact workflow-stage history", () => {
	test("real workflow session preserves exact occurrence and canonical tool/thinking history across persisted restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-cursor-workflow-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const { auth, registry } = createRegistry();
			const selected = registry.getAll().filter((candidate) => candidate.provider === "cursor")[1];
			assert.ok(selected);
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			const manager = SessionManager.create(cwd, sessionDir, { internal: true, workflow });
			const created = await createAgentSession({ cwd, agentDir, authStorage: auth, modelRegistry: registry, model: selected, settingsManager: settings, sessionManager: manager, resourceLoader: loader, orchestrationContext });
			appendCanonicalStageHistory(manager);
			const context = manager.buildSessionContext().messages as Context["messages"];
			const parsed = parseHistoricalTurns(context.slice(0, -1));
			assert.deepEqual(parsed[0]?.steps.map((step) => step.kind), ["assistantThinking", "assistantText", "toolCall"]);
			assert.equal(parsed[0]?.steps[2]?.kind === "toolCall" ? parsed[0].steps[2].result?.content : undefined, "echoed");
			const reference = getCursorRouteReference(selected);
			assert.equal(reference.occurrence, 2);
			assert.doesNotThrow(() => new CursorProtobufProtocolCodec().encodeRunRequest({ accessToken: "opaque-access", requestId: "workflow-first", model: selected, routeReference: reference, context: { messages: context } }));
			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile);
			created.session.dispose();

			const reopened = SessionManager.open(sessionFile, sessionDir, cwd);
			const restarted = reopened.buildSessionContext().messages as Context["messages"];
			assert.deepEqual(parseHistoricalTurns(restarted.slice(0, -1)), parsed);
			assert.doesNotThrow(() => new CursorProtobufProtocolCodec().encodeRunRequest({ accessToken: "opaque-access", requestId: "workflow-restart", model: selected, routeReference: reference, context: { messages: restarted } }));
			assert.equal(reopened.getHeader()?.internal, true);
			assert.deepEqual(reopened.getHeader()?.workflow, workflow);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
