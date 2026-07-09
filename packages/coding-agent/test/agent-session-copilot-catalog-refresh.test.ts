import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	clearActiveCopilotModelCatalog,
	copilotCatalogCachePath,
	type CopilotModelCatalog,
	setActiveCopilotModelCatalog,
	writeCopilotCatalogCache,
} from "../src/core/copilot-model-catalog.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-model-routing.ts";

const MAI_CODE_FLASH_ID = "mai-code-2-flash-picker";
const COPILOT_TOKEN = "tid=x;proxy-ep=proxy.individual.githubcopilot.com";
const COPILOT_BASE_URL = "https://api.individual.githubcopilot.com";

const maiCodeCatalog: CopilotModelCatalog = new Map([
	[
		MAI_CODE_FLASH_ID,
		{
			contextWindow: 128_000,
			maxInputTokens: 128_000,
			maxTokens: 128_000,
			displayName: "MAI-Code-1-Flash",
			supportedEndpoints: ["/responses"],
			supports: { reasoningEffort: true, reasoningEffortLevels: ["low", "medium", "high"], toolCalls: true },
			limits: { maxPromptTokens: 128_000, maxOutputTokens: 128_000, maxContextWindowTokens: 256_000 },
			modelPickerEnabled: true,
			policyState: "enabled",
			type: "chat",
		},
	],
]);

let tempDirs: string[] = [];
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;

function makeTempDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function createCopilotRegistry(agentDir: string): ModelRegistry {
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey("github-copilot", COPILOT_TOKEN);
	return ModelRegistry.create(authStorage, join(agentDir, "models.json"));
}

function resolveFallbackModel(registry: ModelRegistry, modelId: string): Model<Api> {
	const resolved = resolveCliModel({
		cliProvider: "github-copilot",
		cliModel: modelId,
		modelRegistry: registry,
	});
	assert.equal(resolved.error, undefined);
	assert.ok(resolved.model);
	return resolved.model;
}

afterEach(() => {
	clearActiveCopilotModelCatalog();
	if (previousAgentDir === undefined) {
		delete process.env.ATOMIC_CODING_AGENT_DIR;
	} else {
		process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	}
	for (const dir of tempDirs) {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

test("refreshCurrentModelFromRegistry adopts catalog metadata and clamps stale Copilot thinking", async () => {
	const tempDir = makeTempDir("atomic-copilot-session-refresh");
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const registry = createCopilotRegistry(agentDir);
	const fallbackModel = resolveFallbackModel(registry, MAI_CODE_FLASH_ID);

	const fallbackLevels = getSupportedThinkingLevels(fallbackModel);
	assert.ok(fallbackLevels.includes("minimal"));
	assert.ok(fallbackLevels.includes("xhigh"));
	assert.equal(fallbackLevels.includes("off"), false);

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: fallbackModel,
		modelRegistry: registry,
		settingsManager: SettingsManager.create(tempDir, agentDir),
		sessionManager: SessionManager.inMemory(tempDir),
		thinkingLevel: "xhigh",
	});

	assert.deepEqual(session.getAvailableThinkingLevels(), fallbackLevels);
	assert.equal(session.thinkingLevel, "xhigh");
	const emittedEventTypes: string[] = [];
	const unsubscribe = session.subscribe((event) => emittedEventTypes.push(event.type));

	setActiveCopilotModelCatalog(maiCodeCatalog);
	registry.refresh();
	session.refreshCurrentModelFromRegistry();
	unsubscribe();

	assert.notEqual(session.model, fallbackModel);
	assert.equal(session.model?.provider, "github-copilot");
	assert.equal(session.model?.id, MAI_CODE_FLASH_ID);
	assert.deepEqual(session.getAvailableThinkingLevels(), ["low", "medium", "high"]);
	assert.equal(session.thinkingLevel, "high");
	assert.ok(emittedEventTypes.includes("thinking_level_changed"));
	assert.ok(emittedEventTypes.includes("model_changed"));
	session.dispose();
});

test("refreshCurrentModelFromRegistry leaves the active fallback untouched when registry cannot resolve it", async () => {
	const tempDir = makeTempDir("atomic-copilot-session-refresh-missing");
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const registry = createCopilotRegistry(agentDir);
	const fallbackModel = resolveFallbackModel(registry, "future-copilot-model");
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: fallbackModel,
		modelRegistry: registry,
		settingsManager: SettingsManager.create(tempDir, agentDir),
		sessionManager: SessionManager.inMemory(tempDir),
		thinkingLevel: "xhigh",
	});

	setActiveCopilotModelCatalog(maiCodeCatalog);
	registry.refresh();
	session.refreshCurrentModelFromRegistry();

	assert.equal(session.model, fallbackModel);
	assert.equal(session.thinkingLevel, "xhigh");
	session.dispose();
});

test("loadCopilotModelCatalog refreshes the active session after applying a cached catalog", async () => {
	const tempDir = makeTempDir("atomic-copilot-routing-refresh");
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	writeCopilotCatalogCache(copilotCatalogCachePath(agentDir), COPILOT_BASE_URL, maiCodeCatalog);

	let registryRefreshCount = 0;
	let sessionRefreshCount = 0;
	const harness = {
		copilotCatalogApplied: false,
		session: {
			modelRegistry: {
				getApiKeyForProvider: async (provider: string) => provider === "github-copilot" ? COPILOT_TOKEN : undefined,
				refresh: () => {
					registryRefreshCount += 1;
				},
			},
			refreshCurrentModelFromRegistry: () => {
				sessionRefreshCount += 1;
			},
		},
	};
	const loadCatalog = InteractiveModeBase.prototype.loadCopilotModelCatalog as (this: typeof harness) => Promise<void>;

	await loadCatalog.call(harness);

	assert.equal(harness.copilotCatalogApplied, true);
	assert.equal(registryRefreshCount, 1);
	assert.equal(sessionRefreshCount, 1);
});
