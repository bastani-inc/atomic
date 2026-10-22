import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	getAttributionHeaders,
	type Model,
	type SimpleStreamOptions,
} from "@bastani/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_NAME, VERSION } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession client identity", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	let originalTelemetryEnv: string | undefined;
	let originalAtomicTelemetryEnv: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-attribution-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		originalTelemetryEnv = process.env.PI_TELEMETRY;
		originalAtomicTelemetryEnv = process.env.ATOMIC_TELEMETRY;
		delete process.env.PI_TELEMETRY;
		delete process.env.ATOMIC_TELEMETRY;
	});

	afterEach(() => {
		if (originalTelemetryEnv === undefined) {
			delete process.env.PI_TELEMETRY;
		} else {
			process.env.PI_TELEMETRY = originalTelemetryEnv;
		}
		if (originalAtomicTelemetryEnv === undefined) {
			delete process.env.ATOMIC_TELEMETRY;
		} else {
			process.env.ATOMIC_TELEMETRY = originalAtomicTelemetryEnv;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(provider: string, baseUrl: string, id = `${provider}-test-model`): Model<Api> {
		return {
			id,
			name: `${provider} Test Model`,
			api: "openai-completions",
			provider,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
	}

	function createDoneStream() {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-completions",
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.end(message);
		return stream;
	}

	async function captureOptions(
		model: Model<Api>,
		options: {
			telemetryEnabled?: boolean;
			providerHeaders?: Record<string, string>;
			requestHeaders?: Record<string, string>;
			sessionId?: string;
			/** Session id sent with the request when it differs from the session's own, such as an imported empty one. */
			requestSessionId?: string;
			/** Source of an extension loaded from the agent directory. */
			extensionSource?: string;
			/** Drive the request through a prompt, so the agent loop adds its own default identity first. */
			viaAgentLoop?: boolean;
		} = {},
	): Promise<SimpleStreamOptions | undefined> {
		const settingsManager = SettingsManager.create(cwd, agentDir);
		if (options.telemetryEnabled === false) {
			settingsManager.setEnableInstallTelemetry(false);
		}
		if (options.extensionSource) {
			mkdirSync(join(agentDir, "extensions"), { recursive: true });
			writeFileSync(join(agentDir, "extensions", "headers.ts"), options.extensionSource);
		}

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			headers: options.providerHeaders,
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream();
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		if (options.sessionId) {
			await sessionManager.newSession({ id: options.sessionId });
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
		});

		try {
			if (options.viaAgentLoop) {
				await session.prompt("hello");
				return capturedOptions;
			}
			const stream = await session.agent.streamFunction(
				model,
				{ messages: [] },
				{
					sessionId: options.requestSessionId ?? session.sessionId,
					...(options.requestHeaders ? { headers: options.requestHeaders } : {}),
				},
			);
			await stream.result();
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	it("identifies Atomic with its own User-Agent and attributes requests to Atomic as a CLI agent", async () => {
		const model = createModel("openrouter", "https://openrouter.ai/api/v1");
		const options = await captureOptions(model);

		expect(options?.identity).toEqual({
			userAgent: { custom: getPiUserAgent(VERSION) },
			attribution: { name: APP_NAME, url: "https://atomic.sh", categories: ["cli-agent"] },
		});
		expect(getAttributionHeaders(model, options?.identity)).toEqual({
			"HTTP-Referer": "https://atomic.sh",
			"X-OpenRouter-Title": "atomic",
			"X-OpenRouter-Categories": "cli-agent",
		});
		expect(getAttributionHeaders(createModel("nvidia", "https://example.test/v1"), options?.identity)).toEqual({
			"X-BILLING-INVOKE-ORIGIN": "Atomic",
		});
		expect(getAttributionHeaders(createModel("opencode", "https://opencode.ai/zen/v1"), options?.identity)).toEqual({
			"x-opencode-client": "atomic",
		});
	});

	it.each([
		[true, { name: APP_NAME, url: "https://atomic.sh", categories: ["cli-agent"] }],
		[false, null],
	])(
		"replaces the agent loop's default pi attribution with Atomic's identity (telemetry enabled: %s)",
		async (telemetryEnabled, attribution) => {
			const options = await captureOptions(createModel("openrouter", "https://openrouter.ai/api/v1"), {
				telemetryEnabled,
				viaAgentLoop: true,
			});

			expect(options?.identity).toEqual({ userAgent: { custom: getPiUserAgent(VERSION) }, attribution });
		},
	);

	it("turns attribution off when telemetry is disabled", async () => {
		const model = createModel("nvidia", "https://integrate.api.nvidia.com/v1");
		const options = await captureOptions(model, { telemetryEnabled: false });

		expect(options?.identity).toEqual({ userAgent: { custom: getPiUserAgent(VERSION) }, attribution: null });
		expect(getAttributionHeaders(model, options?.identity)).toEqual({});
	});

	it("turns attribution off with the telemetry environment variable", async () => {
		process.env.ATOMIC_TELEMETRY = "0";
		const options = await captureOptions(createModel("openrouter", "https://openrouter.ai/api/v1"));

		expect(options?.identity?.attribution).toBeNull();
	});

	it("sends the identity on the wire to a built-in provider", async () => {
		for (const [telemetryEnabled, expected] of [
			[
				true,
				{
					"http-referer": "https://atomic.sh",
					"x-openrouter-title": "atomic",
					"x-openrouter-categories": "cli-agent",
				},
			],
			[false, {}],
		] as const) {
			const settingsManager = SettingsManager.create(cwd, agentDir);
			settingsManager.setEnableInstallTelemetry(telemetryEnabled);
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
			await authStorage.modify("openrouter", async () => ({ type: "api_key", key: "test-api-key" }));
			const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
			const model = createModel("openrouter", "https://openrouter.ai/api/v1");
			const { session } = await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime: getModelRuntime(modelRegistry),
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
			});
			let captured: Headers | undefined;
			try {
				const stream = await session.agent.streamFunction(
					model,
					{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
					{
						sessionId: session.sessionId,
						fetch: async (input, init) => {
							captured = new Request(input, init).headers;
							return new Response(
								'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n',
								{
									headers: { "content-type": "text/event-stream" },
								},
							);
						},
					},
				);
				await stream.result();
			} finally {
				session.dispose();
			}

			expect(captured?.get("user-agent")).toBe(getPiUserAgent(VERSION));
			for (const header of ["http-referer", "x-openrouter-title", "x-openrouter-categories"]) {
				expect(captured?.get(header) ?? undefined).toBe((expected as Record<string, string>)[header]);
			}
		}
	});

	it("leaves attribution to the identity instead of adding headers itself", async () => {
		const options = await captureOptions(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			providerHeaders: { "X-Provider": "provider" },
			requestHeaders: { "X-Request": "request" },
		});

		expect(options?.headers).toEqual({ "X-Provider": "provider", "X-Request": "request" });
	});

	it("adds the OpenCode session header", async () => {
		const options = await captureOptions(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(options?.headers?.["x-opencode-session"]).toBe("opencode-session");
	});

	it("adds the OpenCode session header for custom providers pointing at OpenCode", async () => {
		const options = await captureOptions(createModel("custom-opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
		});

		expect(options?.headers?.["x-opencode-session"]).toBe("opencode-session");
	});

	it("keeps an empty stored session ID as the OpenCode session", async () => {
		const options = await captureOptions(createModel("opencode", "https://opencode.ai/zen/v1"), {
			requestSessionId: "",
		});

		expect(options?.headers?.["x-opencode-session"]).toBe("");
	});

	it("does not add an OpenCode session header for other providers", async () => {
		const options = await captureOptions(createModel("openrouter", "https://openrouter.ai/api/v1"), {
			sessionId: "opencode-session",
		});

		expect(options?.headers?.["x-opencode-session"]).toBeUndefined();
	});

	it("shows the OpenCode session header to before_provider_headers handlers", async () => {
		const seen: Array<string | null | undefined> = [];
		(globalThis as { __seenOpenCodeSession?: typeof seen }).__seenOpenCodeSession = seen;
		try {
			const options = await captureOptions(createModel("opencode", "https://opencode.ai/zen/v1"), {
				sessionId: "opencode-session",
				extensionSource: `export default function (pi) {
					pi.on("before_provider_headers", (event) => {
						globalThis.__seenOpenCodeSession.push(event.headers["x-opencode-session"]);
					});
				}`,
			});

			expect(seen).toEqual(["opencode-session"]);
			expect(options?.headers?.["x-opencode-session"]).toBe("opencode-session");
		} finally {
			delete (globalThis as { __seenOpenCodeSession?: typeof seen }).__seenOpenCodeSession;
		}
	});

	it("lets before_provider_headers handlers remove the OpenCode session header", async () => {
		const options = await captureOptions(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			extensionSource: `export default function (pi) {
				pi.on("before_provider_headers", (event) => {
					delete event.headers["x-opencode-session"];
				});
			}`,
		});

		expect(options?.headers?.["x-opencode-session"]).toBeUndefined();
	});

	it("lets configured OpenCode headers override the session header", async () => {
		const options = await captureOptions(createModel("opencode", "https://opencode.ai/zen/v1"), {
			sessionId: "opencode-session",
			providerHeaders: {
				"x-opencode-session": "configured-session",
			},
		});

		expect(options?.headers?.["x-opencode-session"]).toBe("configured-session");
	});
});
