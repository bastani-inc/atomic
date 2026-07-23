import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage, type AuthStorageBackend, FileAuthStorageBackend } from "../src/core/auth-storage.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

/**
 * Backend whose every access throws — used to simulate a credential-store load
 * failure (e.g. ELOCKED under concurrent auth.json access) so a *fresh*
 * AuthStorage ends up with an empty in-memory store and a recorded loadError
 * (issue #1431).
 */
class ThrowingAuthStorageBackend implements AuthStorageBackend {
	constructor(private readonly error: Error) {}
	read(): string | undefined {
		throw this.error;
	}
	withLock<T>(): T {
		throw this.error;
	}
	async withLockAsync<T>(): Promise<T> {
		throw this.error;
	}
}
describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	function toShPath(value: string): string {
		let escaped = "";
		for (const char of value.replace(/\\/g, "/")) {
			if (char === '"' || char === "\\" || char === "$" || char === "`") {
				escaped += `\\${char}`;
			} else {
				escaped += char;
			}
		}
		return escaped;
	}

	describe("API key resolution", () => {
		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			// Keeps previous in-memory data on reload failure
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
		test("getLoadError is null after a successful load", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.getLoadError()).toBeNull();
		});
		test("a fresh-load failure is surfaced via getLoadError and leaves credentials empty", () => {
			const loadError = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
			const storage = AuthStorage.fromStorage(new ThrowingAuthStorageBackend(loadError));

			// The failure is preserved, not swallowed: an empty store is NOT
			// authoritative — the provider is not "absent", the store could not be read.
			expect(storage.getLoadError()).toBe(loadError);
			expect(storage.hasAuth("some-locked-provider")).toBe(false);
			expect(storage.list()).toEqual([]);
		});
		test("getLoadError clears after a subsequent successful reload", () => {
			writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
			authStorage = AuthStorage.create(authJsonPath);
			expect(authStorage.getLoadError()).toBeNull();

			// Corrupt the file and reload -> load error recorded.
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");
			authStorage.reload();
			expect(authStorage.getLoadError()).toBeInstanceOf(Error);

			// Repair and reload -> error cleared.
			writeAuthJson({ anthropic: { type: "api_key", key: "anthropic-key" } });
			authStorage.reload();
			expect(authStorage.getLoadError()).toBeNull();
		});
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});
		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "!echo stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
});
});
