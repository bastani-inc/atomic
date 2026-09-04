import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	type FallbackModelLookup,
	fallbackKey,
	resolveFallbackModel,
	splitFallbackModel,
} from "../src/core/fallback-models.ts";
import { FAST_MODEL_SERVICE_TIER } from "../src/core/fast-model-variants.ts";
import { restoreModelFromSession } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getUsageCostBreakdown } from "../src/core/usage-totals.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function createRuntime(): Promise<ModelRuntime> {
	const dir = mkdtempSync(join(tmpdir(), "atomic-fast-identity-"));
	tempDirs.push(dir);
	const authStorage = AuthStorage.create(join(dir, "auth.json"));
	await authStorage.modify("openai-codex", async () => ({
		type: "oauth",
		access: "test-access-token",
		refresh: "test-refresh-token",
		expires: Number.MAX_SAFE_INTEGER,
	}));
	return ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(dir, "models.json"),
		allowModelNetwork: false,
	});
}

describe("selectable -fast model identity", () => {
	it("restores a persisted -fast model reference exactly", async () => {
		const runtime = await createRuntime();
		const restored = await restoreModelFromSession("openai-codex", "gpt-5.6-sol-fast", undefined, false, runtime);

		assert.equal(restored.fallbackMessage, undefined);
		assert.equal(restored.model?.provider, "openai-codex");
		assert.equal(restored.model?.id, "gpt-5.6-sol-fast");
		assert.deepEqual(restored.model?.fastRoute, {
			baseModelId: "gpt-5.6-sol",
			upstreamModelId: "gpt-5.6-sol",
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
	});

	it("restores GPT-6-Astra fast as a distinct canonical model", async () => {
		const runtime = await createRuntime();
		const restored = await restoreModelFromSession("openai-codex", "gpt-6-astra-fast", undefined, false, runtime);
		const normal = runtime.getModel("openai-codex", "gpt-6-astra");

		assert.equal(restored.fallbackMessage, undefined);
		assert.equal(restored.model?.id, "gpt-6-astra-fast");
		assert.deepEqual(restored.model?.fastRoute, {
			baseModelId: "gpt-6-astra",
			upstreamModelId: "gpt-6-astra",
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
		assert.ok(normal);
		assert.notEqual(restored.model, normal);
		assert.equal(normal.fastRoute, undefined);
	});

	it("restores the normal sibling as a different model", async () => {
		const runtime = await createRuntime();
		const normal = await restoreModelFromSession("openai-codex", "gpt-5.6-sol", undefined, false, runtime);

		assert.equal(normal.model?.id, "gpt-5.6-sol");
		assert.equal(normal.model?.fastRoute, undefined);
	});

	it("parses a -fast model reference with a thinking suffix without touching the ID", () => {
		assert.deepEqual(splitFallbackModel("openai-codex/gpt-5.6-sol-fast:medium"), {
			modelId: "openai-codex/gpt-5.6-sol-fast",
			thinkingLevel: "medium",
		});
		assert.deepEqual(splitFallbackModel("openai-codex/gpt-5.6-sol-fast"), {
			modelId: "openai-codex/gpt-5.6-sol-fast",
		});
	});

	it("keeps normal and fast IDs as distinct ordered fallback candidates and attempt keys", async () => {
		const runtime = await createRuntime();
		const lookup: FallbackModelLookup = {
			getAvailableSnapshot: () => runtime.getAvailableSnapshot(),
			getModel: (provider, modelId) => runtime.getModel(provider, modelId),
			hasConfiguredAuth: () => true,
		};
		const configured = ["openai-codex/gpt-5.6-sol-fast:medium", "openai-codex/gpt-5.6-sol:medium"];
		const resolved = configured.map((entry) => resolveFallbackModel(entry, lookup, "openai-codex"));

		assert.equal(
			resolved.every((candidate) => candidate !== undefined),
			true,
		);
		assert.deepEqual(
			resolved.map((candidate) => candidate?.model.id),
			["gpt-5.6-sol-fast", "gpt-5.6-sol"],
		);
		assert.deepEqual(
			resolved.map((candidate) => candidate?.thinkingLevel),
			["medium", "medium"],
		);

		const keys = resolved.map((candidate) =>
			candidate ? fallbackKey(candidate.model, candidate.thinkingLevel) : undefined,
		);
		assert.deepEqual(keys, ["openai-codex/gpt-5.6-sol-fast:medium", "openai-codex/gpt-5.6-sol:medium"]);
		assert.equal(new Set(keys).size, 2);
	});

	it("lists both the normal and fast IDs in the selectable catalog", async () => {
		const runtime = await createRuntime();
		const codexIds = runtime
			.getModels()
			.filter((model: Model<Api>) => model.provider === "openai-codex")
			.map((model) => model.id);

		assert.equal(codexIds.includes("gpt-5.6-sol"), true);
		assert.equal(codexIds.includes("gpt-5.6-sol-fast"), true);
		assert.equal(codexIds.filter((id) => id === "gpt-5.6-sol-fast").length, 1);
	});
});

/**
 * The divergent case: an OpenAI-style fast route sends the *base* upstream model ID while the
 * canonical `-fast` ID stays the selected identity. GitHub Copilot cannot cover this, because its
 * advertised fast ID and its canonical ID are the same string, so a Copilot-only test would let a
 * regression here pass unnoticed.
 */
describe("divergent upstream model ID keeps the canonical identity", () => {
	const baseModelId = "probe-model";
	const fastModelId = "probe-model-fast";

	function probeModel(id: string, fastRoute?: Model<Api>["fastRoute"]): Model<Api> {
		return {
			id,
			name: id,
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://probe.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			...(fastRoute ? { fastRoute } : {}),
		};
	}

	function completedResponse(): Response {
		const completed = {
			type: "response.completed",
			response: {
				id: "resp_probe",
				status: "completed",
				service_tier: FAST_MODEL_SERVICE_TIER,
				usage: {
					input_tokens: 10,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 5,
					total_tokens: 15,
				},
			},
		};
		return new Response(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	it("sends the base model on the wire but records, persists, and restores the -fast ID", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-divergent-"));
		tempDirs.push(dir);
		const cwd = join(dir, "project");
		const agentDir = join(dir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const model = probeModel(fastModelId, {
			baseModelId,
			upstreamModelId: baseModelId,
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
		const sessionManager = SessionManager.inMemory(cwd);
		let capturedPayload: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				capturedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completedResponse();
			}),
		);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			authStorage,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager,
		});
		try {
			await session.prompt("hello");
		} finally {
			session.dispose();
			vi.unstubAllGlobals();
		}

		// The outbound request routes to the base upstream model, with the priority tier.
		assert.equal(capturedPayload?.model, baseModelId);
		assert.equal(capturedPayload?.service_tier, FAST_MODEL_SERVICE_TIER);

		// Everything Atomic records keeps the canonical `-fast` identity.
		const context = sessionManager.buildSessionContext();
		assert.deepEqual(context.model, { provider: "openai", modelId: fastModelId });
		const assistant = context.messages.findLast((message) => message.role === "assistant");
		assert.equal(assistant?.role === "assistant" ? assistant.model : undefined, fastModelId);

		const breakdown = getUsageCostBreakdown(sessionManager.getEntries());
		assert.deepEqual(
			breakdown.map((entry) => entry.key),
			[`openai/${fastModelId}`],
		);

		// A resumed session restores the exact `-fast` ID, not the base it routed to.
		modelRuntime.registerProvider("openai", {
			api: "openai-responses",
			models: [probeModel(baseModelId), model],
		});
		try {
			const resumed = await createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRuntime,
				settingsManager: SettingsManager.inMemory({}),
				sessionManager,
			});
			try {
				assert.equal(resumed.session.model?.id, fastModelId);
			} finally {
				resumed.session.dispose();
			}
		} finally {
			modelRuntime.unregisterProvider("openai");
		}
	});

	it("keeps a mixed normal/fast session as two distinct usage rows", () => {
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
		};
		const assistantEntry = (modelId: string): SessionEntry =>
			({
				type: "message",
				id: modelId,
				parentId: null,
				timestamp: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-responses",
					provider: "openai",
					model: modelId,
					usage,
					stopReason: "stop",
					timestamp: Date.now(),
				},
			}) as unknown as SessionEntry;

		const breakdown = getUsageCostBreakdown([assistantEntry(baseModelId), assistantEntry(fastModelId)]);
		assert.deepEqual(breakdown.map((entry) => entry.key).sort(), [`openai/${baseModelId}`, `openai/${fastModelId}`]);
	});
});
