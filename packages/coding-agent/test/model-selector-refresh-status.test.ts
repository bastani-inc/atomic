import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
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

type RefreshResult = Awaited<ReturnType<ModelRuntime["refresh"]>>;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}

function createSelector(refresh: ModelRuntime["refresh"]): ModelSelectorComponent {
	initTheme("dark");
	const runtime = {
		refresh,
		getError: () => undefined,
		getAvailableSnapshot: () => [model],
		getModel: () => model,
	} as unknown as ModelRuntime;
	return new ModelSelectorComponent(
		{ requestRender: () => {} } as unknown as TUI,
		model,
		{ setDefaultModelAndProvider: () => {} } as unknown as SettingsManager,
		runtime,
		[],
		() => {},
		() => {},
	);
}

async function renderedAfterWork(selector: ModelSelectorComponent): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt++) await Promise.resolve();
	return selector.render(100).join("\n");
}

afterEach(() => {
	vi.useRealTimers();
});

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

	it("keeps cached models and identifies a partial provider failure", async () => {
		const selector = createSelector(async () => ({
			aborted: false,
			errors: new Map([["configured", new Error("offline")]]),
		}));
		const rendered = await renderedAfterWork(selector);
		expect(rendered).toContain("cached-model");
		expect(rendered).toContain("Could not refresh configured; showing cached models.");
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
		expect(rendered).toContain("Could not refresh 2 model catalogs; showing cached models.");
	});

	it("stops waiting after the selector timeout even when refresh ignores cancellation", async () => {
		vi.useFakeTimers();
		const selector = createSelector(() => new Promise<never>(() => {}));
		await vi.advanceTimersByTimeAsync(15_000);
		vi.useRealTimers();
		const rendered = await renderedAfterWork(selector);
		expect(rendered).toContain("cached-model");
		expect(rendered).toContain("Model refresh timed out; showing cached models.");
	});

	it("replaces the refreshing status when refresh rejects", async () => {
		const selector = createSelector(async () => {
			throw new Error("engine unavailable");
		});
		await vi.waitFor(() => {
			const rendered = selector.render(100).join("\n");
			expect(rendered).toContain("cached-model");
			expect(rendered).toContain("Could not refresh model catalogs; showing cached models.");
			expect(rendered).not.toContain("Refreshing model catalogs");
		});
	});

	it("delegates network gating to the runtime instead of passing allowNetwork", async () => {
		let observed: Parameters<ModelRuntime["refresh"]>[0];
		const selector = createSelector(async (options) => {
			observed = options;
			return { aborted: false, errors: new Map() };
		});
		await renderedAfterWork(selector);
		expect(observed).toMatchObject({ signal: expect.any(AbortSignal) });
		expect(observed).not.toHaveProperty("allowNetwork");
		expect(observed).not.toHaveProperty("timeoutMs");
	});
});
