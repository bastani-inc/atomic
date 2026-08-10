import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("ModelRuntime credential synchronization", () => {
	it("reports a committed credential when local synchronization fails", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const credential = { type: "api_key" as const, key: "persisted-key" };
		const internals = runtime as unknown as {
			models: { getAvailable(providerId?: string, options?: object): Promise<readonly never[]> };
		};
		vi.spyOn(internals.models, "getAvailable").mockRejectedValue(new Error("availability sync failed"));
		const outcome = runtime.saveCredential("anthropic", credential);
		await expect(outcome).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "anthropic",
			operation: "saveCredential",
			credential,
			cause: { message: "availability sync failed" },
		});
		await expect(outcome).rejects.toBeInstanceOf(CredentialSynchronizationError);
		expect(await credentials.read("anthropic")).toEqual(credential);
	});

	it("keeps a credential save failure distinct from synchronization failure", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const saveFailure = new Error("credential write failed");
		vi.spyOn(credentials, "modify").mockRejectedValue(saveFailure);
		const refresh = vi.spyOn(runtime, "refresh");

		await expect(runtime.saveCredential("anthropic", { type: "api_key", key: "not-written" })).rejects.toBe(
			saveFailure,
		);
		await expect(
			runtime.saveCredential("anthropic", { type: "api_key", key: "not-written" }),
		).rejects.not.toBeInstanceOf(CredentialSynchronizationError);
		expect(refresh).not.toHaveBeenCalled();
		expect(await credentials.read("anthropic")).toBeUndefined();
	});
});
