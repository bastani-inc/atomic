import { getModel, streamSimple } from "@bastani/pi-ai/compat";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const sonnet = getModel("anthropic", "claude-sonnet-4-5")!;
const opus = getModel("anthropic", "claude-opus-4-8")!;

describe("persisted default model scoping", () => {
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
	});

	async function createSession(options: { scoped: boolean; persistedScope?: string[] }) {
		const settingsManager = SettingsManager.inMemory(
			options.persistedScope ? { enabledModels: options.persistedScope } : {},
		);
		const authStorage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
		const modelRuntime = getModelRuntime(await createInMemoryModelRegistry(authStorage));
		const agent = new Agent({
			initialState: { model: sonnet, systemPrompt: "test", tools: [] },
			streamFn: streamSimple,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: process.cwd(),
			modelRuntime,
			resourceLoader: createTestResourceLoader(),
			scopedModels: options.scoped ? [{ model: sonnet }] : [],
		});
		sessions.push(session);
		return { session, settingsManager };
	}

	test("adds a persisted default to an existing scoped model list", async () => {
		const { session, settingsManager } = await createSession({
			scoped: true,
			persistedScope: [`${sonnet.provider}/${sonnet.id}`],
		});

		await session.setModel(opus, { persist: true });

		expect(settingsManager.getDefaultProvider()).toBe(opus.provider);
		expect(settingsManager.getDefaultModel()).toBe(opus.id);
		expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${sonnet.provider}/${sonnet.id}`,
			`${opus.provider}/${opus.id}`,
		]);
		expect(settingsManager.getEnabledModels()).toEqual([
			`${sonnet.provider}/${sonnet.id}`,
			`${opus.provider}/${opus.id}`,
		]);
	});

	test("does not create a scoped model list when all models are available", async () => {
		const { session, settingsManager } = await createSession({ scoped: false });

		await session.setModel(opus, { persist: true });

		expect(session.scopedModels).toEqual([]);
		expect(settingsManager.getEnabledModels()).toBeUndefined();
	});

	test("keeps session-only model changes out of scope", async () => {
		const { session, settingsManager } = await createSession({
			scoped: true,
			persistedScope: [`${sonnet.provider}/${sonnet.id}`],
		});

		await session.setModel(opus, { persist: false });

		expect(session.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`)).toEqual([
			`${sonnet.provider}/${sonnet.id}`,
		]);
		expect(settingsManager.getEnabledModels()).toEqual([`${sonnet.provider}/${sonnet.id}`]);
	});
});
