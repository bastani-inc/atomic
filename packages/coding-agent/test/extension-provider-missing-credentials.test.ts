import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@bastani/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { formatNoApiKeyFoundMessage } from "../src/core/auth-guidance.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const BUILTIN = "groq";
const EXTENSION = "corp-key";

async function rejection(operation: () => Promise<unknown>): Promise<string> {
	try {
		await operation();
	} catch (error) {
		assert.ok(error instanceof Error);
		return error.message;
	}
	return "resolved";
}

describe("an extension provider without credentials gets the built-in missing-key guidance", () => {
	let dir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "extension-missing-credentials-"));
		vi.stubEnv("GROQ_API_KEY", "");
		vi.stubEnv("CORP_KEY_API_KEY", "");
	});

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	function sessionFor(runtime: ModelRuntime, model: Model<Api>): AgentSession {
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => undefined,
				initialState: { model, systemPrompt: "Test", tools: [] },
				streamFn: () => {
					throw new Error("no request may be sent without credentials");
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(dir, dir),
			cwd: dir,
			modelRuntime: runtime,
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		return session;
	}

	test("selecting, prompting, and preparing a request report No API key found for both", async () => {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		const template = runtime.getModels(BUILTIN)[0];
		assert.ok(template);
		runtime.registerProvider(EXTENSION, {
			baseUrl: "https://corp.example.test/v1",
			api: template.api,
			apiKey: "$CORP_KEY_API_KEY",
			models: [{ ...template, id: "corp-model", name: "Corp Model" }],
		});
		await runtime.getAvailable();

		const observed = [];
		for (const provider of [BUILTIN, EXTENSION]) {
			const model = runtime.getModels(provider)[0];
			assert.ok(model);
			const session = sessionFor(runtime, model);
			observed.push({
				provider,
				select: await rejection(() => session.setModel(model)),
				prompt: await rejection(() => session.prompt("hello")),
				request: await rejection(() => session._getRequiredRequestAuth(model)),
				requestAuth: await runtime.getRequestAuth(model),
			});
		}

		assert.deepEqual(
			observed,
			[BUILTIN, EXTENSION].map((provider) => ({
				provider,
				select: `No API key for ${provider}/${runtime.getModels(provider)[0]?.id}`,
				prompt: formatNoApiKeyFoundMessage(provider),
				request: formatNoApiKeyFoundMessage(provider),
				requestAuth: undefined,
			})),
		);
	});
});
