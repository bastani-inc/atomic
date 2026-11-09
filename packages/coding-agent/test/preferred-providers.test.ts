import { describe, expect, it } from "vitest";
import {
	compareProviders,
	isPreferredProvider,
	PREFERRED_PROVIDER_IDS,
	RADIUS_PROVIDER_ID,
} from "../src/core/preferred-providers.ts";
import {
	getLoginProviderCompletions,
	mergeLoginProviderOptions,
} from "../src/modes/interactive/login-provider-options.ts";

describe("compareProviders", () => {
	it("orders preferred partners first, in their order, then the rest by name", () => {
		const providers = [
			{ id: "zai", name: "Z.AI" },
			{ id: "openrouter", name: "OpenRouter" },
			{ id: "anthropic", name: "Anthropic" },
			{ id: "radius", name: "Radius" },
			{ id: "google", name: "Google" },
		];

		expect(PREFERRED_PROVIDER_IDS).toEqual(["radius", "openrouter"]);
		expect(providers.sort(compareProviders).map((provider) => provider.id)).toEqual([
			"radius",
			"openrouter",
			"anthropic",
			"google",
			"zai",
		]);
	});

	it("keeps a partner first even when its name sorts last", () => {
		expect(compareProviders({ id: "radius", name: "Zzz" }, { id: "anthropic", name: "Anthropic" })).toBeLessThan(0);
		expect(compareProviders({ id: "anthropic", name: "Anthropic" }, { id: "radius", name: "Zzz" })).toBeGreaterThan(
			0,
		);
	});

	it("treats equal providers as equal so a stable sort keeps their order", () => {
		expect(compareProviders({ id: "openrouter", name: "OpenRouter" }, { id: "openrouter", name: "OpenRouter" })).toBe(
			0,
		);
		expect(compareProviders({ id: "first", name: "Shared" }, { id: "second", name: "Shared" })).toBe(0);
	});
});

describe("isPreferredProvider", () => {
	it("recognizes only the preferred partners", () => {
		expect(RADIUS_PROVIDER_ID).toBe("radius");
		expect(isPreferredProvider("radius")).toBe(true);
		expect(isPreferredProvider("openrouter")).toBe(true);
		expect(isPreferredProvider("anthropic")).toBe(false);
	});
});

describe("login provider completions", () => {
	const options = [
		{ id: "zai", name: "Z.AI", authType: "api_key" as const },
		{ id: "openrouter", name: "OpenRouter", authType: "oauth" as const, subscription: false },
		{ id: "openrouter", name: "OpenRouter", authType: "api_key" as const },
		{ id: "anthropic", name: "Anthropic", authType: "api_key" as const },
		{ id: "radius", name: "Radius", authType: "oauth" as const },
	];

	it("merges methods per provider and lists partners first", () => {
		expect(mergeLoginProviderOptions(options).map((option) => `${option.id}:${option.authTypes.join("+")}`)).toEqual([
			"radius:oauth",
			"openrouter:oauth+api_key",
			"anthropic:api_key",
			"zai:api_key",
		]);
	});

	it("offers partners first when nothing is typed and keeps fuzzy matching otherwise", () => {
		expect(getLoginProviderCompletions(options, "")?.map((item) => item.value)).toEqual([
			"radius",
			"openrouter",
			"anthropic",
			"zai",
		]);
		expect(getLoginProviderCompletions(options, "anth")?.map((item) => item.value)).toEqual(["anthropic"]);
	});
});
