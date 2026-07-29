import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";

const tempDirs: string[] = [];
beforeEach(() => {
	// Saving triggers a catalog refresh. This persistence test does not exercise
	// remote catalogs and must not inherit configured provider keys from the host.
	vi.stubEnv("ATOMIC_OFFLINE", "1");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function createHarness() {
	const tempDir = mkdtempSync(join(tmpdir(), "atomic-rpc-credential-save-"));
	tempDirs.push(tempDir);
	const authPath = join(tempDir, "auth.json");
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.create(authPath),
		modelsPath: null,
	});
	modelRuntime.registerProvider("persist-probe", {
		baseUrl: "https://persist.test/v1",
		api: "openai-completions",
		models: [
			{
				id: "persist-model",
				name: "Persist Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			},
		],
	});
	await modelRuntime.refresh({ allowNetwork: false });
	const refreshCurrentModelFromRegistry = vi.fn();
	const session = {
		modelRuntime,
		scopedModels: [],
		refreshCurrentModelFromRegistry,
	} as unknown as AgentSession;
	const handler = createRpcCommandHandler({
		runtimeHost: {} as AgentSessionRuntime,
		getSession: () => session,
		rebindSession: async () => {},
		output: () => {},
	});
	return { authPath, handler, refreshCurrentModelFromRegistry };
}

describe("RPC save_provider_credential", () => {
	it("persists an API key and returns the refreshed model catalog", async () => {
		const { authPath, handler, refreshCurrentModelFromRegistry } = await createHarness();

		const response = await handler({
			id: "save",
			type: "save_provider_credential",
			provider: "persist-probe",
			credential: { type: "api_key", key: "persisted-secret" },
		});

		const freshStorage = AuthStorage.create(authPath);
		expect(await freshStorage.read("persist-probe")).toEqual({ type: "api_key", key: "persisted-secret" });
		expect(response).toMatchObject({
			success: true,
			data: {
				models: expect.arrayContaining([
					expect.objectContaining({ provider: "persist-probe", id: "persist-model" }),
				]),
			},
		});
		expect(refreshCurrentModelFromRegistry).toHaveBeenCalledOnce();
	});

	it("accepts and persists an OAuth credential permitted by the RPC command type", async () => {
		const { authPath, handler } = await createHarness();
		const credential = {
			type: "oauth" as const,
			access: "oauth-access",
			refresh: "oauth-refresh",
			expires: Date.now() + 60_000,
		};

		const response = await handler({
			id: "save-oauth",
			type: "save_provider_credential",
			provider: "persist-probe",
			credential,
		});

		expect(response).toMatchObject({ success: true });
		expect(await AuthStorage.create(authPath).read("persist-probe")).toEqual(credential);
	});
});
