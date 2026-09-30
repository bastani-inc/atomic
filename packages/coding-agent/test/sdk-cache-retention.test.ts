import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { afterEach, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

interface CachePayload {
	system: Array<{ cache_control?: { type: "ephemeral"; ttl?: "1h" } }>;
}

afterEach(() => vi.unstubAllEnvs());

it("session requests serialize long caching, retain overrides and obey provider capabilities", async () => {
	vi.stubEnv("PI_CACHE_RETENTION", undefined);
	const cwd = mkdtempSync(join(tmpdir(), "atomic-cache-retention-"));
	const credentials = AuthStorage.inMemory();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
	const model = getModel("anthropic", "claude-haiku-4-5");
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		modelRuntime,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		tools: [],
	});
	try {
		for (const scenario of [
			{ retention: undefined, supported: true, expected: { type: "ephemeral", ttl: "1h" } },
			{ retention: "short", supported: true, expected: { type: "ephemeral" } },
			{ retention: "none", supported: true, expected: undefined },
			{ retention: "long", supported: true, expected: { type: "ephemeral", ttl: "1h" } },
			{ retention: undefined, supported: false, expected: { type: "ephemeral" } },
		] as const) {
			let payload: CachePayload | undefined;
			const stream = await session.agent.streamFunction(
				{ ...model, compat: { ...model.compat, supportsLongCacheRetention: scenario.supported } },
				{ systemPrompt: "Cache this prefix", messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
				{
					cacheRetention: scenario.retention,
					onPayload: (value) => {
						payload = value as CachePayload;
						// Stop before the HTTP boundary: no credentials, paid calls or cache-warming required.
						throw new Error("payload captured");
					},
				},
			);
			await stream.result();
			assert.ok(payload, "provider payload must be captured");
			assert.deepEqual(payload.system[0].cache_control, scenario.expected);
		}
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("defaults only capable OpenAI and Bedrock models to extended retention", async () => {
	vi.stubEnv("PI_CACHE_RETENTION", undefined);
	vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "fixture");
	vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "fixture");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-cache-boundaries-"));
	const credentials = AuthStorage.inMemory();
	for (const provider of [
		"openai",
		"openrouter",
		"amazon-bedrock",
		"cloudflare-ai-gateway",
		"github-copilot",
		"opencode",
	]) {
		await credentials.modify(provider, async () => ({
			type: "api_key",
			key: provider === "openai" ? "sk-test-key" : "test-key",
		}));
	}
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
	const gpt4o = getModel("openai", "gpt-4o");
	const gpt5 = getModel("openai", "gpt-5");
	const sonnet = getModel("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0");
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: gpt5,
		modelRuntime,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(),
		resourceLoader: createTestResourceLoader(),
		builtins: { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false },
		tools: [],
	});
	try {
		for (const api of ["openai-responses", "openai-completions"] as const) {
			for (const [base, supported] of [
				[gpt4o, false],
				[gpt5, true],
				[getModel("openai", "gpt-4.1"), true],
				[getModel("openai", "gpt-4.1-mini"), false],
				[getModel("openai", "gpt-5-mini"), false],
				...(api === "openai-responses"
					? ([
							[getModel("cloudflare-ai-gateway", "gpt-4o"), false],
							[getModel("cloudflare-ai-gateway", "gpt-5"), true],
							[getModel("github-copilot", "gpt-5-mini"), false],
							[getModel("github-copilot", "gpt-5.4"), true],
							[getModel("opencode", "gpt-5-nano"), false],
							[getModel("opencode", "gpt-5"), true],
						] as const)
					: []),
				// OpenRouter registers Completions, not Responses.
				...(api === "openai-completions"
					? ([
							[getModel("openrouter", "openai/gpt-4o"), false],
							[getModel("openrouter", "openai/gpt-5"), true],
						] as const)
					: []),
				[{ ...gpt5, id: "gpt-5-2025-08-07" }, true],
				[
					{
						...gpt5,
						id: "gpt-5-fast",
						fastRoute: { baseModelId: "gpt-5", upstreamModelId: "gpt-5", serviceTier: "priority" },
					},
					true,
				],
				[{ ...gpt4o, compat: { ...gpt4o.compat, supportsLongCacheRetention: true } }, true],
			] as const) {
				for (const retention of [undefined, "short", "none", "long"] as const) {
					let payload: { prompt_cache_retention?: string } | undefined;
					const stream = await session.agent.streamFunction(
						{ ...base, api },
						{
							systemPrompt: "Stable prefix",
							messages: [{ role: "user", content: "Hello", timestamp: 0 }],
						},
						{
							cacheRetention: retention,
							onPayload: (value) => {
								payload = value as typeof payload;
								throw new Error("payload captured");
							},
						},
					);
					const result = await stream.result();
					assert.ok(payload, `${api}/${base.id}: ${JSON.stringify(result)}`);
					// Explicit long remains a caller choice; only the implicit default is capability-aware.
					assert.equal(
						payload.prompt_cache_retention,
						retention === "long" || (retention === undefined && supported) ? "24h" : undefined,
						`${base.provider}/${api}/${base.id}/${retention}`,
					);
				}
			}
		}
		for (const retention of [undefined, "short", "none", "long"] as const) {
			let payload:
				| { prompt_cache_retention?: string; prompt_cache_options?: { ttl?: string; mode?: string } }
				| undefined;
			const stream = await session.agent.streamFunction(
				getModel("openai", "gpt-5.6-sol"),
				{
					messages: [{ role: "user", content: "Hello", timestamp: 0 }],
				},
				{
					env: { PI_CACHE_RETENTION: retention },
					onPayload: (value) => {
						payload = value as typeof payload;
						throw new Error("payload captured");
					},
				},
			);
			await stream.result();
			assert.ok(payload);
			assert.equal(payload.prompt_cache_retention, undefined);
			assert.deepEqual(
				payload.prompt_cache_options,
				retention === "none" ? { mode: "explicit" } : retention === "short" ? undefined : { ttl: "30m" },
			);
		}
		for (const [model, supported] of [
			[sonnet, true],
			[{ ...sonnet, id: "anthropic.claude-3-7-sonnet-20250219-v1:0", name: "Claude 3.7 Sonnet" }, false],
			[{ ...sonnet, id: "anthropic.claude-sonnet-4-20250514-v1:0", name: "Claude Sonnet 4" }, false],
			[
				{
					...sonnet,
					id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/old",
					name: "Claude 3.7 Sonnet",
				},
				false,
			],
			[getModel("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0"), true],
			[{ ...sonnet, id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }, true],
			[
				{
					...sonnet,
					id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/example",
					name: "Claude Sonnet 4.5",
				},
				true,
			],
		] as const) {
			for (const retention of [undefined, "short", "none", "long"] as const) {
				let payload:
					| {
							system: Array<{ cachePoint?: { ttl?: string } }>;
							messages: Array<{ content: Array<{ cachePoint?: { ttl?: string } }> }>;
					  }
					| undefined;
				const stream = await session.agent.streamFunction(
					model,
					{
						systemPrompt: "Stable prefix",
						messages: [{ role: "user", content: "Hello", timestamp: 0 }],
					},
					{
						cacheRetention: retention,
						onPayload: (value) => {
							payload = value as typeof payload;
							throw new Error("payload captured");
						},
					},
				);
				await stream.result();
				assert.ok(payload);
				const expected = retention === "long" || (retention === undefined && supported) ? "1h" : undefined;
				for (const blocks of [payload.system, payload.messages[0].content]) {
					const point = blocks.find((block) => block.cachePoint)?.cachePoint;
					assert.equal(point?.ttl, expected, `${model.id}/${retention}`);
					assert.equal(Boolean(point), retention !== "none");
				}
			}
		}
	} finally {
		await session.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
