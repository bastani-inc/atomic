/**
 * Regression: createAgentSession must reuse a supplied ModelRegistry (and its
 * AuthStorage) instead of eagerly constructing a fresh AuthStorage.
 *
 * Workflow stages reuse one ModelRegistry across model-fallback candidates so a
 * successfully-loaded primary session's credentials are not discarded and
 * re-loaded per candidate. Re-loading under auth.json lock contention can fail
 * and leave an empty in-memory credential set, misreporting configured
 * providers as "No API key found" (issue #1431). A fresh AuthStorage also calls
 * reload() in its constructor, so even building one only to throw it away takes
 * the same contended file lock — createAgentSession must avoid that when a
 * registry is provided.
 *
 * cross-ref: packages/coding-agent/src/core/sdk.ts (createAgentSession)
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function emptyResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

describe("createAgentSession shared ModelRegistry (#1431)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-shared-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reuses a supplied modelRegistry and never constructs a fresh AuthStorage", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "test-key" },
		});
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		const createSpy = vi.spyOn(AuthStorage, "create");
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: emptyResourceLoader(),
		});

		// The whole point: no fresh AuthStorage (and thus no extra contended
		// auth.json reload) when a registry is already supplied.
		expect(createSpy).not.toHaveBeenCalled();
		expect(session.modelRegistry).toBe(modelRegistry);
	});
});
