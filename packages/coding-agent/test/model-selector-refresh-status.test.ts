import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ENV_OFFLINE } from "../src/config.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const model = {
	id: "cached-model",
	name: "Cached Model",
	api: "openai-completions",
	provider: "configured",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
} as Model<Api>;

type RefreshResult = Awaited<ReturnType<ModelRegistry["refresh"]>>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}

function createSelector(refresh: ModelRegistry["refresh"]): ModelSelectorComponent {
	initTheme("dark");
	const registry = {
		refresh,
		getError: () => undefined,
		getAvailable: async () => [model],
		find: () => model,
	} as unknown as ModelRegistry;
	return new ModelSelectorComponent(
		{ requestRender: () => {} } as unknown as TUI,
		model,
		{ setDefaultModelAndProvider: () => {} } as unknown as SettingsManager,
		registry,
		[],
		() => {},
		() => {},
	);
}

async function renderedAfterWork(selector: ModelSelectorComponent): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt++) await Promise.resolve();
	return selector.render(100).join("\n");
}

describe("model selector catalog refresh status", () => {
	it("renders the stale snapshot immediately and then concise success", async () => {
		const refresh = deferred<RefreshResult>();
		const selector = createSelector(() => refresh.promise);
		const stale = await renderedAfterWork(selector);
		expect(stale).toContain("cached-model");
		expect(stale).toContain("Refreshing model catalogs");

		refresh.resolve({ aborted: false, errors: new Map() });
		const refreshed = await renderedAfterWork(selector);
		expect(refreshed).toContain("Model catalogs refreshed.");
	});

	it("keeps available models and identifies a partial provider failure", async () => {
		const selector = createSelector(async () => ({
			aborted: false,
			errors: new Map([["configured", new Error("offline")]]),
		}));
		const rendered = await renderedAfterWork(selector);
		expect(rendered).toContain("cached-model");
		expect(rendered).toContain("Could not refresh configured; showing available models.");
	});

	it("summarizes multiple provider errors", async () => {
		const selector = createSelector(async () => ({
			aborted: false,
			errors: new Map([
				["first", new Error("offline")],
				["second", new Error("unauthorized")],
			]),
		}));
		const rendered = await renderedAfterWork(selector);
		expect(rendered).toContain("Could not refresh 2 model catalogs; showing available models.");
	});

	it("reports timeout while retaining cached models", async () => {
		const selector = createSelector(async () => ({ aborted: true, errors: new Map() }));
		const rendered = await renderedAfterWork(selector);
		expect(rendered).toContain("cached-model");
		expect(rendered).toContain("Model refresh timed out; showing cached models.");
	});

	it("keeps selector refreshes cache-only in offline mode", async () => {
		const previous = process.env[ENV_OFFLINE];
		process.env[ENV_OFFLINE] = "1";
		let observed: Parameters<ModelRegistry["refresh"]>[0];
		try {
			const selector = createSelector(async (options) => {
				observed = options;
				return { aborted: false, errors: new Map() };
			});
			await renderedAfterWork(selector);
			expect(observed).toMatchObject({ allowNetwork: false, timeoutMs: 15_000 });
		} finally {
			if (previous === undefined) delete process.env[ENV_OFFLINE];
			else process.env[ENV_OFFLINE] = previous;
		}
	});
});
