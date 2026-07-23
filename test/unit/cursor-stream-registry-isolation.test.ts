import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { OrchestrationContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { registerCursorProvider, type CursorProviderRuntime } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

function token(account: string): string {
	const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "https://authentication.cursor.sh", sub: `auth0|${account}` })}.signature`;
}

async function cursorRegistry(owner: string): Promise<{
	auth: AuthStorage;
	registry: ModelRegistry;
	model: Model<"cursor-agent">;
	runtime: CursorProviderRuntime;
	transport: CursorMockTransport;
}> {
	const access = token(owner);
	const auth = AuthStorage.inMemory({ cursor: { type: "oauth", access, refresh: access, expires: Date.now() + 60_000 } });
	const registry = ModelRegistry.inMemory(auth);
	const transport = new CursorMockTransport({ messages: [{ type: "textDelta", text: owner }, { type: "done", reason: "stop" }] });
	const runtime = registerCursorProvider({
		registerProvider: (name, config) => registry.registerProvider(name, {
			...config,
			models: [...config.models],
			refreshModels: async (context) => [...await config.refreshModels(context)],
		}),
		on: () => undefined,
	}, {
		transport,
		discoveryService: { discover: async () => ({ fetchedAt: Date.now(), rows: [{ modelId: "composer", maxMode: false }] }) },
		catalogCache: { load: () => null, save: () => undefined },
		clientVersion: () => `${owner}-client`,
		uuid: () => `${owner}-request`,
	});
	await registry.prepareRequiredProviders({ allowNetwork: true, explicit: true, providers: new Set(["cursor"]) });
	const selected = registry.resolveExactModel("cursor", "composer") as Model<"cursor-agent">;
	return { auth, registry, model: selected, runtime, transport };
}

function stageContext(id: string): OrchestrationContext {
	return {
		kind: "workflow-stage", workflowRunId: "parallel-run", workflowStageId: id, workflowStageName: id,
		constraints: { disableWorkflowTool: true, maxSubagentDepth: 0 },
	};
}

describe("Cursor registry-owned SDK streaming", () => {
	test("parallel workflow-stage registrations cannot displace the parent Cursor transport", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-cursor-registry-stream-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const runtimes: CursorProviderRuntime[] = [];
		const registries: ModelRegistry[] = [];
		const sessions: Array<{ dispose(): void }> = [];
		try {
			const parent = await cursorRegistry("parent");
			registries.push(parent.registry);
			runtimes.push(parent.runtime);
			const create = async (owner: Awaited<ReturnType<typeof cursorRegistry>>, context?: OrchestrationContext) => {
				const settings = SettingsManager.inMemory();
				const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
				await loader.reload();
				const created = await createAgentSession({
					cwd, agentDir, authStorage: owner.auth, modelRegistry: owner.registry, model: owner.model,
					settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
					orchestrationContext: context, noTools: "all",
				});
				sessions.push(created.session);
				return created.session;
			};
			const parentSession = await create(parent);
			const [stageA, stageB] = await Promise.all([cursorRegistry("stage-a"), cursorRegistry("stage-b")]);
			registries.push(stageA.registry, stageB.registry);
			runtimes.push(stageA.runtime, stageB.runtime);
			const [stageASession, stageBSession] = await Promise.all([
				create(stageA, stageContext("stage-a")),
				create(stageB, stageContext("stage-b")),
			]);

			await Promise.all([
				parentSession.prompt("parent"),
				stageASession.prompt("stage-a"),
				stageBSession.prompt("stage-b"),
			]);

			assert.equal(parent.transport.runs.length, 1);
			assert.equal(stageA.transport.runs.length, 1);
			assert.equal(stageB.transport.runs.length, 1);
			assert.equal(parent.transport.runs[0]?.request.requestId, "parent-request");
			assert.equal(stageA.transport.runs[0]?.request.requestId, "stage-a-request");
			assert.equal(stageB.transport.runs[0]?.request.requestId, "stage-b-request");
		} finally {
			for (const session of sessions.reverse()) session.dispose();
			for (const registry of registries.reverse()) registry.unregisterProvider("cursor");
			for (const runtime of runtimes.reverse()) await runtime.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
