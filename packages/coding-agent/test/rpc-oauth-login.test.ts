import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const createRuntime = (async () => {
	throw new Error("not used");
}) as CreateAgentSessionRuntimeFactory;
const harnesses: Harness[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

async function createRuntimeHarness() {
	const harness = await createHarness({ withConfiguredAuth: false });
	harnesses.push(harness);
	harness.session.modelRuntime.registerProvider("corp-oauth", {
		baseUrl: "https://provider.test/v1",
		api: "openai-completions",
		oauth: {
			name: "Corp OAuth",
			login: async () => ({ access: "new-secret", refresh: "new-refresh", expires: Date.now() + 60_000 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		},
		models: [{
			id: "corp-model",
			name: "Corp Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
	await harness.authStorage.modify("corp-oauth", async () => ({ type: "api_key", key: "previous" }));
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		createRuntime,
	);
	const handler = createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		pendingExtensionRequests: new Map(),
		output: () => {},
	});
	return { harness, handler };
}

async function expectSuccessfulLoginAndRetainedCredential(
	refresh: () => Promise<never> | Promise<{ aborted: boolean; errors: Map<string, Error> }>,
) {
	const { harness, handler } = await createRuntimeHarness();
	vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(refresh);
	const response = await handler({
		id: "login",
		type: "login_provider",
		provider: "corp-oauth",
		authType: "oauth",
	});
	expect(response).toMatchObject({ success: true, data: { provider: "corp-oauth", cancelled: false } });
	expect(await harness.authStorage.read("corp-oauth")).toMatchObject({ type: "oauth", access: "new-secret" });
	expect(vi.mocked(harness.session.modelRuntime.refresh).mock.calls[0]?.[0]).not.toHaveProperty("signal");
}

describe("RPC OAuth descriptors", () => {
	it("serializes provider metadata without OAuth secrets or function-valued fields", async () => {
		const { handler } = await createRuntimeHarness();
		const response = await handler({ id: "models", type: "get_available_models" });

		expect(response).toMatchObject({
			success: true,
			data: { oauthProviders: expect.arrayContaining([{ id: "corp-oauth", name: "Corp OAuth" }]) },
		});
		const serialized = JSON.stringify(response);
		expect(serialized).not.toContain("new-secret");
		expect(serialized).not.toContain("refreshToken");
		expect(serialized).not.toContain("getApiKey");
	});
});

describe("RPC OAuth credential survival", () => {
	it("keeps the acquired credential when post-login model refresh reports provider errors", async () => {
		await expectSuccessfulLoginAndRetainedCredential(async () => ({
			aborted: false,
			errors: new Map([["corp-oauth", new Error("catalog unavailable")]]),
		}));
	});

	it("keeps the acquired credential when post-login model refresh throws", async () => {
		await expectSuccessfulLoginAndRetainedCredential(async () => {
			throw new DOMException("refresh transport aborted", "AbortError");
		});
	});

	it("keeps the acquired credential when post-login model refresh reports an aborted result", async () => {
		await expectSuccessfulLoginAndRetainedCredential(async () => ({ aborted: true, errors: new Map() }));
	});
});
