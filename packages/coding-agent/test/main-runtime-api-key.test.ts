import { expect, it, vi } from "vitest";
import { applyCliRuntimeApiKey } from "../src/main-runtime-api-key.ts";

it("applies --api-key with one cancellation signal before reading available models", async () => {
	const calls: string[] = [];
	const controller = new AbortController();
	const signal = controller.signal;
	const modelRuntime = {
		setRuntimeApiKey: vi.fn(async () => calls.push("set")),
		refresh: vi.fn(
			async (refreshOptions: { allowNetwork?: boolean; providers?: readonly string[]; signal?: AbortSignal }) => {
				calls.push(
					`refresh:${String(refreshOptions.allowNetwork)}:${refreshOptions.providers?.join(",") ?? "all"}`,
				);
				return { aborted: false, errors: new Map<string, Error>() };
			},
		),
		getAvailable: vi.fn(async () => {
			calls.push("available");
			return [];
		}),
	};

	await applyCliRuntimeApiKey(modelRuntime, "custom-provider", "runtime-secret", signal);

	const authOptions = modelRuntime.setRuntimeApiKey.mock.calls[0]?.[2];
	expect(authOptions).toEqual({ signal });
	expect(authOptions?.signal).toBe(signal);
	expect(modelRuntime.refresh).toHaveBeenCalledWith({
		providers: ["custom-provider"],
		allowNetwork: false,
		signal,
	});
	expect(modelRuntime.refresh.mock.calls[0]?.[0]?.signal).toBe(signal);
	expect(modelRuntime.getAvailable).toHaveBeenCalledOnce();
	expect(calls).toEqual(["set", "refresh:false:custom-provider", "available"]);
});
