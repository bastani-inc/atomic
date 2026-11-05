import assert from "node:assert/strict";
import type { Credential, Provider } from "@bastani/pi-ai";
import { afterEach, describe, test, vi } from "vitest";
import { runAuthLogout } from "../src/cli/auth-logout.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.js";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.js";

/** A provider with only ambient credentials, such as a configured gateway, registered under `name`. */
function namedProvider(id: string, name: string): Provider {
	const unused = () => {
		throw new Error("unused");
	};
	return {
		id,
		name,
		auth: { apiKey: { name: "Ambient", resolve: async () => undefined } },
		getModels: () => [],
		stream: unused,
		streamSimple: unused,
	};
}

async function setup(data: Record<string, Credential>) {
	const credentials = AuthStorage.inMemory(data);
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});
	const lines: string[] = [];
	const errors: string[] = [];
	const signal = new AbortController().signal;
	const run = (args: string[]) =>
		runAuthLogout(args, {
			modelRuntime,
			terminal: { write: (line) => lines.push(line), error: (line) => errors.push(line) },
			signal,
		});
	return { credentials, modelRuntime, lines, errors, run, signal };
}

const oauthCredential = {
	type: "oauth",
	access: "access",
	refresh: "refresh",
	expires: Date.now() + 3_600_000,
} as const;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("atomic auth logout", () => {
	test("requires exactly one provider", async () => {
		const { errors, run } = await setup({});
		for (const args of [[], ["--api-key"], ["radius", "extra"]]) {
			errors.length = 0;
			assert.equal(await run(args), 1);
			assert.deepEqual(errors, ["Usage: atomic auth logout <provider>"]);
		}
	});

	test("removes a stored account login", async () => {
		const { credentials, modelRuntime, lines, errors, run, signal } = await setup({ radius: oauthCredential });
		const logout = vi.spyOn(modelRuntime, "logout");
		assert.equal(await run(["radius"]), 0);
		assert.deepEqual(lines, ["Logged out of Radius."]);
		assert.deepEqual(errors, []);
		assert.deepEqual(logout.mock.calls, [["radius", { signal }]]);
		assert.equal(await credentials.read("radius"), undefined);
	});

	test("removes a stored API key by provider name and keeps other credentials", async () => {
		const { credentials, lines, run } = await setup({
			openai: { type: "api_key", key: "sk-test" },
			radius: oauthCredential,
		});
		assert.equal(await run(["OpenAI"]), 0);
		assert.deepEqual(lines, [
			"Removed stored API key for OpenAI. Environment variables and models.json config are unchanged.",
		]);
		assert.equal(await credentials.read("openai"), undefined);
		assert.equal((await credentials.read("radius"))?.type, "oauth");
	});

	test("succeeds when nothing is stored, so it can be repeated", async () => {
		const { modelRuntime, lines, run } = await setup({});
		const logout = vi.spyOn(modelRuntime, "logout");
		assert.equal(await run(["radius"]), 0);
		assert.deepEqual(lines, [
			"No stored credentials for Radius. Environment variables and models.json config are unchanged.",
		]);
		assert.equal(logout.mock.calls.length, 0);
	});

	test("removes credentials of providers that are not loaded, matched by id", async () => {
		const { credentials, lines, run } = await setup({ "extension-provider": oauthCredential });
		assert.equal(await run(["extension-provider"]), 0);
		assert.deepEqual(lines, ["Logged out of extension-provider."]);
		assert.equal(await credentials.read("extension-provider"), undefined);
	});

	test("rejects a name shared by several providers and removes only the provider named by its id", async () => {
		const { credentials, modelRuntime, lines, errors, run } = await setup({
			openai: { type: "api_key", key: "sk-openai" },
			"openai-gateway": { type: "api_key", key: "sk-gateway" },
		});
		modelRuntime.registerNativeProvider(namedProvider("openai-gateway", "OpenAI"));
		const logout = vi.spyOn(modelRuntime, "logout");

		assert.equal(await run(["OpenAI"]), 1);
		assert.deepEqual(errors, [
			'"OpenAI" matches more than one provider. Use a provider ID.',
			"Matching providers: openai, openai-gateway",
		]);
		assert.deepEqual(lines, []);
		assert.equal(logout.mock.calls.length, 0);

		assert.equal(await run(["openai"]), 0);
		assert.equal(await credentials.read("openai"), undefined);
		assert.equal((await credentials.read("openai-gateway"))?.type, "api_key");
	});

	test("an exact stored provider id wins over another provider's display name", async () => {
		const { credentials, modelRuntime, lines, run } = await setup({
			"extension-provider": oauthCredential,
			gateway: { type: "api_key", key: "sk-gateway" },
		});
		modelRuntime.registerNativeProvider(namedProvider("gateway", "extension-provider"));
		assert.equal(await run(["extension-provider"]), 0);
		assert.deepEqual(lines, ["Logged out of extension-provider."]);
		assert.equal(await credentials.read("extension-provider"), undefined);
		assert.equal((await credentials.read("gateway"))?.type, "api_key");
	});

	test("reports credentials that cannot be read", async () => {
		const { modelRuntime, lines, errors, run } = await setup({ radius: oauthCredential });
		const logout = vi.spyOn(modelRuntime, "logout");
		vi.spyOn(modelRuntime, "listCredentials").mockRejectedValueOnce(new Error("auth.json is malformed"));
		assert.equal(await run(["radius"]), 1);
		assert.deepEqual(errors, ["Could not read stored credentials: auth.json is malformed"]);
		vi.spyOn(modelRuntime, "listCredentials").mockRejectedValueOnce("locked");
		assert.equal(await run(["radius"]), 1);
		assert.equal(errors[1], "Could not read stored credentials: locked");
		assert.deepEqual(lines, []);
		assert.equal(logout.mock.calls.length, 0);
	});

	test("reports credential removal failures", async () => {
		const { modelRuntime, errors, run } = await setup({ radius: oauthCredential });
		vi.spyOn(modelRuntime, "logout").mockRejectedValueOnce(new Error("storage failed"));
		assert.equal(await run(["radius"]), 1);
		assert.deepEqual(errors, ["Logout failed: storage failed"]);
		vi.spyOn(modelRuntime, "logout").mockRejectedValueOnce("storage locked");
		assert.equal(await run(["radius"]), 1);
		assert.equal(errors[1], "Logout failed: storage locked");
	});

	test("reports committed credential removal separately from a failed logout", async () => {
		const { modelRuntime, lines, errors, run } = await setup({ radius: oauthCredential });
		vi.spyOn(modelRuntime, "logout").mockRejectedValue(
			new CredentialSynchronizationError("radius", "logout", undefined, { cause: new Error("snapshot failed") }),
		);
		assert.equal(await run(["radius"]), 1);
		assert.deepEqual(errors, [
			"Credentials removed for Radius, but local model state could not be synchronized: Credential logout committed for radius, but local synchronization failed",
		]);
		assert.deepEqual(lines, []);
	});

	test("rejects an unknown provider and lists the stored credentials", async () => {
		const stored = await setup({ radius: oauthCredential, openai: { type: "api_key", key: "sk-test" } });
		assert.equal(await stored.run(["nope\u001b[2J"]), 1);
		assert.deepEqual(stored.errors, ['Unknown provider "nope [2J".', "Stored credentials: openai, radius"]);

		const empty = await setup({});
		assert.equal(await empty.run(["nope"]), 1);
		assert.deepEqual(empty.errors, ['Unknown provider "nope".', "Stored credentials: none"]);
	});
});
