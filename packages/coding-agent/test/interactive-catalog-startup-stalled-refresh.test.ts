import type { ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "../src/core/model-refresh-timeout.ts";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { refreshCatalogsAfterTuiStartup } from "../src/modes/interactive/interactive-model-catalog-startup.ts";
import { refreshModelCatalogs } from "../src/modes/interactive/model-catalog-refresh.ts";

interface Harness {
	mode: InteractiveModeBase;
	modelRuntime: {
		refresh: ReturnType<typeof vi.fn>;
		isNetworkRefreshEnabled: () => boolean;
		getCatalogInputsGeneration: () => number;
	};
	refreshSignals: AbortSignal[];
	refreshCalls: () => number;
	providerCounts: number[];
}

/** A runtime whose network refresh never settles, which is what a stalled registry looks like. */
function createStalledHarness(): Harness {
	const refreshSignals: AbortSignal[] = [];
	const refresh = vi.fn((options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> => {
		if (options.signal) refreshSignals.push(options.signal);
		return new Promise<ModelsRefreshResult>(() => {});
	});
	const modelRuntime = {
		refresh,
		isNetworkRefreshEnabled: () => true,
		getCatalogInputsGeneration: () => 0,
		getAvailableSnapshot: () => [{ provider: "anthropic" }, { provider: "openai" }],
	};
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
		refreshSignals,
		refreshCalls: () => refresh.mock.calls.length,
		providerCounts,
	};
}

describe("startup catalog refresh against a stalled registry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("bounds its join so a later selector escapes a stalled pass", async () => {
		const harness = createStalledHarness();
		const startup = refreshCatalogsAfterTuiStartup(harness.mode);
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.refreshCalls()).toBe(1);

		// A selector opened during startup joins the same pass, times out, and
		// releases only its own waiter.
		const selector = new AbortController();
		const selectorRefresh = refreshModelCatalogs(harness.modelRuntime, { signal: selector.signal });
		expect(harness.refreshCalls()).toBe(1);
		selector.abort();
		await expect(selectorRefresh).rejects.toMatchObject({ name: "AbortError" });
		expect(harness.refreshSignals[0]?.aborted).toBe(false);

		// While startup is still legitimately waiting, a retry shares its pass.
		const rejoin = new AbortController();
		const rejoined = refreshModelCatalogs(harness.modelRuntime, { signal: rejoin.signal });
		expect(harness.refreshCalls()).toBe(1);
		rejoin.abort();
		await expect(rejoined).rejects.toMatchObject({ name: "AbortError" });

		// Once startup's own deadline passes, the last waiter leaves and the stalled
		// pass is cancelled instead of being handed to every later caller.
		await vi.advanceTimersByTimeAsync(INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS);
		await startup;
		expect(harness.refreshSignals[0]?.aborted).toBe(true);
		expect(harness.providerCounts).toEqual([2]);

		const retry = new AbortController();
		const retried = refreshModelCatalogs(harness.modelRuntime, { signal: retry.signal });
		expect(harness.refreshCalls()).toBe(2);
		retry.abort();
		await expect(retried).rejects.toMatchObject({ name: "AbortError" });
	});

	it("leaves no timer pending once the startup refresh settles", async () => {
		const harness = createStalledHarness();
		const startup = refreshCatalogsAfterTuiStartup(harness.mode);
		await vi.advanceTimersByTimeAsync(INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS);
		await startup;
		expect(vi.getTimerCount()).toBe(0);
	});
});
