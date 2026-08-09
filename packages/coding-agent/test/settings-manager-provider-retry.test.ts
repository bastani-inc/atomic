import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

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

	it("preserves global provider retry fields when project settings override one field", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				retry: {
					provider: {
						timeoutMs: 30_000,
						maxRetryDelayMs: 45_000,
					},
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				retry: {
					provider: {
						maxRetries: 2,
					},
				},
			}),
		);

		const manager = SettingsManager.fromStorage(storage);

		expect(manager.getProviderRetrySettings()).toEqual({
			timeoutMs: 30_000,
			maxRetries: 2,
			maxRetryDelayMs: 45_000,
		});
	});
});
