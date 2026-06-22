/**
 * Regression: a prompt preflight must not misreport a credential-store LOAD
 * failure as "No API key found".
 *
 * When a fresh AuthStorage cannot read auth.json (e.g. it is briefly locked by a
 * concurrent process, leaving an ELOCKED error), it ends up with an empty
 * in-memory credential set and a recorded loadError. Previously the prompt
 * preflight only saw `hasConfiguredAuth() === false` and threw the misleading
 * "No API key found for <provider>" \u2014 even though the credentials exist on disk.
 * The preflight now surfaces the real load failure instead (issue #1431).
 *
 * cross-ref: packages/coding-agent/src/core/agent-session.ts (prompt preflight)
 *            packages/coding-agent/src/core/auth-storage.ts (getLoadError)
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage, type AuthStorageBackend } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
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

describe("AgentSession prompt preflight \u2014 auth-storage load failure (#1431)", () => {
	let session: AgentSession | undefined;
	let tempDir: string;
	let savedAnthropicKey: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-load-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		// Ensure no environment key masks the load failure for this provider.
		savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
	});

	afterEach(() => {
		if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
		if (session) session.dispose();
		session = undefined;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("surfaces the load failure instead of 'No API key found'", async () => {
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
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		// Sanity: the store genuinely failed to load and looks "empty".
		expect(authStorage.getLoadError()).toBe(loadError);
		expect(modelRegistry.hasConfiguredAuth(model)).toBe(false);

		await session.prompt("hello").then(
			() => {
				throw new Error("expected prompt() to reject");
			},
			(error: unknown) => {
				const text = error instanceof Error ? error.message : String(error);
				expect(text).toContain("Could not load stored credentials for anthropic");
				expect(text).toContain("Lock file is already being held");
				expect(text).not.toContain("No API key found");
				// The original load error is preserved as the cause.
				expect((error as { cause?: unknown }).cause).toBe(loadError);
			},
		);
	});
});
