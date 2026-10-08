import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierContext, Credential } from "@bastani/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { loginIsolatedApiKeyProvider } from "../src/modes/interactive-engine/isolated-auth.ts";
import { RpcProviderAuth } from "../src/modes/rpc/rpc-provider-auth.ts";

const CLASSIFIER = "openai-decisions";

const classifierContext: ClassifierContext = {
	state: { text: "yes" },
	questions: {
		approved: {
			type: "bool",
			instructions: "Does this express approval?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
};

const oauthCredential: Credential = {
	type: "oauth",
	access: "chatgpt-access",
	refresh: "chatgpt-refresh",
	expires: Date.now() + 3_600_000,
};

type LoginOptionsHost = {
	prototype: {
		getLoginProviderOptions(this: object, authType?: "oauth" | "api_key"): Array<{ id: string; authType: string }>;
	};
};

const getLoginProviderOptions = (InteractiveMode as unknown as LoginOptionsHost).prototype.getLoginProviderOptions;

function loginChoices(runtime: ModelRuntime): string[] {
	return getLoginProviderOptions
		.call({ session: { modelRuntime: runtime } })
		.map((option) => `${option.id}:${option.authType}`);
}

async function createRuntime(backend: InMemoryAuthStorageBackend, modelsPath: string | null = null) {
	return ModelRuntime.create({
		credentials: AuthStorage.fromStorage(backend),
		modelsPath,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

function seed(backend: InMemoryAuthStorageBackend, data: Record<string, Credential>): void {
	backend.withLock(() => ({ result: undefined, next: JSON.stringify(data) }));
}

async function availableClassifierIds(runtime: ModelRuntime): Promise<string[]> {
	return (await runtime.getAvailableOfType("classifier", CLASSIFIER)).map((model) => model.id);
}

afterEach(() => vi.unstubAllEnvs());

describe("openai-decisions shares OpenAI API credentials", () => {
	it("is not a login choice, but openai and openai-api still are", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const runtime = await createRuntime(new InMemoryAuthStorageBackend());

		const choices = loginChoices(runtime);
		expect(choices).toContain("openai-api:api_key");
		expect(choices).toContain("openai:api_key");
		expect(choices).toContain("openai:oauth");
		expect(choices.filter((choice) => choice.startsWith(`${CLASSIFIER}:`))).toEqual([]);
		expect(runtime.getProvider(CLASSIFIER)?.auth.apiKey?.login).toBeUndefined();
		await expect(
			runtime.login(CLASSIFIER, "api_key", {
				signal: new AbortController().signal,
				prompt: async () => "sk-typed",
				notify: () => {},
			}),
		).rejects.toThrow("does not support api_key login");
	});

	it("is not a login choice or loginable in the isolated engine and frontend", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const backend = new InMemoryAuthStorageBackend();
		const engineRuntime = await createRuntime(backend);
		const frontendRuntime = await createRuntime(backend);
		const asSession = (modelRuntime: ModelRuntime) =>
			({ modelRuntime, scopedModels: [], refreshCurrentModelFromRegistry: () => {} }) as unknown as AgentSession;
		const saveProviderCredential = vi.fn();
		const prompt = vi.fn(async () => "sk-typed");

		expect(loginChoices(frontendRuntime).filter((choice) => choice.startsWith(`${CLASSIFIER}:`))).toEqual([]);
		await expect(
			loginIsolatedApiKeyProvider(
				asSession(frontendRuntime),
				{ saveProviderCredential } as never,
				{ apply: vi.fn() } as never,
				CLASSIFIER,
				{ signal: new AbortController().signal, prompt, notify: () => {} },
			),
		).rejects.toThrow(`Provider does not support api_key login: ${CLASSIFIER}`);
		await expect(
			new RpcProviderAuth({ open: async () => ({ value: "sk-typed" }) }).login(asSession(engineRuntime), CLASSIFIER),
		).rejects.toThrow(`Provider does not support API-key login: ${CLASSIFIER}`);
		expect(prompt).not.toHaveBeenCalled();
		expect(saveProviderCredential).not.toHaveBeenCalled();
		expect(backend.withLock((current) => ({ result: current }))).toBeUndefined();
	});

	it.each([
		["an openai-api key", { "openai-api": { type: "api_key", key: "sk-openai-api" } }, "sk-openai-api"],
		["an openai API key", { openai: { type: "api_key", key: "sk-openai" } }, "sk-openai"],
		[
			"openai-api before openai",
			{ "openai-api": { type: "api_key", key: "sk-openai-api" }, openai: { type: "api_key", key: "sk-openai" } },
			"sk-openai-api",
		],
	] as const)("is available and authenticated with %s", async (_name, stored, expectedKey) => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const backend = new InMemoryAuthStorageBackend();
		seed(backend, stored);
		const runtime = await createRuntime(backend);

		expect(await availableClassifierIds(runtime)).toEqual(["gpt-6-luna"]);
		expect((await runtime.getAllAvailable(CLASSIFIER)).map((model) => model.id)).toEqual(["gpt-6-luna"]);
		expect((await runtime.checkAuth(CLASSIFIER))?.type).toBe("api_key");
		expect((await runtime.getAuth(CLASSIFIER))?.auth.apiKey).toBe(expectedKey);
	});

	it("ignores a ChatGPT sign-in on openai and falls back to OPENAI_API_KEY", async () => {
		const backend = new InMemoryAuthStorageBackend();
		seed(backend, { openai: oauthCredential });

		vi.stubEnv("OPENAI_API_KEY", "");
		const withoutKey = await createRuntime(backend);
		expect(await availableClassifierIds(withoutKey)).toEqual([]);
		expect(await withoutKey.checkAuth(CLASSIFIER)).toBeUndefined();
		expect(await withoutKey.getAuth(CLASSIFIER)).toBeUndefined();
		expect((await withoutKey.checkAuth("openai"))?.type).toBe("oauth");

		vi.stubEnv("OPENAI_API_KEY", "sk-env");
		const withEnv = await createRuntime(backend);
		expect(await availableClassifierIds(withEnv)).toEqual(["gpt-6-luna"]);
		expect((await withEnv.getAuth(CLASSIFIER))?.auth.apiKey).toBe("sk-env");
	});

	it("is unavailable without any OpenAI API credential", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const runtime = await createRuntime(new InMemoryAuthStorageBackend());

		expect(await availableClassifierIds(runtime)).toEqual([]);
		expect(await runtime.checkAuth(CLASSIFIER)).toBeUndefined();
		expect(await runtime.getAuth(CLASSIFIER)).toBeUndefined();
	});

	it("agrees between the engine and the frontend after the engine saves an openai-api key", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const backend = new InMemoryAuthStorageBackend();
		const engineRuntime = await createRuntime(backend);
		const frontendRuntime = await createRuntime(backend);
		const engineSession = {
			modelRuntime: engineRuntime,
			scopedModels: [],
			refreshCurrentModelFromRegistry: () => {},
		} as unknown as AgentSession;
		expect(await availableClassifierIds(frontendRuntime)).toEqual([]);

		await new RpcProviderAuth().save(
			engineSession,
			"openai-api",
			{ type: "api_key", key: "sk-openai-api" },
			{ refreshCatalog: false },
		);
		await frontendRuntime.reloadCredentials({ refreshAvailability: false });

		for (const runtime of [engineRuntime, frontendRuntime]) {
			expect(await availableClassifierIds(runtime)).toEqual(["gpt-6-luna"]);
			expect((await runtime.getAuth(CLASSIFIER))?.auth.apiKey).toBe("sk-openai-api");
		}
	});

	it("sends the shared key when classifying", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const backend = new InMemoryAuthStorageBackend();
		seed(backend, { "openai-api": { type: "api_key", key: "sk-openai-api" } });
		const runtime = await createRuntime(backend);
		const luna = runtime.getModelOfType("classifier", CLASSIFIER, "gpt-6-luna");
		expect(luna).toBeDefined();
		const authorizations: Array<string | null> = [];

		const result = await runtime.classify(luna!, classifierContext, {
			fetch: async (_input, init) => {
				authorizations.push(new Headers(init?.headers).get("authorization"));
				return Response.json({ answers: [{ type: "predicate", name: "approved", probability: 0.8 }] });
			},
		});

		expect(authorizations).toEqual(["Bearer sk-openai-api"]);
		expect(result.stopReason).toBe("stop");
	});

	describe("with a models.json override", () => {
		const roots: string[] = [];
		afterEach(() => {
			for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		});

		function modelsJson(provider: Record<string, unknown>): string {
			const root = mkdtempSync(join(tmpdir(), "atomic-openai-decisions-"));
			roots.push(root);
			const path = join(root, "models.json");
			writeFileSync(path, JSON.stringify({ providers: { [CLASSIFIER]: provider } }));
			return path;
		}

		it("keeps borrowing and offers no login when only the base URL is overridden", async () => {
			vi.stubEnv("OPENAI_API_KEY", "");
			const backend = new InMemoryAuthStorageBackend();
			seed(backend, { "openai-api": { type: "api_key", key: "sk-openai-api" } });
			const runtime = await createRuntime(backend, modelsJson({ baseUrl: "https://proxy.test/v1" }));

			expect(runtime.getProvider(CLASSIFIER)?.baseUrl).toBe("https://proxy.test/v1");
			expect(runtime.getProvider(CLASSIFIER)?.auth.apiKey?.login).toBeUndefined();
			expect(loginChoices(runtime).filter((choice) => choice.startsWith(`${CLASSIFIER}:`))).toEqual([]);
			expect(await availableClassifierIds(runtime)).toEqual(["gpt-6-luna"]);
			expect((await runtime.getAuth(CLASSIFIER))?.auth.apiKey).toBe("sk-openai-api");
		});

		it("prefers an API key configured in models.json over the shared credential", async () => {
			vi.stubEnv("OPENAI_API_KEY", "");
			const backend = new InMemoryAuthStorageBackend();
			seed(backend, { "openai-api": { type: "api_key", key: "sk-openai-api" } });
			const runtime = await createRuntime(backend, modelsJson({ apiKey: "sk-configured" }));

			expect((await runtime.getAuth(CLASSIFIER))?.auth.apiKey).toBe("sk-configured");
		});
	});
});
