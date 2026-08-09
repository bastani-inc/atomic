import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelsError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import { type Args, parseArgs } from "../src/cli/args.ts";
import { checkProviderAuth, createAuthCheckModelRuntime, getProviderCredential } from "../src/cli/auth-check.ts";
import { AuthCommandError, parseAuthCommand } from "../src/cli/auth-command.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function args(overrides: Partial<Args> = {}): Args {
	return { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], ...overrides };
}

function runtimeStub(options: {
	provider?: boolean;
	auth?: "api_key" | "oauth";
	error?: string;
	requestAuth?: boolean;
	onGetAuth?: () => void;
}): ModelRuntime {
	return {
		getError: () => options.error,
		getProvider: () => (options.provider === false ? undefined : { id: "openai" }),
		checkAuth: async () => (options.auth ? { type: options.auth } : undefined),
		getAuth: async () => {
			options.onGetAuth?.();
			return options.requestAuth === false ? undefined : { auth: {} };
		},
	} as unknown as ModelRuntime;
}

async function createRuntime(credentials: AuthStorage | ReadOnlyAuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}

describe("auth check command", () => {
	test("reports a configured provider as ready", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--provider", "openai"]), runtime)).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
	});

	test("ignores defaulted parser fields that are not auth-check options", async () => {
		await expect(
			checkProviderAuth(args({ provider: "openai", verbose: false }), runtimeStub({ auth: "api_key" })),
		).resolves.toEqual({
			status: "ready",
			provider: "openai",
			authType: "api_key",
		});
	});

	test("resolves the provider from --model", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory({ openai: { type: "api_key", key: "test-key" } }));

		await expect(checkProviderAuth(parseArgs(["--model", "openai/gpt-5.5"]), runtime)).resolves.toMatchObject({
			status: "ready",
			provider: "openai",
		});
	});

	test("resolves request auth only when a check may refresh", async () => {
		let calls = 0;
		const runtime = runtimeStub({
			auth: "oauth",
			requestAuth: false,
			onGetAuth: () => {
				calls++;
			},
		});

		await expect(checkProviderAuth(args({ provider: "openai" }), runtime, { refresh: false })).resolves.toMatchObject(
			{
				status: "ready",
			},
		);
		expect(calls).toBe(0);

		await expect(checkProviderAuth(args({ provider: "openai" }), runtime, { refresh: true })).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credentials_not_configured",
		});
		expect(calls).toBe(1);
	});

	test("selects a stored credential provider for an unqualified shared model", async () => {
		const credentials = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } });
		const runtime = await createAuthCheckModelRuntime(credentials);

		await expect(
			checkProviderAuth(parseArgs(["--model", "claude-opus-4-5"]), runtime, { refresh: false }),
		).resolves.toMatchObject({ status: "ready", provider: "anthropic" });
	});

	test("reports an expired OAuth credential as not ready without refreshing", async () => {
		const credentials = AuthStorage.inMemory({
			openai: { type: "oauth", access: "expired-access", refresh: "refresh-token", expires: 1 },
		});
		const options = { refresh: false, credentials };

		await expect(
			checkProviderAuth(args({ provider: "openai" }), runtimeStub({ auth: "oauth" }), options),
		).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credential_expired",
		});
	});

	test("does not export an OAuth token inside its safety window without refresh", async () => {
		const credentials = AuthStorage.inMemory({
			openai: {
				type: "oauth",
				access: "short-lived-access",
				refresh: "refresh-token",
				expires: Date.now() + 60_000,
			},
		});

		await expect(
			getProviderCredential("openai", runtimeStub({}), credentials, { refresh: false }),
		).resolves.toBeUndefined();
	});

	test("reports an OAuth refresh failure as not ready", async () => {
		const runtime = {
			getError: () => undefined,
			getProvider: () => ({ id: "openai" }),
			checkAuth: async () => ({ type: "oauth" as const }),
			getAuth: async () => {
				throw new ModelsError("oauth", "OAuth refresh failed for openai");
			},
		} as unknown as ModelRuntime;

		await expect(checkProviderAuth(args({ provider: "openai" }), runtime, { refresh: true })).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credential_not_available",
		});
	});
	test("reports a provider with no credential as not ready", async () => {
		await expect(checkProviderAuth(args({ provider: "openai" }), runtimeStub({}))).resolves.toEqual({
			status: "not_ready",
			provider: "openai",
			reason: "credentials_not_configured",
		});
	});

	test("reports an unknown provider as not ready", async () => {
		await expect(
			checkProviderAuth(args({ provider: "not-installed" }), runtimeStub({ provider: false })),
		).resolves.toEqual({
			status: "not_ready",
			provider: "not-installed",
			reason: "provider_not_found",
		});
	});

	test("rejects an unknown model before it can choose a provider", async () => {
		const runtime = await createRuntime(AuthStorage.inMemory());

		await expect(
			checkProviderAuth(parseArgs(["--model", "does-not-exist-auth-check"]), runtime),
		).rejects.toBeInstanceOf(AuthCommandError);
	});

	test("parses check-only options before normal argument parsing", () => {
		expect(parseAuthCommand(["auth", "check", "--provider", "openai"])).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(parseAuthCommand(["auth", "check", "--json", "--no-refresh", "--provider", "openai"])).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: true,
			credentials: false,
			noRefresh: true,
		});
		expect(parseAuthCommand(["auth", "check", "--credentials", "--provider", "openai"])).toEqual({
			kind: "check",
			args: ["--provider", "openai"],
			json: false,
			credentials: true,
			noRefresh: false,
		});
		expect(parseAuthCommand(["auth", "check", "--provider", "openai", "--", "--credentials"])).toEqual({
			kind: "check",
			args: ["--provider", "openai", "--", "--credentials"],
			json: false,
			credentials: false,
			noRefresh: false,
		});
		expect(() => parseAuthCommand(["auth", "print-api-key", "--credentials"])).toThrow(
			"--credentials is only supported by auth check",
		);
	});

	test("does not create an auth file or its parent directory for a no-refresh read", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-auth-check-"));
		tempDirs.push(root);
		const authPath = join(root, "agent", "auth.json");
		const credentials = new ReadOnlyAuthStorage(authPath);

		await expect(credentials.list()).resolves.toEqual([]);
		expect(existsSync(authPath)).toBe(false);
		expect(existsSync(join(root, "agent"))).toBe(false);
	});

	test("resolves command-backed API keys in a no-refresh read", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-auth-check-"));
		tempDirs.push(root);
		const authPath = join(root, "auth.json");
		writeFileSync(authPath, JSON.stringify({ anthropic: { type: "api_key", key: "!echo command-backed-key" } }));

		const expected = { type: "api_key", key: "command-backed-key" };
		await expect(new ReadOnlyAuthStorage(authPath).read("anthropic")).resolves.toEqual(expected);
		await expect(AuthStorage.create(authPath).read("anthropic")).resolves.toEqual(expected);
	});

	test("fails closed on malformed auth.json while normal storage retains an empty snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-auth-check-"));
		tempDirs.push(root);
		const authPath = join(root, "auth.json");
		writeFileSync(authPath, "{");

		await expect(new ReadOnlyAuthStorage(authPath).list()).rejects.toThrow("Failed to read auth.json");
		await expect(AuthStorage.create(authPath).list()).resolves.toEqual([]);
	});

	test("creates a static auth-check runtime without a catalog refresh", async () => {
		const runtime = await createAuthCheckModelRuntime(AuthStorage.inMemory());
		expect(runtime.getProvider("openai")).toBeDefined();
	});
});
