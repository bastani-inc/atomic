import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type Model } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { AuthStorage, ModelRuntime } from "../src/index.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function newSession(withModel: boolean) {
	const cwd = mkdtempSync(join(tmpdir(), "sdk-start-state-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const model: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		provider: "start-state-fixture",
		reasoning: true,
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	if (withModel) {
		runtime.registerProvider(model.provider, {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture-key",
			models: [model],
		});
		cleanups.push(() => runtime.unregisterProvider(model.provider));
	}
	const sessionManager = await SessionManager.create(cwd, join(cwd, "sessions"));
	const store = sessionManager.getSessionStore();
	const writes: string[][] = [];
	const append = store.append.bind(store);
	store.append = (sessionId, entries, options) => {
		writes.push(entries.map((entry) => entry.type));
		return append(sessionId, entries, options);
	};
	const { session } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "agent"),
		modelRuntime: runtime,
		...(withModel ? { model } : {}),
		thinkingLevel: "high",
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		sessionManager,
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
	});
	cleanups.push(() => session.dispose());
	return { session, sessionManager, writes, model };
}

test("a new session records the model and thinking level it starts on in one write (#4319)", async () => {
	const { session, sessionManager, writes, model } = await newSession(true);
	assert.deepEqual(writes, [["model_change", "thinking_level_change"]]);
	const [modelChange, thinkingChange] = sessionManager.getEntries();
	assert.ok(modelChange?.type === "model_change");
	assert.equal(modelChange.provider, model.provider);
	assert.equal(modelChange.modelId, model.id);
	assert.ok(thinkingChange?.type === "thinking_level_change");
	assert.equal(thinkingChange.thinkingLevel, session.thinkingLevel);
	assert.equal(thinkingChange.parentId, modelChange.id);
});

test("a new session with no model records only its thinking level (#4319)", async () => {
	const { sessionManager, writes } = await newSession(false);
	assert.deepEqual(writes, [["thinking_level_change"]]);
	assert.deepEqual(
		sessionManager.getEntries().map((entry) => entry.type),
		["thinking_level_change"],
	);
});
