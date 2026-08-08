import type { AuthOperationOptions, CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";

describe("RuntimeCredentials", () => {
	test("runtime overrides mask stored credentials without persisting", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);

		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });

		credentials.removeRuntimeApiKey("anthropic");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });
	});

	test("enumeration merges overrides without exposing keys", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
		});
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		credentials.setRuntimeApiKey("openai", "other-runtime-key");

		expect(await credentials.list()).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
	});

	test("delete clears both the override and persisted credential", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		await credentials.delete("anthropic");

		expect(await credentials.read("anthropic")).toBeUndefined();
		expect(await credentials.list()).toEqual([]);
	});
	test("forwards the identical auth operation options to every backing-store operation", async () => {
		const options: AuthOperationOptions = { signal: new AbortController().signal };
		const store: CredentialStore = {
			read: vi.fn(async () => undefined),
			list: vi.fn(async () => []),
			modify: vi.fn(async (_providerId, fn) => fn(undefined)),
			delete: vi.fn(async () => {}),
		};
		const credentials = new RuntimeCredentials(store);

		await credentials.read("provider", options);
		await credentials.list(options);
		const modify = async () => undefined;
		await credentials.modify("provider", modify, options);
		await credentials.delete("provider", options);

		expect(store.read).toHaveBeenCalledWith("provider", options);
		expect(store.list).toHaveBeenCalledWith(options);
		expect(store.modify).toHaveBeenCalledWith("provider", modify, options);
		expect(store.delete).toHaveBeenCalledWith("provider", options);
	});
});
