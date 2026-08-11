import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

beforeEach(() => {
	// saveCredential refreshes the provider catalog; this test only exercises
	// local credential synchronization and must not depend on a live endpoint.
	vi.stubEnv("ATOMIC_OFFLINE", "1");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("ModelRuntime credential synchronization", () => {
	it("reports a committed credential when local synchronization fails", async () => {
		// Credential synchronization must stay local; saveCredential refreshes the catalog after persisting.
		vi.stubEnv("ATOMIC_OFFLINE", "1");
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

	test("does not leak the credential through enumeration or serialization", () => {
		// The non-enumerable descriptor on `credential` is the only thing keeping a
		// live secret out of JSON.stringify, console.log, and any structured error
		// reporter that walks own enumerable properties. Nothing else pinned it, so
		// a refactor of the constructor could silently make errors credential-bearing.
		const secret = { type: "api_key", key: "sk-do-not-log-me" } as const;
		const error = new CredentialSynchronizationError("anthropic", "saveCredential", secret, {});

		expect(error.credential).toBe(secret);
		expect(Object.propertyIsEnumerable.call(error, "credential")).toBe(false);
		expect(Object.keys(error)).not.toContain("credential");
		expect(JSON.stringify(error)).not.toContain("sk-do-not-log-me");
		expect(JSON.stringify({ error })).not.toContain("sk-do-not-log-me");
	});
});
