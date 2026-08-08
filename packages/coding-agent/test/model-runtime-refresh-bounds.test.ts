import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { POST_LOGOUT_AUTH_CHECK_TIMEOUT_MS } from "../src/core/model-refresh-timeout.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.useRealTimers();
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

	it("publishes the stored credential without awaiting post-login refresh work", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const refresh = vi.spyOn(runtime, "refresh").mockImplementation(() => new Promise<never>(() => {}));

		const outcome = await Promise.race([
			runtime
				.login("anthropic", "api_key", {
					prompt: async () => "secret",
					notify: () => {},
				})
				.then(() => "resolved" as const),
			new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 25)),
		]);

		expect(outcome).toBe("resolved");
		expect(refresh).not.toHaveBeenCalled();
		expect(runtime.getStoredCredentialType("anthropic")).toBe("api_key");
		expect(runtime.getAvailableSnapshot()).toEqual(
			expect.arrayContaining([expect.objectContaining({ provider: "anthropic" })]),
		);
	});

	it("reloads engine-owned credential metadata without an availability refresh", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: null,
			allowModelNetwork: false,
		});
		await credentials.modify("anthropic", async () => ({ type: "api_key", key: "external" }));
		const refresh = vi.spyOn(runtime, "refresh").mockImplementation(() => new Promise<never>(() => {}));

		await runtime.reloadCredentials({ refreshAvailability: false });

		expect(refresh).not.toHaveBeenCalled();
		expect(runtime.getStoredCredentialType("anthropic")).toBe("api_key");
		expect(runtime.getAvailableSnapshot()).toEqual(
			expect.arrayContaining([expect.objectContaining({ provider: "anthropic" })]),
		);
	});

	it("publishes logout without awaiting refresh or a cancellation-ignoring auth check", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const refresh = vi.spyOn(runtime, "refresh").mockImplementation(() => new Promise<never>(() => {}));
		vi.spyOn(runtime, "checkAuth").mockImplementation(() => new Promise<never>(() => {}));
		vi.useFakeTimers();

		const logout = runtime.logout("anthropic");
		await vi.advanceTimersByTimeAsync(POST_LOGOUT_AUTH_CHECK_TIMEOUT_MS);
		await logout;

		expect(refresh).not.toHaveBeenCalled();
		expect(runtime.getStoredCredentialType("anthropic")).toBeUndefined();
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({ configured: false });
		expect(runtime.getAvailableSnapshot()).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ provider: "anthropic" })]),
		);
	});

	it("does not let a pre-login availability refresh overwrite the persisted credential snapshot", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const originalList = credentials.list.bind(credentials);
		let releaseList!: () => void;
		const listReleased = new Promise<void>((resolve) => {
			releaseList = resolve;
		});
		let markListStarted!: () => void;
		const listStarted = new Promise<void>((resolve) => {
			markListStarted = resolve;
		});
		credentials.list = async () => {
			markListStarted();
			await listReleased;
			return originalList();
		};

		const staleRefresh = runtime.getAvailable();
		await listStarted;
		await runtime.login("anthropic", "api_key", {
			prompt: async () => "new-secret",
			notify: () => {},
		});
		releaseList();
		await staleRefresh;

		expect(runtime.getStoredCredentialType("anthropic")).toBe("api_key");
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
	});

	it("does not let a late post-logout auth probe erase a concurrent login", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "old" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});
		let markCheckStarted!: () => void;
		const checkStarted = new Promise<void>((resolve) => {
			markCheckStarted = resolve;
		});
		vi.spyOn(runtime, "checkAuth").mockImplementation(() => {
			markCheckStarted();
			return new Promise<never>(() => {});
		});
		vi.useFakeTimers();

		const logout = runtime.logout("anthropic");
		await checkStarted;
		await runtime.login("anthropic", "api_key", {
			prompt: async () => "new",
			notify: () => {},
		});
		await vi.advanceTimersByTimeAsync(POST_LOGOUT_AUTH_CHECK_TIMEOUT_MS);
		await logout;

		expect(runtime.getStoredCredentialType("anthropic")).toBe("api_key");
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
	});

	it("applies authoritative remaining environment auth from an isolated engine", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "frontend-copy" } }),
			modelsPath: null,
			allowModelNetwork: false,
		});

		runtime.applyExternalProviderAuthStatus("anthropic", {
			configured: true,
			source: "environment",
			label: "ANTHROPIC_API_KEY",
		});

		expect(runtime.getStoredCredentialType("anthropic")).toBeUndefined();
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({
			configured: true,
			source: "environment",
			label: "ANTHROPIC_API_KEY",
		});
	});
	it("reports provider-scoped availability failures in ModelsRefreshResult", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const internals = runtime as unknown as {
			models: {
				refresh(options: object): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
				getAvailable(providerId?: string, options?: object): Promise<readonly never[]>;
			};
		};
		vi.spyOn(internals.models, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		vi.spyOn(internals.models, "getAvailable").mockRejectedValue(new Error("availability failed"));
		const result = await runtime.refresh({ providers: ["broken-provider"], allowNetwork: false });
		expect(result.aborted).toBe(false);
		expect(result.errors.get("broken-provider")?.message).toBe("availability failed");
	});

	it("settles a provider-scoped availability pass as aborted", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const internals = runtime as unknown as {
			models: {
				refresh(options: object): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
				getAvailable(providerId?: string, options?: { signal?: AbortSignal }): Promise<readonly never[]>;
			};
		};
		vi.spyOn(internals.models, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
		vi.spyOn(internals.models, "getAvailable").mockImplementation(async (_providerId, options) => {
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
			);
			throw options?.signal?.reason ?? new Error("aborted");
		});
		const controller = new AbortController();
		const refresh = runtime.refresh({ providers: ["slow-provider"], signal: controller.signal, allowNetwork: false });
		controller.abort();
		const result = await refresh;
		expect(result.aborted).toBe(true);
		expect(result.errors.size).toBe(0);
	});
});
