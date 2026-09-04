import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@bastani/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	copilotAdvertisedFastModelIds,
	deriveFastModelVariants,
	FAST_MODEL_SERVICE_TIER,
	fastModelId,
	isNativeFastRouteApi,
	usesOpenAIFastServiceTier,
	withFastModelVariants,
} from "../src/core/fast-model-variants.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function model(partial: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider" | "api">): Model<Api> {
	return {
		name: partial.id,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...partial,
	};
}

function ids(models: readonly Model<Api>[]): string[] {
	return models.map((entry) => entry.id);
}

describe("fast model variant eligibility", () => {
	it("routes only first-party OpenAI and OpenAI Codex providers", () => {
		assert.equal(usesOpenAIFastServiceTier({ provider: "openai", api: "openai-responses" }), true);
		assert.equal(usesOpenAIFastServiceTier({ provider: "openai-codex", api: "openai-codex-responses" }), true);
		assert.equal(usesOpenAIFastServiceTier({ provider: "codex-proxy", api: "openai-codex-responses" }), false);
	});

	it("keeps Azure OpenAI, OpenRouter, and generic OpenAI-compatible providers ineligible", () => {
		assert.equal(
			usesOpenAIFastServiceTier({ provider: "azure-openai-responses", api: "azure-openai-responses" }),
			false,
		);
		assert.equal(usesOpenAIFastServiceTier({ provider: "openrouter", api: "openai-completions" }), false);
		assert.equal(usesOpenAIFastServiceTier({ provider: "my-openai-compatible", api: "openai-responses" }), false);
		assert.equal(usesOpenAIFastServiceTier({ provider: "github-copilot", api: "openai-responses" }), false);
	});

	/**
	 * Eligibility must also require an adapter that can carry `service_tier`. Only
	 * `openai-responses` and `openai-codex-responses` serialize it; `openai-completions` and
	 * `azure-openai-responses` have no such option and `streamSimple` drops it, so deriving a variant
	 * there would offer a "fast" choice that silently sends an ordinary request.
	 */
	it.each([
		["openai", "openai-responses", true],
		["openai", "openai-codex-responses", true],
		["openai", "openai-completions", false],
		["openai-codex", "openai-codex-responses", true],
		["openai-codex", "openai-completions", false],
		["codex-proxy", "openai-codex-responses", false],
		["azure-openai-responses", "azure-openai-responses", false],
		["openrouter", "openai-completions", false],
		["my-openai-compatible", "openai-responses", false],
		["github-copilot", "openai-responses", false],
		["github-copilot", "anthropic-messages", false],
	] as const)("%s on %s is service-tier eligible: %s", (provider, api, eligible) => {
		assert.equal(usesOpenAIFastServiceTier({ provider, api }), eligible);
		const derived = deriveFastModelVariants(provider, [model({ id: "probe", provider, api })]).models;
		assert.deepEqual(ids(derived), eligible ? ["probe", "probe-fast"] : ["probe"]);
	});

	it("guarantees every derived service-tier route reaches an adapter that sends the tier", () => {
		const apis = ["openai-responses", "openai-codex-responses", "openai-completions", "anthropic-messages"] as const;
		for (const api of apis) {
			for (const provider of ["openai", "openai-codex", "github-copilot", "codex-proxy"]) {
				const { models } = deriveFastModelVariants(provider, [model({ id: "probe", provider, api })], {
					copilotFastModelIds: ["probe-fast"],
				});
				for (const derivedModel of models) {
					if (derivedModel.fastRoute?.serviceTier === undefined) continue;
					assert.equal(
						isNativeFastRouteApi(derivedModel.api),
						true,
						`${provider}/${derivedModel.id} on ${api} carries a service tier the adapter cannot send`,
					);
				}
			}
		}
	});
});

