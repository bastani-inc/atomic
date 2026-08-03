import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { normalizeGrammarToolCapability } from "../src/core/model-capabilities.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { AtomicProviderCompat } from "../src/index.ts";

function compatOf(model: Model<Api>): AtomicProviderCompat | undefined {
	return model.compat as AtomicProviderCompat | undefined;
}

describe("constrained-sampling model capabilities", () => {
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
		expect(normalizeGrammarToolCapability({ supportsOpenAIGrammarTools: false, supportsGrammarTools: true })).toEqual(
			{ supportsOpenAIGrammarTools: false, supportsGrammarTools: false },
		);
	});

	test("preserves unrelated strict capability fields while normalizing the grammar alias", () => {
		expect(normalizeGrammarToolCapability({ supportsStrictMode: false, supportsGrammarTools: true })).toEqual({
			supportsStrictMode: false,
			supportsGrammarTools: true,
			supportsOpenAIGrammarTools: true,
		});
	});

	test("preserves pinned generated grammar capabilities without inventing the Atomic alias", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		const models = runtime.getModels();
		const capable = models.find((model) => compatOf(model)?.supportsOpenAIGrammarTools === true);
		expect(capable).toBeDefined();
		expect(compatOf(capable!)?.supportsGrammarTools).toBeUndefined();
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
