/** Pinned-pi credential stores preserve an empty snapshot when their initial read fails. */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

class ThrowingAuthStorageBackend implements AuthStorageBackend {
	constructor(private readonly error: Error) {}
	read(): string | undefined {
		throw this.error;
	}
	withLock<T>(): T {
		throw this.error;
	}
	async withLockAsync<T>(): Promise<T> {
		throw this.error;
	}
}

describe("AgentSession prompt preflight after an auth-storage load failure", () => {
	let session: AgentSession | undefined;
	let tempDir: string;
	let savedAnthropicKey: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-load-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
		if (session) session.dispose();
		session = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("reports unavailable provider authentication through the runtime", async () => {
		const loadError = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("streamFn must not run when preflight fails");
			},
		});
		const authStorage = AuthStorage.fromStorage(new ThrowingAuthStorageBackend(loadError));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});

		expect(await authStorage.read("anthropic")).toBeUndefined();
		expect(modelRegistry.hasConfiguredAuth(model)).toBe(false);
		await expect(session.prompt("hello")).rejects.toThrow("No API key found for anthropic");
	});
});