describe("deriveFastModelVariants", () => {
	it("appends a service-tier fast variant after each eligible OpenAI model, preserving order", () => {
		const base = [
			model({ id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses", name: "GPT-5.6 Sol" }),
			model({ id: "gpt-5.4", provider: "openai-codex", api: "openai-codex-responses", name: "GPT-5.4" }),
		];
		const { models, diagnostics } = deriveFastModelVariants("openai-codex", base);

		assert.deepEqual(ids(models), ["gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.4", "gpt-5.4-fast"]);
		assert.deepEqual(diagnostics, []);
		const fast = models[1];
		assert.deepEqual(fast?.fastRoute, {
			baseModelId: "gpt-5.6-sol",
			upstreamModelId: "gpt-5.6-sol",
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
		assert.equal(fast?.name, "GPT-5.6 Sol (fast)");
		// The base model's cost is preserved verbatim; the adapter applies the priority multiplier.
		assert.deepEqual(fast?.cost, base[0]?.cost);
		// The base model is untouched.
		assert.equal(base[0]?.fastRoute, undefined);
	});

	it("returns ineligible catalogs unchanged", () => {
		const base = [
			model({ id: "gpt-5.6", provider: "azure-openai-responses", api: "azure-openai-responses" }),
			model({ id: "anthropic/claude-opus-5", provider: "openrouter", api: "openai-completions" }),
			model({ id: "local-model", provider: "my-openai-compatible", api: "openai-responses" }),
		];
		const derivation = deriveFastModelVariants("mixed", base);

		assert.equal(derivation.models, base);
		assert.deepEqual(derivation.diagnostics, []);
	});

	it("derives a Copilot variant only for an exact advertised fast sibling", () => {
		const base = [
			model({ id: "claude-opus-4.8", provider: "github-copilot", api: "anthropic-messages" }),
			model({ id: "claude-opus-4.7", provider: "github-copilot", api: "anthropic-messages" }),
		];
		const { models } = deriveFastModelVariants("github-copilot", base, {
			copilotFastModelIds: ["claude-opus-4.8-fast"],
		});

		assert.deepEqual(ids(models), ["claude-opus-4.8", "claude-opus-4.8-fast", "claude-opus-4.7"]);
		assert.deepEqual(models[1]?.fastRoute, {
			baseModelId: "claude-opus-4.8",
			upstreamModelId: "claude-opus-4.8-fast",
		});
		// Copilot never carries an OpenAI service tier.
		assert.equal(models[1]?.fastRoute?.serviceTier, undefined);
	});

	it("derives no Copilot variants when the credential advertises none", () => {
		const base = [model({ id: "claude-opus-4.8", provider: "github-copilot", api: "anthropic-messages" })];
		assert.deepEqual(ids(deriveFastModelVariants("github-copilot", base).models), ["claude-opus-4.8"]);
		assert.deepEqual(ids(deriveFastModelVariants("github-copilot", base, { copilotFastModelIds: [] }).models), [
			"claude-opus-4.8",
		]);
	});

	it("lets an exact owned -fast model win the collision and records an actionable diagnostic", () => {
		const owned = model({
			id: "gpt-5.6-sol-fast",
			provider: "openai-codex",
			api: "openai-codex-responses",
			name: "Custom Sol Fast",
			maxTokens: 999,
		});
		const base = [model({ id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses" }), owned];
		const { models, diagnostics } = deriveFastModelVariants("openai-codex", base);

		assert.deepEqual(ids(models), ["gpt-5.6-sol", "gpt-5.6-sol-fast"]);
		// The owned entry is passed through untouched and gains no derived fast semantics.
		assert.equal(models[1], owned);
		assert.equal(models[1]?.fastRoute, undefined);
		assert.equal(models[1]?.maxTokens, 999);
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0]?.provider, "openai-codex");
		assert.equal(diagnostics[0]?.modelId, "gpt-5.6-sol-fast");
		expect(diagnostics[0]?.message).toContain('Model "openai-codex/gpt-5.6-sol-fast" is already defined');
		expect(diagnostics[0]?.message).toContain("Rename or remove it");
	});

	it("never derives a -fast-fast variant and never re-derives an existing fast variant", () => {
		const base = [
			model({ id: "gpt-5.6-sol-fast", provider: "openai-codex", api: "openai-codex-responses" }),
			{
				...model({ id: "gpt-5.4-fast", provider: "openai-codex", api: "openai-codex-responses" }),
				fastRoute: { baseModelId: "gpt-5.4", upstreamModelId: "gpt-5.4", serviceTier: FAST_MODEL_SERVICE_TIER },
			},
		];
		const { models, diagnostics } = deriveFastModelVariants("openai-codex", base);

		assert.deepEqual(ids(models), ["gpt-5.6-sol-fast", "gpt-5.4-fast"]);
		assert.deepEqual(diagnostics, []);
	});

	it("derives nothing for an API whose transport an extension owns", () => {
		const base = [model({ id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses" })];

		assert.deepEqual(ids(deriveFastModelVariants("openai-codex", base).models), ["gpt-5.6-sol", "gpt-5.6-sol-fast"]);
		// Atomic cannot enforce the route through a transport it does not serialize.
		assert.deepEqual(
			ids(
				deriveFastModelVariants("openai-codex", base, {
					extensionOwnedApis: new Set(["openai-codex-responses"]),
				}).models,
			),
			["gpt-5.6-sol"],
		);
		// A different API on the same provider is unaffected.
		assert.deepEqual(
			ids(
				deriveFastModelVariants("openai-codex", base, { extensionOwnedApis: new Set(["openai-responses"]) }).models,
			),
			["gpt-5.6-sol", "gpt-5.6-sol-fast"],
		);
	});

	/**
	 * User amendment (2026-09-03): synthetic `-fast` aliases are limited to the first-party OpenAI
	 * and OpenAI Codex provider IDs. GitHub Copilot exposes only exact account-advertised real
	 * `-fast` IDs. OpenRouter and non-first-party providers are explicitly excluded.
	 */
	it("synthesizes fast aliases only for OpenAI and OpenAI Codex", () => {
		const providers: Array<[string, Api]> = [
			["openai", "openai-responses"],
			["openai-codex", "openai-codex-responses"],
			["codex-proxy", "openai-codex-responses"],
			["openrouter", "openai-completions"],
			["openrouter", "openai-responses"],
			["azure-openai-responses", "azure-openai-responses"],
			["anthropic", "anthropic-messages"],
			["vercel-ai-gateway", "openai-completions"],
			["my-openai-compatible", "openai-responses"],
			["github-copilot", "openai-responses"],
			["github-copilot", "anthropic-messages"],
		];
		const synthesized: string[] = [];
		for (const [provider, api] of providers) {
			// No Copilot entitlement is supplied, so any derived entry here is a synthetic alias.
			const { models } = deriveFastModelVariants(provider, [model({ id: "probe", provider, api })]);
			if (models.some((entry) => entry.fastRoute !== undefined)) synthesized.push(`${provider}/${api}`);
		}

		assert.deepEqual(synthesized, ["openai/openai-responses", "openai-codex/openai-codex-responses"]);

		// Copilot derives only for an exact advertised ID, and never as a service-tier route.
		const copilotBase = [model({ id: "claude-opus-4.8", provider: "github-copilot", api: "anthropic-messages" })];
		assert.deepEqual(ids(deriveFastModelVariants("github-copilot", copilotBase).models), ["claude-opus-4.8"]);
		const entitled = deriveFastModelVariants("github-copilot", copilotBase, {
			copilotFastModelIds: ["claude-opus-4.8-fast"],
		}).models;
		assert.deepEqual(ids(entitled), ["claude-opus-4.8", "claude-opus-4.8-fast"]);
		assert.equal(entitled[1]?.fastRoute?.serviceTier, undefined);
	});

	it("builds the canonical selectable ID", () => {
		assert.equal(fastModelId("gpt-5.6-sol"), "gpt-5.6-sol-fast");
	});
});

describe("copilotAdvertisedFastModelIds", () => {
	it("reads only a string array from an OAuth credential", () => {
		assert.deepEqual(
			copilotAdvertisedFastModelIds({
				type: "oauth",
				access: "t",
				refresh: "r",
				expires: 1,
				fastModelIds: ["a-fast"],
			}),
			["a-fast"],
		);
		assert.equal(copilotAdvertisedFastModelIds(undefined), undefined);
		assert.equal(copilotAdvertisedFastModelIds({ type: "api_key", key: "k" }), undefined);
		assert.equal(
			copilotAdvertisedFastModelIds({ type: "oauth", access: "t", refresh: "r", expires: 1, fastModelIds: [1] }),
			undefined,
		);
	});
});

describe("withFastModelVariants", () => {
	function fakeProvider(models: readonly Model<Api>[]): Provider {
		return {
			id: "openai-codex",
			name: "OpenAI Codex",
			auth: { apiKey: { name: "test", resolve: async () => undefined } },
			getModels: () => models,
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		} as unknown as Provider;
	}

	it("overlays derived models and reports diagnostics on every pass", () => {
		const base = [
			model({ id: "gpt-5.6-sol", provider: "openai-codex", api: "openai-codex-responses" }),
			model({ id: "gpt-5.4", provider: "openai-codex", api: "openai-codex-responses" }),
			model({ id: "gpt-5.4-fast", provider: "openai-codex", api: "openai-codex-responses" }),
		];
		const reported: string[][] = [];
		const wrapped = withFastModelVariants(fakeProvider(base), {
			onDiagnostics: (_id, diagnostics) => reported.push(diagnostics.map((entry) => entry.modelId)),
		});

		assert.deepEqual(ids(wrapped.getModels()), ["gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.4", "gpt-5.4-fast"]);
		assert.deepEqual(reported, [["gpt-5.4-fast"]]);
	});
});

describe("ModelRuntime fast model catalog", () => {
	async function runtimeWithCopilotCredential(fastModelIds: string[]): Promise<ModelRuntime> {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-variants-"));
		tempDirs.push(dir);
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		await authStorage.modify("github-copilot", async () => ({
			type: "oauth",
			access: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com",
			refresh: "test-refresh-token",
			expires: Number.MAX_SAFE_INTEGER,
			availableModelIds: ["claude-opus-4.8"],
			fastModelIds,
		}));
		return ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(dir, "models.json"),
			allowModelNetwork: false,
		});
	}

	it("exposes a derived -fast model as a real selectable built-in model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-variants-"));
		tempDirs.push(dir);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath: join(dir, "models.json"),
			allowModelNetwork: false,
		});

		const base = runtime.getModel("openai-codex", "gpt-5.6-sol");
		const fast = runtime.getModel("openai-codex", "gpt-5.6-sol-fast");
		assert.ok(base);
		assert.ok(fast);
		assert.equal(fast.id, "gpt-5.6-sol-fast");
		assert.deepEqual(fast.fastRoute, {
			baseModelId: "gpt-5.6-sol",
			upstreamModelId: "gpt-5.6-sol",
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
		assert.equal(fast.api, base.api);
		assert.equal(fast.contextWindow, base.contextWindow);
		// Normal and fast are distinct catalog entries.
		assert.notEqual(fast, base);
		assert.equal(runtime.getWarning(), undefined);
	});

	it("exposes GPT-6-Astra and its canonical derived fast identity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-variants-"));
		tempDirs.push(dir);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath: join(dir, "models.json"),
			allowModelNetwork: false,
		});

		const base = runtime.getModel("openai-codex", "gpt-6-astra");
		const fast = runtime.getModel("openai-codex", "gpt-6-astra-fast");
		assert.ok(base);
		assert.ok(fast);
		assert.notEqual(fast, base);
		assert.deepEqual(fast.fastRoute, {
			baseModelId: "gpt-6-astra",
			upstreamModelId: "gpt-6-astra",
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
		assert.equal(base.fastRoute, undefined);
	});

	it("gates Copilot Astra fast on the exact account entitlement without a priority tier", async () => {
		const entitled = await runtimeWithCopilotCredential(["gpt-6-astra-fast"]);
		const fast = entitled.getModel("github-copilot", "gpt-6-astra-fast");
		assert.ok(fast);
		assert.equal(fast.api, "openai-responses");
		assert.deepEqual(fast.fastRoute, {
			baseModelId: "gpt-6-astra",
			upstreamModelId: "gpt-6-astra-fast",
		});
		assert.ok((await entitled.getAvailable()).some((m) => m.provider === "github-copilot" && m.id === fast.id));
		const none = await runtimeWithCopilotCredential([]);
		assert.equal(none.getModel("github-copilot", "gpt-6-astra-fast"), undefined);
		assert.ok(none.getModel("github-copilot", "gpt-6-astra"));
		assert.equal(
			(await none.getAvailable()).some((m) => m.provider === "github-copilot" && m.id === "gpt-6-astra"),
			false,
		);
	});

	it("resolves a Copilot fast ID only while its entitlement is advertised", async () => {
		const entitled = await runtimeWithCopilotCredential(["claude-opus-4.8-fast"]);
		const fast = entitled.getModel("github-copilot", "claude-opus-4.8-fast");
		assert.ok(fast);
		assert.deepEqual(fast.fastRoute, {
			baseModelId: "claude-opus-4.8",
			upstreamModelId: "claude-opus-4.8-fast",
		});
		const available = await entitled.getAvailable();
		assert.equal(
			available.some((entry) => entry.provider === "github-copilot" && entry.id === "claude-opus-4.8-fast"),
			true,
		);

		// A different advertised entitlement exposes only that sibling, never the one it does not cover.
		const other = await runtimeWithCopilotCredential(["claude-opus-4.7-fast"]);
		assert.equal(other.getModel("github-copilot", "claude-opus-4.8-fast"), undefined);
		assert.ok(other.getModel("github-copilot", "claude-opus-4.7-fast"));
		const otherAvailable = await other.getAvailable();
		const otherFastIds = otherAvailable
			.filter((entry) => entry.provider === "github-copilot" && entry.fastRoute !== undefined)
			.map((entry) => entry.id);
		assert.deepEqual(otherFastIds, ["claude-opus-4.7-fast"]);

		// No advertised entitlement means no fast sibling anywhere.
		const none = await runtimeWithCopilotCredential([]);
		assert.equal(none.getModel("github-copilot", "claude-opus-4.8-fast"), undefined);
		const noneAvailable = await none.getAvailable();
		assert.equal(
			noneAvailable.some((entry) => entry.provider === "github-copilot" && entry.fastRoute !== undefined),
			false,
		);
	});

	it("reports the derived model identically through every catalog accessor", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-variants-"));
		tempDirs.push(dir);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath: join(dir, "models.json"),
			allowModelNetwork: false,
		});
		const hasFast = (models: readonly Model<Api>[]): boolean =>
			models.some((entry) => entry.id === "gpt-5.6-sol-fast");

		assert.ok(runtime.getModel("openai-codex", "gpt-5.6-sol-fast"));
		assert.equal(hasFast(runtime.getModels()), true);
		const fromProviders = runtime.getProviders().find((entry) => entry.id === "openai-codex");
		assert.ok(fromProviders);
		assert.equal(hasFast(fromProviders.getModels()), true);
		const fromProvider = runtime.getProvider("openai-codex");
		assert.ok(fromProvider);
		assert.equal(hasFast(fromProvider.getModels()), true);
		// `getProvider` and `getProviders` must not disagree about the catalog.
		assert.deepEqual(ids(fromProvider.getModels()), ids(fromProviders.getModels()));
	});

	it("applies a models.json modelOverrides entry keyed on the derived -fast ID", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-variants-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						modelOverrides: {
							"gpt-5.6-sol": { name: "Custom Base Name" },
							"gpt-5.6-sol-fast": { name: "Custom Fast Name", maxTokens: 4242 },
						},
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath,
			allowModelNetwork: false,
		});

		const base = runtime.getModel("openai-codex", "gpt-5.6-sol");
		const fast = runtime.getModel("openai-codex", "gpt-5.6-sol-fast");
		assert.ok(base);
		assert.ok(fast);
		assert.equal(base.name, "Custom Base Name");
		// The fast-specific override wins over the name inherited from the overridden base.
		assert.equal(fast.name, "Custom Fast Name");
		assert.equal(fast.maxTokens, 4242);
		// Route metadata survives the override, so the entry still routes as a fast variant.
		assert.deepEqual(fast.fastRoute, {
			baseModelId: "gpt-5.6-sol",
			upstreamModelId: "gpt-5.6-sol",
			serviceTier: FAST_MODEL_SERVICE_TIER,
		});
		assert.equal(runtime.getError(), undefined);
	});

	it("inherits the base model's override when the derived ID has none of its own", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-variants-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "openai-codex": { modelOverrides: { "gpt-5.6-sol": { name: "Custom Base Name" } } } },
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath,
			allowModelNetwork: false,
		});

		const fast = runtime.getModel("openai-codex", "gpt-5.6-sol-fast");
		assert.equal(fast?.name, "Custom Base Name (fast)");
	});

	it("suppresses a derived duplicate for a models.json custom model and warns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-fast-variants-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"openai-codex": {
						models: [
							{
								id: "gpt-5.6-sol-fast",
								name: "My Own Sol Fast",
								reasoning: false,
								input: ["text"],
								contextWindow: 4321,
							},
						],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.create(join(dir, "auth.json")),
			modelsPath,
			allowModelNetwork: false,
		});

		const owned = runtime.getModel("openai-codex", "gpt-5.6-sol-fast");
		assert.ok(owned);
		assert.equal(owned.name, "My Own Sol Fast");
		assert.equal(owned.contextWindow, 4321);
		// The exact owned ID wins: it gains no derived fast semantics.
		assert.equal(owned.fastRoute, undefined);

		const diagnostics = runtime.getFastModelVariantDiagnostics();
		assert.equal(
			diagnostics.some((entry) => entry.provider === "openai-codex" && entry.modelId === "gpt-5.6-sol-fast"),
			true,
		);
		expect(runtime.getWarning()).toContain('Model "openai-codex/gpt-5.6-sol-fast" is already defined');
		// A suppressed duplicate is a warning, never a composition error.
		assert.equal(runtime.getError(), undefined);
	});
});
