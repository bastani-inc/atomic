import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "../../src/core/agent-session-runtime.ts";
import { createHarness, type Harness } from "./harness.ts";

const createRuntime = (async () => {
	throw new Error("not used");
}) as CreateAgentSessionRuntimeFactory;

function runtimeFor(harness: Harness): AgentSessionRuntime {
	return new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		createRuntime,
	);
}

describe("provider-metadata authentication runtime", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("logs in through provider-owned runtime metadata and persists the acquired credential", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const providerId = "openrouter";
		harness.session.modelRuntime.registerProvider(providerId, {
			oauth: {
				name: "Faux subscription",
				login: async () => ({
					refresh: "refresh-token",
					access: "access-token",
					expires: Date.now() + 60_000,
				}),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
		});
		vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({ ok: true, providers: [] });

		await runtimeFor(harness).loginOAuthProvider(providerId, {
			onAuth: () => {},
			onDeviceCode: () => {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});

		expect(await harness.authStorage.read(providerId)).toMatchObject({
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
		});
	});
});
