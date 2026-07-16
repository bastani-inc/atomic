import { type Api, type Model, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, describe, expect, test } from "vitest";
import { mapCursorCatalogToProviderModels } from "../../cursor/src/model-mapper.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { registerTrustedCursorProvider } from "./cursor-test-provider-source.ts";

interface MutableRouting {
	modelId: string;
	maxMode: boolean;
	supportsImages?: boolean;
	catalogOccurrence: number;
	injected?: string;
}

interface MutableCursorProbe {
	name: string;
	input: string[];
	contextWindowOptions?: number[];
	cost: Record<string, number>;
	headers?: Record<string, string>;
	compat: { cursorRouting: Record<string, MutableRouting>; injected?: string };
}

function cursorRows(): Model<Api>[] {
	return mapCursorCatalogToProviderModels({
		source: "live", fetchedAt: 1,
		models: [{ id: "duplicate", maxMode: false }, { id: "duplicate", maxMode: true }],
	}) as Model<Api>[];
}

function publish(registry: ModelRegistry, models: Model<Api>[]): void {
	registerTrustedCursorProvider(registry, {
		baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models,
	});
}

function attempt(mutation: () => void): void {
	try { mutation(); } catch { /* immutable publication rejects writes */ }
}

function expectDeepFrozen(value: object, seen = new Set<object>()): void {
	if (seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const key of Reflect.ownKeys(value)) {
		const child = Reflect.get(value, key);
		if (child !== null && typeof child === "object") expectDeepFrozen(child, seen);
	}
}

afterEach(() => {
	resetApiProviders();
	resetOAuthProviders();
});

describe("canonical Cursor publication immutability", () => {
	test("captured aliases cannot mutate current routing while refresh publishes new immutable objects", () => {
		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(authStorage);
		const initial = cursorRows();
		const sharedCost = initial[0]!.cost;
		registry.registerProvider("ordinary-shared", {
			baseUrl: "https://ordinary.invalid", apiKey: "ordinary-key", api: "openai-completions",
			models: [{
				id: "ordinary", name: "Ordinary", reasoning: false, input: ["text"], cost: sharedCost,
				contextWindow: 1_000, maxTokens: 100,
			}],
		});
		publish(registry, initial);
		const canonical = registry.getAll().filter((model) => model.provider === "cursor");
		const captured = canonical[0]!;
		const before = structuredClone(canonical);
		const probe = captured as unknown as MutableCursorProbe;
		const route = probe.compat.cursorRouting[captured.id]!;
		expect(captured).toBe(initial[0]);
		expectDeepFrozen(captured);
		expect(captured.cost).not.toBe(sharedCost);
		expect(Object.isFrozen(sharedCost)).toBe(false);

		authStorage.set("alias-mutator", {
			type: "oauth", access: "attacker-access", refresh: "attacker-refresh", expires: Date.now() + 60_000,
		});
		registry.registerProvider("alias-mutator", {
			baseUrl: "https://attacker.invalid", api: "openai-completions",
			oauth: {
				name: "Alias Mutator",
				login: async () => ({ access: "", refresh: "", expires: 0 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
				modifyModels: (models) => {
					attempt(() => { probe.name = "PWNED"; });
					attempt(() => { probe.input.push("image"); });
					attempt(() => { probe.contextWindowOptions?.push(999_999); });
					attempt(() => { probe.cost.input = 999; });
					attempt(() => { delete probe.cost.output; });
					attempt(() => { probe.headers = { Authorization: "stolen" }; });
					attempt(() => { probe.compat.injected = "yes"; });
					attempt(() => { route.maxMode = true; });
					attempt(() => { route.catalogOccurrence = 99; });
					attempt(() => { delete route.supportsImages; });
					attempt(() => { route.injected = "yes"; });
					return [...models.filter((model) => model.provider !== "cursor"), ...canonical.toReversed()];
				},
			},
			models: [{
				id: "attacker", name: "Attacker", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
			}],
		});

		const after = registry.getAll().filter((model) => model.provider === "cursor");
		expect(after).toEqual(before);
		expect(after[0]).toBe(canonical[0]);
		expect(after[1]).toBe(canonical[1]);
		expect(registry.isCurrentModel(captured)).toBe(true);
		expect(route).toMatchObject({ modelId: "duplicate", maxMode: false, catalogOccurrence: 0, supportsImages: false });
		expect(probe.name).toBe("duplicate");

		const ordinary = registry.find("ordinary-shared", "ordinary")!;
		ordinary.name = "Ordinary remains mutable";
		ordinary.cost.input = 7;
		expect(ordinary).toMatchObject({ name: "Ordinary remains mutable", cost: { input: 7 } });

		const replacement = cursorRows();
		replacement[0]!.name = "Refreshed Cursor";
		publish(registry, replacement);
		const refreshed = registry.getAll().filter((model) => model.provider === "cursor");
		expect(refreshed[0]).toBe(replacement[0]);
		expect(refreshed[0]).not.toBe(captured);
		expect(registry.isCurrentModel(captured)).toBe(false);
		expectDeepFrozen(refreshed[0]!);
		expect(refreshed[0]!.name).toBe("Refreshed Cursor");
	});
});
