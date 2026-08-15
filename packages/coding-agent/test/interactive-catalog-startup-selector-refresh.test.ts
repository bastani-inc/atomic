import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { refreshCatalogsAfterTuiStartup } from "../src/modes/interactive/interactive-model-catalog-startup.ts";
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

interface Harness {
	mode: InteractiveModeBase;
	modelRuntime: ModelRuntime;
	refreshOptions: ModelsRefreshOptions[];
	refreshCalls: () => number;
	resolveRefresh: () => void;
	providerCounts: number[];
}

/**
 * One runtime behind both callers, with the network policy an omitted
 * `allowNetwork` resolves to — which is what startup and the selector must agree
 * on for their two spellings to share a pass.
 */
function createHarness(networkEnabled = true): Harness {
	initTheme("dark");
	const refreshOptions: ModelsRefreshOptions[] = [];
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const refresh = vi.fn(async (options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> => {
		refreshOptions.push(options);
		await pending;
		return { aborted: false, errors: new Map() };
	});
	const modelRuntime = {
		refresh,
		isNetworkRefreshEnabled: () => networkEnabled,
		getCredentialGeneration: () => 0,
		getError: () => undefined,
		getAvailableSnapshot: () => [model],
		getModel: () => model,
	} as unknown as ModelRuntime;
	const providerCounts: number[] = [];
	const mode = {
		session: { scopedModels: [], modelRuntime },
		footerDataProvider: {
			setAvailableProviderCount: (count: number) => {
				providerCounts.push(count);
			},
		},
	} as unknown as InteractiveModeBase;
	return {
		mode,
		modelRuntime,
		refreshOptions,
		refreshCalls: () => refresh.mock.calls.length,
		resolveRefresh: release,
		providerCounts,
	};
}

function openSelector(modelRuntime: ModelRuntime): ModelSelectorComponent {
	return new ModelSelectorComponent(
		{ requestRender: () => {} } as unknown as TUI,
		model,
		{ setDefaultModelAndProvider: () => {} } as unknown as SettingsManager,
		modelRuntime,
		[],
		() => {},
		() => {},
	);
}

async function settleMicrotasks(): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) await Promise.resolve();
}

describe("startup and /model selector catalog refresh", () => {
	it("answers a selector opened during startup with the startup pass", async () => {
		const harness = createHarness();
		const startup = refreshCatalogsAfterTuiStartup(harness.mode);
		const selector = openSelector(harness.modelRuntime);
		await settleMicrotasks();

		expect(harness.refreshCalls()).toBe(1);
		expect(harness.refreshOptions[0]?.allowNetwork).toBe(true);

		harness.resolveRefresh();
		await startup;
		await settleMicrotasks();
		expect(harness.providerCounts).toEqual([1]);
		expect(selector.render(100).join("\n")).toContain("Model catalogs refreshed.");
		expect(harness.refreshCalls()).toBe(1);
	});

	it("answers startup with the pass an already-open selector started", async () => {
		const harness = createHarness();
		const selector = openSelector(harness.modelRuntime);
		await settleMicrotasks();
		expect(harness.refreshCalls()).toBe(1);

		const startup = refreshCatalogsAfterTuiStartup(harness.mode);
		await settleMicrotasks();
		expect(harness.refreshCalls()).toBe(1);

		harness.resolveRefresh();
		await startup;
		await settleMicrotasks();
		expect(harness.providerCounts).toEqual([1]);
		expect(selector.render(100).join("\n")).toContain("Model catalogs refreshed.");
	});

	it("keeps a forced network startup apart from a cache-only runtime's selector", async () => {
		const harness = createHarness(false);
		const startup = refreshCatalogsAfterTuiStartup(harness.mode);
		openSelector(harness.modelRuntime);
		await settleMicrotasks();

		// The selector's omitted option resolves to `false` here, which is different
		// work from the network pass startup asked for, so it must not be shared.
		expect(harness.refreshCalls()).toBe(2);
		expect(harness.refreshOptions.map((options) => options.allowNetwork)).toEqual([true, undefined]);

		harness.resolveRefresh();
		await startup;
	});
});
