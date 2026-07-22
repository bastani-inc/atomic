import assert from "node:assert/strict";
import { test } from "vitest";
import type { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { refreshCatalogsAfterTuiStartup } from "../src/modes/interactive/interactive-model-catalog-startup.ts";

interface FakeCalls {
	copilot: number;
	refreshOptions: Array<{ allowNetwork?: boolean }>;
	providerCounts: number[];
}

function fakeMode(overrides?: {
	copilotRejects?: boolean;
	refreshRejects?: boolean;
}): { mode: InteractiveModeBase; calls: FakeCalls } {
	const calls: FakeCalls = { copilot: 0, refreshOptions: [], providerCounts: [] };
	const mode = {
		refreshCopilotModelCatalog: async () => {
			calls.copilot++;
			if (overrides?.copilotRejects) throw new Error("copilot fetch failed");
		},
		session: {
			scopedModels: [],
			modelRegistry: {
				refresh: async (options: { allowNetwork?: boolean } = {}) => {
					calls.refreshOptions.push(options);
					if (overrides?.refreshRejects) throw new Error("network refresh failed");
					return { aborted: false, errors: new Map() };
				},
				getAvailable: () => [
					{ provider: "anthropic" },
					{ provider: "openai" },
					{ provider: "openai" },
				],
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

test("post-TUI startup refresh performs a network registry refresh for non-Copilot users", async () => {
	const { mode, calls } = fakeMode();
	await refreshCatalogsAfterTuiStartup(mode);
	assert.equal(calls.copilot, 1);
	assert.deepEqual(calls.refreshOptions, [{ allowNetwork: true }]);
	assert.deepEqual(calls.providerCounts, [2]);
});

test("registry refresh still runs when the Copilot catalog pass fails", async () => {
	const { mode, calls } = fakeMode({ copilotRejects: true });
	await refreshCatalogsAfterTuiStartup(mode);
	assert.deepEqual(calls.refreshOptions, [{ allowNetwork: true }]);
	assert.deepEqual(calls.providerCounts, [2]);
});

test("footer provider count updates even when the network refresh fails", async () => {
	const { mode, calls } = fakeMode({ refreshRejects: true });
	await refreshCatalogsAfterTuiStartup(mode);
	assert.deepEqual(calls.providerCounts, [2]);
});
