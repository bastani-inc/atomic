/**
 * Regression: createAgentSession must reuse a supplied ModelRuntime instead of
 * eagerly constructing a fresh AuthStorage. Workflow stages share the runtime
 * so credentials survive fallback-candidate session creation without another
 * contended auth.json read (issue #1431).
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

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

describe("createAgentSession shared ModelRuntime (#1431)", () => {
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

	it("reuses a supplied modelRuntime and never constructs a fresh AuthStorage", async () => {
		const authStorage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "test-key" },
		});
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		const modelRuntime = getModelRuntime(modelRegistry);
		const createSpy = vi.spyOn(AuthStorage, "create");
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model,
			modelRuntime,
			sessionManager: SessionManager.inMemory(),
			resourceLoader: emptyResourceLoader(),
		});

		// Supplying the runtime must avoid another credential-store construction.
		expect(createSpy).not.toHaveBeenCalled();
		expect(session.modelRuntime).toBe(modelRuntime);
	});
});
