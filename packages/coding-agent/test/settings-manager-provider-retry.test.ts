import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager provider retry settings", () => {
	it("leaves provider maxRetries undefined by default", () => {
		const manager = SettingsManager.inMemory({});

		expect(manager.getProviderRetrySettings()).toEqual({
			timeoutMs: undefined,
			maxRetries: undefined,
			maxRetryDelayMs: 60000,
		});
	});

	it("honors explicitly configured provider maxRetries", () => {
		const manager = SettingsManager.inMemory({
			retry: {
				provider: {
					timeoutMs: 3600000,
					maxRetries: 5,
					maxRetryDelayMs: 30000,
				},
			},
		});

		expect(manager.getProviderRetrySettings()).toEqual({
			timeoutMs: 3600000,
			maxRetries: 5,
			maxRetryDelayMs: 30000,
		});
	});
});
