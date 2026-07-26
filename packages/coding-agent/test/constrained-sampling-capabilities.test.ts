import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import type { AtomicProviderCompat } from "../src/index.ts";
import { normalizeGrammarToolCapability } from "../src/core/model-capabilities.ts";
import { loadBuiltInModels, mergeCompat } from "../src/core/model-registry-builtins.ts";
import { validateModelsConfig } from "../src/core/model-registry-schemas.ts";

function compatOf(model: Model<Api>): AtomicProviderCompat | undefined {
	return model.compat as AtomicProviderCompat | undefined;
}

describe("constrained-sampling model capabilities", () => {
	test("accepts strict and grammar capability metadata in layered model configuration", () => {
		const config = {
			providers: {
				responses: {
					baseUrl: "https://example.test/v1",
					compat: {
						supportsStrictMode: true,
						supportsOpenAIGrammarTools: true,
						supportsGrammarTools: true,
					},
				},
				anthropic: {
					baseUrl: "https://example.test",
					compat: { supportsStrictTools: true, supportsTemperature: false, allowEmptySignature: true },
				},
			},
		};
		expect(validateModelsConfig.Check(config)).toBe(true);
	});

	test("maps the Atomic alias to pi-ai without changing unsupported or unknown metadata", () => {
		const unknown = { supportsStrictMode: false } satisfies AtomicProviderCompat;
		expect(normalizeGrammarToolCapability(undefined)).toBeUndefined();
		expect(normalizeGrammarToolCapability(unknown)).toBe(unknown);

		const aliasOnly = { supportsGrammarTools: true } satisfies AtomicProviderCompat;
		expect(normalizeGrammarToolCapability(aliasOnly)).toEqual({
			supportsGrammarTools: true,
			supportsOpenAIGrammarTools: true,
		});
		const canonicalOnly = { supportsOpenAIGrammarTools: false } satisfies AtomicProviderCompat;
		expect(normalizeGrammarToolCapability(canonicalOnly)).toEqual({
			supportsOpenAIGrammarTools: false,
			supportsGrammarTools: false,
		});
	});

	test("uses the canonical capability when aliases conflict to avoid false claims", () => {
		expect(
			normalizeGrammarToolCapability({ supportsOpenAIGrammarTools: false, supportsGrammarTools: true }),
		).toEqual({ supportsOpenAIGrammarTools: false, supportsGrammarTools: false });
	});

	test("preserves strict capability fields while merging model overrides", () => {
		const merged = mergeCompat(
			{ supportsStrictMode: true, supportsOpenAIGrammarTools: true },
			{ supportsStrictMode: false, supportsGrammarTools: true },
		) as AtomicProviderCompat;
		expect(merged).toEqual({
			supportsStrictMode: false,
			supportsOpenAIGrammarTools: true,
			supportsGrammarTools: true,
		});
	});

	test("mirrors verified generated grammar capability without enabling unknown models", () => {
		const models = loadBuiltInModels(new Map(), new Map());
		const capable = models.find((model) => compatOf(model)?.supportsOpenAIGrammarTools === true);
		expect(capable).toBeDefined();
		expect(compatOf(capable!)?.supportsGrammarTools).toBe(true);

		const unknown = models.find((model) => compatOf(model)?.supportsOpenAIGrammarTools === undefined);
		expect(unknown).toBeDefined();
		expect(compatOf(unknown!)?.supportsGrammarTools).toBeUndefined();
	});
	test("public Atomic model compatibility type exposes the alias", () => {
		const model = {
			compat: normalizeGrammarToolCapability({ supportsGrammarTools: true }),
		} as Pick<Model<Api>, "compat"> as Model<Api>;
		expect(compatOf(model)?.supportsGrammarTools).toBe(true);
	});
});
