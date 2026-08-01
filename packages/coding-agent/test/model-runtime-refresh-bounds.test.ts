import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("model refresh timeout boundaries", () => {
	it("applies modelRefreshTimeoutMs only to the create-time refresh", async () => {
		let createSignal: AbortSignal | undefined;
		const refresh = vi.spyOn(ModelRuntime.prototype, "refresh").mockImplementation(async (options = {}) => {
			createSignal = options.signal;
			if (options.signal) {
				await new Promise<void>((resolve) =>
					options.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			}
			return { aborted: options.signal?.aborted ?? false, errors: new Map() };
		});

		await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: true,
			modelRefreshTimeoutMs: 5,
		});

		expect(createSignal).toBeInstanceOf(AbortSignal);
		expect(createSignal?.aborted).toBe(true);
		expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ signal: createSignal }));
	});

	it("treats a false offline flag as online", async () => {
		vi.stubEnv("ATOMIC_OFFLINE", "0");
		vi.stubEnv("PI_OFFLINE", "");
		let createSignal: AbortSignal | undefined;
		vi.spyOn(ModelRuntime.prototype, "refresh").mockImplementation(async (options = {}) => {
			createSignal = options.signal;
			return { aborted: false, errors: new Map() };
		});

		await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: true,
		});

		expect(createSignal).toBeInstanceOf(AbortSignal);
	});

	it("rebuilds the post-login snapshot without an unbounded network refresh", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const refresh = vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });

		await runtime.login("anthropic", "api_key", {
			prompt: async () => "secret",
			notify: () => {},
		});

		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
	});
});
