import { expect, it, vi } from "vitest";
import { applyCliRuntimeApiKey } from "../src/main-runtime-api-key.ts";

it("applies --api-key without a networked catalog refresh before reading available models", async () => {
	const calls: string[] = [];
	const modelRuntime = {
		setRuntimeApiKey: vi.fn(async (_providerId: string, _apiKey: string, options: { allowNetwork?: boolean }) => {
			calls.push(`set:${String(options.allowNetwork)}`);
		}),
		getAvailable: vi.fn(async () => {
			calls.push("available");
			return [];
		}),
	};

	await applyCliRuntimeApiKey(modelRuntime, "custom-provider", "runtime-secret");

	expect(modelRuntime.setRuntimeApiKey).toHaveBeenCalledWith("custom-provider", "runtime-secret", {
		allowNetwork: false,
	});
	expect(modelRuntime.getAvailable).toHaveBeenCalledOnce();
	expect(calls).toEqual(["set:false", "available"]);
});
