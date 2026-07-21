import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { ProviderConfigInput } from "../../packages/coding-agent/src/core/model-registry-types.js";
import { registerPendingProvidersAndPrepare } from "../../packages/coding-agent/src/core/provider-preparation-lifecycle.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { CursorError } from "../../packages/cursor/src/errors.js";

const preparedModel: NonNullable<ProviderConfigInput["models"]>[number] = {
	id: "live",
	name: "Live",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
};

function requiredConfig(refreshModels: NonNullable<ProviderConfigInput["refreshModels"]>): ProviderConfigInput {
	return {
		name: "Required",
		baseUrl: "https://example.invalid",
		api: "openai-completions",
		apiKey: "test-only",
		models: [],
		requiresPreparation: true,
		refreshModels,
	};
}

describe("required provider SDK preparation doors", () => {
	test("SDK explicitly prepares a supplied exact-provider model", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-required-sdk-explicit-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("cursor", {
				...requiredConfig(async () => { calls += 1; throw new CursorError("AuthenticationMissing", "Cursor host OAuth is required.", { operation: "authentication" }); }),
				models: [preparedModel], requiresHostOAuth: true, requiresExactSelectionPersistence: true,
			});
			const selected = registry.resolveExactModel("cursor", "live");
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			await assert.rejects(createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry, model: selected,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			}), (error: Error) => error instanceof CursorError && error.code === "AuthenticationMissing");
			assert.equal(calls, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("SDK explicitly prepares saved exact defaults and session selections", async () => {
		const selection = { version: 1, provider: "cursor", accountScope: "cursor-account-v1:saved", routeId: "live", maxMode: "false", occurrence: 1 };
		for (const source of ["default", "session"] as const) {
			const root = mkdtempSync(join(tmpdir(), `atomic-required-sdk-${source}-`));
			const cwd = join(root, "project");
			const agentDir = join(root, "agent");
			mkdirSync(cwd, { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			try {
				const auth = AuthStorage.inMemory();
				const registry = ModelRegistry.create(auth, []);
				let calls = 0;
				registry.registerProvider("cursor", {
					...requiredConfig(async () => { calls += 1; throw new CursorError("AuthenticationMissing", "Cursor host OAuth is required.", { operation: "authentication" }); }),
					requiresHostOAuth: true, requiresExactSelectionPersistence: true,
				});
				const settings = SettingsManager.inMemory();
				const session = SessionManager.inMemory(cwd);
				if (source === "default") settings.setDefaultModelAndProvider("cursor", "live", selection);
				else {
					session.appendModelChange("cursor", "live", selection);
					session.appendMessage({ role: "user", content: "resume", timestamp: 1 });
				}
				const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
				await loader.reload();
				await assert.rejects(createAgentSession({
					cwd, agentDir, authStorage: auth, modelRegistry: registry,
					settingsManager: settings, sessionManager: session, resourceLoader: loader,
				}), (error: Error) => error instanceof CursorError && error.code === "AuthenticationMissing");
				assert.equal(calls, 1);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test("SDK session reuses the service-prepared registered generation without clearing or duplication", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-required-sdk-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("required", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			await registerPendingProvidersAndPrepare(loader, registry, true);
			const selected = registry.resolveExactModel("required", "live");
			const created = await createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry, model: selected,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			});
			assert.equal(calls, 1);
			assert.equal(registry.resolveExactModel("required", "live").id, selected.id);
			created.session.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("direct SDK session prepares an unprepared registered provider exactly once", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-required-sdk-direct-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("required", requiredConfig(async () => { calls += 1; return [preparedModel]; }));
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			const created = await createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			});
			assert.equal(calls, 1);
			assert.equal(created.session.model?.id, "live");
			created.session.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("SDK preserves the ordinary provider offline refresh without touching required generations", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-ordinary-sdk-refresh-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		try {
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, []);
			let calls = 0;
			registry.registerProvider("ordinary", {
				...requiredConfig(async ({ allowNetwork }) => {
					calls += 1;
					assert.equal(allowNetwork, false);
					return [{ ...preparedModel, id: "dynamic" }];
				}),
				requiresPreparation: false,
			});
			const settings = SettingsManager.inMemory();
			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, builtinPackagePaths: [] });
			await loader.reload();
			const created = await createAgentSession({
				cwd, agentDir, authStorage: auth, modelRegistry: registry,
				settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader,
			});
			assert.equal(calls, 1);
			assert.equal(created.session.model?.id, "dynamic");
			created.session.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
