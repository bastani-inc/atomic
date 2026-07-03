import { afterEach, describe, expect, it } from "vitest";
import {
	clearActiveCopilotModelCatalog,
	setActiveCopilotModelCatalog,
} from "../src/core/copilot-model-catalog.ts";
import { getStaticCopilotModelFallback } from "../src/core/copilot-model-static-fallbacks.ts";
import { loadBuiltInModels } from "../src/core/model-registry-builtins.ts";

function builtins() {
	return loadBuiltInModels(new Map(), new Map());
}

function copilotModel(id: string) {
	return builtins().find((m) => m.provider === "github-copilot" && m.id === id);
}

describe("Copilot static CAPI fallback limits", () => {
	afterEach(() => {
		clearActiveCopilotModelCatalog();
	});

	it("corrects bundled limits from the CAPI snapshot when no catalog is loaded", () => {
		clearActiveCopilotModelCatalog();

		// Bundled pi-ai metadata claims 400k for gpt-5.5; CAPI's default tier is 272k.
		// Without this correction, auto-compaction (driven by model.contextWindow)
		// never fires before the server-side cap, and CAPI intercepts over-cap
		// requests with canned zero-usage refusals (issue #1608).
		const gpt55 = copilotModel("gpt-5.5");
		expect(gpt55?.contextWindow).toBe(272_000);
		expect(gpt55?.maxTokens).toBe(128_000);

		// Bundled claude-opus-4.6 understates the output cap (32k vs CAPI's 64k)
		// and claims the branded 1M window as its base tier (vs CAPI's 200k).
		const opus46 = copilotModel("claude-opus-4.6");
		expect(opus46?.contextWindow).toBe(200_000);
		expect(opus46?.maxTokens).toBe(64_000);
	});

	it("preserves CAPI long-context tiers offline (1M-class input + output)", () => {
		clearActiveCopilotModelCatalog();

		// gpt-5.5: 272k default tier plus the 1.05M branded long tier with a hard
		// 922k input cap — a returning user's persisted long-context selection must
		// stay valid on a cold start without a catalog.
		const gpt55 = copilotModel("gpt-5.5");
		expect(gpt55?.contextWindowOptions).toEqual([272_000, 1_050_000]);
		expect(gpt55?.maxInputTokens).toBe(922_000);

		// claude-opus-4.8: 200k default tier plus the 1M branded long tier with a
		// 936k input cap and 64k output.
		const opus48 = copilotModel("claude-opus-4.8");
		expect(opus48?.contextWindow).toBe(200_000);
		expect(opus48?.contextWindowOptions).toEqual([200_000, 1_000_000]);
		expect(opus48?.maxInputTokens).toBe(936_000);
		expect(opus48?.maxTokens).toBe(64_000);

		// Models without a CAPI long tier stay scalar (no picker options).
		const haiku = copilotModel("claude-haiku-4.5");
		expect(haiku?.contextWindow).toBe(136_000);
		expect(haiku?.contextWindowOptions).toBeUndefined();
		expect(haiku?.maxInputTokens).toBeUndefined();
	});

	it("live catalog entries always win over the static snapshot", () => {
		setActiveCopilotModelCatalog(
			new Map([
				[
					"gpt-5.5",
					{
						contextWindow: 300_000,
						contextWindowOptions: [300_000, 1_100_000],
						maxInputTokens: 950_000,
						maxTokens: 100_000,
					},
				],
			]),
		);

		const gpt55 = copilotModel("gpt-5.5");
		expect(gpt55?.contextWindow).toBe(300_000);
		expect(gpt55?.maxTokens).toBe(100_000);
		expect(gpt55?.maxInputTokens).toBe(950_000);
		expect(gpt55?.contextWindowOptions).toEqual([300_000, 1_100_000]);
	});

	it("leaves models without a CAPI snapshot untouched", () => {
		clearActiveCopilotModelCatalog();

		// Not present in the CAPI catalog (no ground truth to snapshot).
		expect(getStaticCopilotModelFallback("gpt-5.2")).toBeUndefined();
		const gpt52 = copilotModel("gpt-5.2");
		expect(gpt52?.contextWindow).toBe(400_000);

		// Non-Copilot providers are never rewritten.
		const openai = builtins().find((m) => m.provider === "openai" && m.id === "gpt-5.5");
		expect(openai?.contextWindow).toBe(272_000);
		expect(openai?.maxTokens).toBe(128_000);
	});
});
