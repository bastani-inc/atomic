import assert from "node:assert/strict";
import { test } from "vitest";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { refreshCatalogsAfterTuiStartup } from "../src/modes/interactive/interactive-model-catalog-startup.ts";

interface FakeCalls {
	refreshOptions: Array<{ allowNetwork?: boolean }>;
	providerCounts: number[];
}

function fakeMode(overrides?: { refreshRejects?: boolean }): { mode: InteractiveModeBase; calls: FakeCalls } {
	const calls: FakeCalls = { refreshOptions: [], providerCounts: [] };
	const mode = {
		session: {
			scopedModels: [],
			modelRuntime: {
				refresh: async (options: { allowNetwork?: boolean } = {}) => {
					calls.refreshOptions.push(options);
					if (overrides?.refreshRejects) throw new Error("network refresh failed");
					return { aborted: false, errors: new Map() };
				},
				getAvailableSnapshot: () => [{ provider: "anthropic" }, { provider: "openai" }, { provider: "openai" }],
			},
		},
		footerDataProvider: {
			setAvailableProviderCount: (count: number) => {
				calls.providerCounts.push(count);
			},
		},
	} as unknown as InteractiveModeBase;
	return { mode, calls };
}

test("post-TUI startup refresh performs a network registry refresh", async () => {
	const { mode, calls } = fakeMode();
	await refreshCatalogsAfterTuiStartup(mode);
	assert.deepEqual(calls.refreshOptions, [{ allowNetwork: true }]);
	assert.deepEqual(calls.providerCounts, [2]);
});

test("footer provider count updates even when the network refresh fails", async () => {
	const { mode, calls } = fakeMode({ refreshRejects: true });
	await refreshCatalogsAfterTuiStartup(mode);
	assert.deepEqual(calls.providerCounts, [2]);
});
