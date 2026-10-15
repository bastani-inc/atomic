import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	Api,
	ApiKeyCredential,
	AssistantMessage,
	Model,
	ModelFastRoute,
	OAuthCredential,
	Provider,
} from "@bastani/pi-ai";
import { createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { FAST_MODEL_SERVICE_TIER } from "../src/core/fast-model-variants.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const probe: Model<Api> = {
	id: "auth-probe",
	name: "Auth probe",
	provider: "auth-probe",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function message(model: Model<Api>, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [],
		stopReason: errorMessage ? "error" : "stop",
		errorMessage,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

let dir: string;
let cwd: string;
let agentDir: string;
let authPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sdk-auth-retry-"));
	cwd = join(dir, "project");
	agentDir = join(dir, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	authPath = join(agentDir, "auth.json");
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

function rotateStoredCredential(provider: string, credential: ApiKeyCredential | OAuthCredential): void {
	writeFileSync(authPath, JSON.stringify({ [provider]: credential }));
}

function oauthCredential(access: string): OAuthCredential {
	return { type: "oauth", access, refresh: `${access}-refresh`, expires: Number.MAX_SAFE_INTEGER };
}

async function startSession(model: Model<Api>, modelRuntime: ModelRuntime, authStorage: AuthStorage) {
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		authStorage,
		modelRuntime,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
	});
	return session;
}

describe("SDK chat requests recover from credentials saved elsewhere", () => {
	type Shape = "api key" | "header OAuth";
	const cases: { shape: Shape; caller?: "apiKey" | "Authorization"; attempts: string[] }[] = [
		{ shape: "api key", attempts: ["old-fixture", "new-fixture"] },
		{ shape: "header OAuth", attempts: ["Bearer old-fixture", "Bearer new-fixture"] },
		{ shape: "api key", caller: "apiKey", attempts: ["caller-fixture"] },
		{ shape: "header OAuth", caller: "Authorization", attempts: ["caller-fixture"] },
	];

	for (const { shape, caller, attempts: expected } of cases) {
		const behavior = caller ? `keeps the caller's ${caller} override` : "retries with the newer stored credential";
		test(`${behavior} for SDK-prepared ${shape} auth (#3620)`, async () => {
			const headerAuth = shape === "header OAuth";
			const credential = (key: string) =>
				headerAuth ? oauthCredential(key) : ({ type: "api_key", key } satisfies ApiKeyCredential);
			const authStorage = AuthStorage.create(authPath);
			await authStorage.modify(probe.provider, async () => credential("old-fixture"));
			const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
			const attempts: (string | undefined)[] = [];
			const stream: Provider["stream"] = (model, _context, options) => {
				attempts.push(headerAuth ? options?.headers?.Authorization : options?.apiKey);
				const output = createAssistantMessageEventStream();
				if (attempts.length === 1) {
					rotateStoredCredential(probe.provider, credential("new-fixture"));
					output.push({ type: "error", reason: "error", error: message(model, "401 Unauthorized") });
				} else output.push({ type: "done", reason: "stop", message: message(model) });
				return output;
			};
			modelRuntime.registerNativeProvider({
				id: probe.provider,
				name: "Auth probe",
				auth: headerAuth
					? {
							oauth: {
								name: "Auth probe SSO",
								login: async () => oauthCredential("login-fixture"),
								refresh: async () => {
									throw new Error("unexpected refresh");
								},
								toAuth: async ({ access }) => ({ headers: { Authorization: `Bearer ${access}` } }),
							},
						}
					: {
							apiKey: {
								name: "Auth probe key",
								resolve: async ({ credential: stored }) =>
									stored?.key ? { auth: { apiKey: stored.key }, source: "stored" } : undefined,
							},
						},
				models: [probe],
				stream,
				streamSimple: stream,
			});
			const session = await startSession(probe, modelRuntime, authStorage);
			try {
				const response = await session.agent.streamFunction(
					probe,
					{ messages: [] },
					{
						sessionId: session.sessionId,
						...(caller === "apiKey" ? { apiKey: "caller-fixture" } : {}),
						...(caller === "Authorization" ? { headers: { Authorization: "caller-fixture" } } : {}),
					},
				);
				const result = await response.result();
				assert.deepEqual(attempts, expected);
				assert.equal(result.stopReason, expected.length === 2 ? "stop" : "error", result.errorMessage);
			} finally {
				session.dispose();
			}
		});
	}
});

test("SDK native service-tier fast route retries once with the newer stored credential (#3620)", async () => {
	const baseModelId = "openai-test-model";
	const fastRoute: ModelFastRoute = {
		baseModelId,
		upstreamModelId: baseModelId,
		serviceTier: FAST_MODEL_SERVICE_TIER,
	};
	const model: Model<Api> = {
		...probe,
		id: `${baseModelId}-fast`,
		name: "OpenAI fast",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://openai.example/v1",
		fastRoute,
	};
	const authStorage = AuthStorage.create(authPath);
	await authStorage.modify("openai", async () => ({ type: "api_key", key: "old-fixture" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const requests: { authorization: string | null; body: { model?: string; service_tier?: string } }[] = [];
	vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
		requests.push({
			authorization: new Headers(init?.headers).get("authorization"),
			body: JSON.parse(String(init?.body)) as { model?: string; service_tier?: string },
		});
		if (requests.length === 1) {
			rotateStoredCredential("openai", { type: "api_key", key: "new-fixture" });
			return new Response(
				JSON.stringify({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }),
				{
					status: 401,
					headers: { "content-type": "application/json" },
				},
			);
		}
		const completed = {
			type: "response.completed",
			response: {
				id: "resp_test",
				status: "completed",
				service_tier: FAST_MODEL_SERVICE_TIER,
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		};
		return new Response(`data: ${JSON.stringify(completed)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	const session = await startSession(model, modelRuntime, authStorage);
	try {
		const response = await session.agent.streamFunction(
			model,
			{ messages: [] },
			{ sessionId: session.sessionId, maxRetries: 0 },
		);
		const result = await response.result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(result.model, model.id);
		assert.deepEqual(
			requests.map((request) => request.authorization),
			["Bearer old-fixture", "Bearer new-fixture"],
		);
		for (const { body } of requests) {
			assert.equal(body.model, baseModelId);
			assert.equal(body.service_tier, FAST_MODEL_SERVICE_TIER);
		}
	} finally {
		session.dispose();
	}
});
