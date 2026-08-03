import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS } from "../src/core/model-refresh-timeout.ts";
import type { AtomicOAuthLoginCallbacks } from "../src/core/oauth-login.ts";
import { loginIsolatedOAuthProvider } from "../src/modes/interactive-engine/isolated-auth.ts";
import { RemoteModelCatalog } from "../src/modes/interactive-engine/remote-model-catalog.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import type { RpcPendingExtensionRequests } from "../src/modes/rpc/rpc-extension-ui.ts";
import { dispatchRpcOAuthRequest } from "../src/modes/rpc/rpc-oauth-client.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const createRuntime = (async () => {
	throw new Error("not used");
}) as CreateAgentSessionRuntimeFactory;
const harnesses: Harness[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

async function createRuntimeHarness() {
	const harness = await createHarness({ withConfiguredAuth: false });
	harnesses.push(harness);
	harness.session.modelRuntime.registerProvider("corp-oauth", {
		baseUrl: "https://provider.test/v1",
		api: "openai-completions",
		oauth: {
			name: "Corp OAuth",
			login: async () => ({ access: "new-secret", refresh: "new-refresh", expires: Date.now() + 60_000 }),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		},
		models: [
			{
				id: "corp-model",
				name: "Corp Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
	await harness.authStorage.modify("corp-oauth", async () => ({ type: "api_key", key: "previous" }));
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		createRuntime,
	);
	const handler = createRpcCommandHandler({
		runtimeHost: runtime,
		getSession: () => harness.session,
		rebindSession: async () => {},
		pendingExtensionRequests: new Map(),
		output: () => {},
	});
	return { harness, handler };
}

describe("RPC OAuth descriptors", () => {
	it("serializes provider metadata without OAuth secrets or function-valued fields", async () => {
		const { handler } = await createRuntimeHarness();
		const response = await handler({ id: "models", type: "get_available_models" });

		expect(response).toMatchObject({
			success: true,
			data: { oauthProviders: expect.arrayContaining([{ id: "corp-oauth", name: "Corp OAuth" }]) },
		});
		const serialized = JSON.stringify(response);
		expect(serialized).not.toContain("new-secret");
		expect(serialized).not.toContain("refreshToken");
		expect(serialized).not.toContain("getApiKey");
	});
});

describe("isolated OAuth frontend transport", () => {
	it("exposes transported OAuth descriptors through the frontend runtime", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const catalog = new RemoteModelCatalog({} as never);
		catalog.apply({
			models: [],
			scopedModels: [],
			customAuthProviders: [],
			oauthProviders: [{ id: "corp-oauth", name: "Corp OAuth", loginLabel: "Sign in", usesCallbackServer: true }],
		});
		catalog.patch(harness.session);

		expect(harness.session.modelRuntime.getOAuthProviderMetadata()).toEqual([
			{ id: "corp-oauth", name: "Corp OAuth", loginLabel: "Sign in", usesCallbackServer: true },
		]);
	});

	it("transports the frontend refresh deadline to the isolated engine", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const refreshModels = vi.fn(() => new Promise<never>(() => {}));
		const catalog = new RemoteModelCatalog({ refreshModels } as never);
		catalog.patch(harness.session);
		const controller = new AbortController();

		const refresh = harness.session.modelRuntime.refresh({ signal: controller.signal });
		controller.abort();

		await expect(refresh).resolves.toEqual({ aborted: true, errors: new Map() });
		expect(refreshModels).toHaveBeenCalledWith({
			timeoutMs: INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS,
			force: undefined,
			allowNetwork: undefined,
		});
	});

	it("dispatches correlated OAuth callbacks in the frontend", async () => {
		const calls: string[] = [];
		const responses: object[] = [];
		const callbacks: AtomicOAuthLoginCallbacks = {
			onAuth: () => calls.push("auth"),
			onDeviceCode: () => calls.push("device"),
			onProgress: () => calls.push("progress"),
			onInfo: () => calls.push("info"),
			onPrompt: async () => "prompt-value",
			onSelect: async () => "selected-value",
			onManualCodeInput: async () => "manual-value",
			onManualCodeCancel: () => calls.push("manual-cancel"),
		};
		const respond = async (response: object) => {
			responses.push(response);
		};
		const requests = [
			{
				type: "extension_ui_request",
				id: "1",
				method: "oauth_auth",
				provider: "corp",
				loginId: "login-a",
				info: { url: "https://login" },
			},
			{
				type: "extension_ui_request",
				id: "2",
				method: "oauth_device_code",
				provider: "corp",
				loginId: "login-a",
				info: { userCode: "A", verificationUri: "https://device" },
			},
			{
				type: "extension_ui_request",
				id: "3",
				method: "oauth_progress",
				provider: "corp",
				loginId: "login-a",
				message: "wait",
			},
			{
				type: "extension_ui_request",
				id: "4",
				method: "oauth_info",
				provider: "corp",
				loginId: "login-a",
				message: "info",
				links: [],
			},
			{
				type: "extension_ui_request",
				id: "5",
				method: "oauth_prompt",
				provider: "corp",
				loginId: "login-a",
				prompt: { message: "Prompt" },
			},
			{
				type: "extension_ui_request",
				id: "6",
				method: "oauth_select",
				provider: "corp",
				loginId: "login-a",
				prompt: { message: "Pick", options: [] },
			},
			{ type: "extension_ui_request", id: "7", method: "oauth_manual_code", provider: "corp", loginId: "login-a" },
			{
				type: "extension_ui_request",
				id: "8",
				method: "oauth_manual_code_cancel",
				provider: "corp",
				loginId: "login-a",
			},
		] as const;
		await dispatchRpcOAuthRequest("corp", "login-a", callbacks, { ...requests[0], loginId: "stale" }, respond);
		for (const request of requests) await dispatchRpcOAuthRequest("corp", "login-a", callbacks, request, respond);

		expect(calls).toEqual(["auth", "device", "progress", "info", "manual-cancel"]);
		expect(responses).toEqual([
			{ type: "extension_ui_response", id: "5", value: "prompt-value" },
			{ type: "extension_ui_response", id: "6", value: "selected-value" },
			{ type: "extension_ui_response", id: "7", value: "manual-value" },
		]);
	});

	it("runs custom OAuth in the engine, round-trips callbacks, and never returns tokens", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const observed: string[] = [];
		harness.session.modelRuntime.registerProvider("callback-oauth", {
			baseUrl: "https://callback.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Callback OAuth",
				login: async (callbacks) => {
					callbacks.onAuth({ url: "https://login.invalid", instructions: "open" });
					callbacks.onDeviceCode({ userCode: "ABCD", verificationUri: "https://device.invalid" });
					callbacks.onProgress?.("waiting");
					callbacks.onInfo?.("notice", [{ label: "Docs", url: "https://docs.invalid" }]);
					const prompt = await callbacks.onPrompt({ message: "Tenant", placeholder: "acme" });
					const selected = await callbacks.onSelect({
						message: "Account",
						options: [{ id: "one", label: "One" }],
					});
					const manual = await callbacks.onManualCodeInput?.();
					return {
						access: `engine-secret-${prompt}-${selected}-${manual}`,
						refresh: "engine-refresh",
						expires: Date.now() + 60_000,
					};
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			models: [],
		});
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			createRuntime,
		);
		const pending: RpcPendingExtensionRequests = new Map();
		const handler = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			pendingExtensionRequests: pending,
			output: (frame) => {
				if (!("method" in frame) || !frame.method.startsWith("oauth_")) return;
				observed.push(frame.method);
				const record = pending.get(frame.id);
				if (!record) return;
				const value =
					frame.method === "oauth_prompt"
						? "acme"
						: frame.method === "oauth_select"
							? "one"
							: frame.method === "oauth_manual_code"
								? "manual"
								: undefined;
				if (value !== undefined)
					queueMicrotask(() => record.resolve({ type: "extension_ui_response", id: frame.id, value }));
			},
		});

		const response = await handler({
			id: "login",
			type: "login_provider",
			provider: "callback-oauth",
			authType: "oauth",
		});
		expect(observed).toEqual([
			"oauth_auth",
			"oauth_device_code",
			"oauth_progress",
			"oauth_info",
			"oauth_prompt",
			"oauth_select",
			"oauth_manual_code",
		]);
		expect(await harness.authStorage.read("callback-oauth")).toMatchObject({
			type: "oauth",
			access: "engine-secret-acme-one-manual",
		});
		expect(response).toMatchObject({ success: true, data: { provider: "callback-oauth", cancelled: false } });
		expect(JSON.stringify(response)).not.toContain("engine-secret");
		expect(JSON.stringify(response)).not.toContain("engine-refresh");
	});

	it("uses engine-owned acquisition and applies catalog state only after success", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const reload = vi.spyOn(harness.session.modelRuntime, "reloadCredentials");
		const apply = vi.fn();
		const remoteCatalog = { models: [], scopedModels: [], customAuthProviders: [], oauthProviders: [] };
		const client = {
			onExtensionUIRequest: () => () => {},
			respondExtensionUI: async () => {},
			cancelLoginProvider: async () => {},
			requestInternal: async (command: { provider: string }) => ({
				provider: command.provider,
				cancelled: false,
				...remoteCatalog,
			}),
		};

		await loginIsolatedOAuthProvider(harness.session, client as never, { apply } as never, "corp", {
			onAuth() {},
			onDeviceCode() {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
		});
		expect(apply).toHaveBeenCalledWith(expect.objectContaining({ provider: "corp", cancelled: false }));
		expect(reload).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledWith({ refreshAvailability: false });
	});

	it("does not apply or reload cancelled or failed isolated OAuth results", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const reload = vi.spyOn(harness.session.modelRuntime, "reloadCredentials");
		const apply = vi.fn();
		const baseClient = {
			onExtensionUIRequest: () => () => {},
			respondExtensionUI: async () => {},
			cancelLoginProvider: async () => {},
			requestInternal: async () => ({ provider: "corp", cancelled: true }),
		};
		const callbacks = { onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined };

		await expect(
			loginIsolatedOAuthProvider(harness.session, baseClient as never, { apply } as never, "corp", callbacks),
		).rejects.toMatchObject({ message: "Login cancelled" });
		const persistenceFailure = new Error("auth.json is read-only");
		await expect(
			loginIsolatedOAuthProvider(
				harness.session,
				{
					...baseClient,
					requestInternal: async () => {
						throw persistenceFailure;
					},
				} as never,
				{ apply } as never,
				"corp",
				callbacks,
			),
		).rejects.toBe(persistenceFailure);
		expect(apply).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});

	it("normalizes intentional frontend callback cancellation without applying catalog state", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const abort = new DOMException("dialog closed", "AbortError");
		let listener: ((request: RpcExtensionUIRequest) => void) | undefined;
		const apply = vi.fn();
		const reload = vi.spyOn(harness.session.modelRuntime, "reloadCredentials");
		const client = {
			onExtensionUIRequest: (next: (request: RpcExtensionUIRequest) => void) => {
				listener = next;
				return () => {};
			},
			respondExtensionUI: async () => {},
			cancelLoginProvider: async () => {},
			requestInternal: async (command: { provider: string; loginId: string }) => {
				listener?.({
					type: "extension_ui_request",
					id: "auth",
					method: "oauth_auth",
					provider: command.provider,
					loginId: command.loginId,
					info: { url: "https://login.invalid" },
				});
				return { provider: command.provider, cancelled: true };
			},
		};

		await expect(
			loginIsolatedOAuthProvider(harness.session, client as never, { apply } as never, "corp", {
				onAuth: () => {
					throw abort;
				},
				onDeviceCode() {},
				onPrompt: async () => "",
				onSelect: async () => undefined,
			}),
		).rejects.toMatchObject({ message: "Login cancelled", cause: abort });
		expect(apply).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});
});

describe("RPC OAuth cancellation isolation", () => {
	it("cancels one loginId without cancelling a concurrent login for another provider", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		for (const provider of ["corp-a", "corp-b"]) {
			harness.session.modelRuntime.registerProvider(provider, {
				baseUrl: `https://${provider}.test/v1`,
				api: "openai-completions",
				oauth: {
					name: provider,
					login: async (callbacks) => ({
						access: `${provider}-${await callbacks.onPrompt({ message: provider })}`,
						refresh: "refresh",
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credential) => credential,
					getApiKey: (credential) => credential.access,
				},
				models: [
					{
						id: `${provider}-model`,
						name: `${provider} model`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4_096,
					},
				],
			});
		}
		const runtime = new AgentSessionRuntime(
			harness.session,
			{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
			createRuntime,
		);
		const pending: RpcPendingExtensionRequests = new Map();
		const promptIds = new Map<string, string>();
		const handler = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			pendingExtensionRequests: pending,
			output: (frame) => {
				if ("method" in frame && frame.method === "oauth_prompt") promptIds.set(frame.loginId, frame.id);
			},
		});

		const loginA = handler({
			id: "a",
			type: "login_provider",
			provider: "corp-a",
			authType: "oauth",
			loginId: "login-a",
		});
		let bResolved = false;
		const loginB = handler({
			id: "b",
			type: "login_provider",
			provider: "corp-b",
			authType: "oauth",
			loginId: "login-b",
		}).then((result) => {
			bResolved = true;
			return result;
		});
		await vi.waitFor(() => expect(promptIds.size).toBe(2));

		await handler({ id: "cancel-a", type: "cancel_login_provider", provider: "corp-a", loginId: "login-a" });
		expect(await loginA).toMatchObject({ data: { provider: "corp-a", cancelled: true } });
		await Promise.resolve();
		expect(bResolved).toBe(false);
		const promptIdB = promptIds.get("login-b")!;
		pending.get(promptIdB)?.resolve({ type: "extension_ui_response", id: promptIdB, value: "ok" });
		expect(await loginB).toMatchObject({ data: { provider: "corp-b", cancelled: false } });
		expect(await harness.authStorage.read("corp-a")).toBeUndefined();
		expect(await harness.authStorage.read("corp-b")).toMatchObject({ type: "oauth", access: "corp-b-ok" });
	});
});

describe("RPC OAuth failed transaction isolation", () => {
	it("does not refresh or overwrite prior credentials after a failed engine-owned login", async () => {
		const { harness, handler } = await createRuntimeHarness();
		harness.session.modelRuntime.registerProvider("corp-oauth", {
			baseUrl: "https://provider.test/v1",
			api: "openai-completions",
			oauth: {
				name: "Corp OAuth",
				login: async () => {
					throw new Error("provider denied login");
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			models: [],
		});
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");

		await expect(
			handler({
				id: "failed-login",
				type: "login_provider",
				provider: "corp-oauth",
				authType: "oauth",
			}),
		).rejects.toThrow("provider denied login");
		expect(await harness.authStorage.read("corp-oauth")).toEqual({ type: "api_key", key: "previous" });
		expect(refresh).not.toHaveBeenCalled();
	});
});
describe("RPC OAuth credential survival", () => {
	it("returns the acquired credential without starting post-login model refresh work", async () => {
		const { harness, handler } = await createRuntimeHarness();
		const refresh = vi
			.spyOn(harness.session.modelRuntime, "refresh")
			.mockImplementation(() => new Promise<never>(() => {}));

		const response = await Promise.race([
			handler({
				id: "login",
				type: "login_provider",
				provider: "corp-oauth",
				authType: "oauth",
			}).then((result) => ({ state: "resolved" as const, result })),
			new Promise<{ state: "stuck" }>((resolve) => setTimeout(() => resolve({ state: "stuck" }), 25)),
		]);

		expect(response).toMatchObject({
			state: "resolved",
			result: { success: true, data: { provider: "corp-oauth", cancelled: false } },
		});
		expect(refresh).not.toHaveBeenCalled();
		expect(await harness.authStorage.read("corp-oauth")).toMatchObject({ type: "oauth", access: "new-secret" });
	});

	it("acknowledges persisted logout without starting post-logout model refresh work", async () => {
		const { harness, handler } = await createRuntimeHarness();
		const providerModel = harness.session.modelRuntime.getModel("corp-oauth", "corp-model");
		expect(providerModel).toBeDefined();
		harness.session.setScopedModels([{ model: providerModel! }]);
		const refresh = vi
			.spyOn(harness.session.modelRuntime, "refresh")
			.mockImplementation(() => new Promise<never>(() => {}));

		const response = await Promise.race([
			handler({ id: "logout", type: "logout_provider", provider: "corp-oauth" }).then((result) => ({
				state: "resolved" as const,
				result,
			})),
			new Promise<{ state: "stuck" }>((resolve) => setTimeout(() => resolve({ state: "stuck" }), 25)),
		]);

		expect(response).toMatchObject({
			state: "resolved",
			result: {
				success: true,
				data: { provider: "corp-oauth", authStatus: { configured: false }, scopedModels: [] },
			},
		});
		expect(refresh).not.toHaveBeenCalled();
		expect(await harness.authStorage.read("corp-oauth")).toBeUndefined();
		expect(await handler({ id: "state-after-logout", type: "get_state" })).toMatchObject({ success: true });
	});
});

describe("RPC model refresh timeout", () => {
	it("releases a refresh command even when provider work ignores cancellation", async () => {
		const { harness, handler } = await createRuntimeHarness();
		vi.spyOn(harness.session.modelRuntime, "reloadCredentials").mockResolvedValue();
		vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => new Promise<never>(() => {}));

		const response = await handler({ id: "refresh", type: "refresh_models", timeoutMs: 5 });

		expect(response).toMatchObject({
			id: "refresh",
			command: "refresh_models",
			success: true,
			data: { aborted: true },
		});
	});

	it("starts the refresh deadline before credential reload work", async () => {
		const { harness, handler } = await createRuntimeHarness();
		vi.spyOn(harness.session.modelRuntime, "reloadCredentials").mockImplementation(
			() => new Promise<never>(() => {}),
		);
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh");

		const response = await Promise.race([
			handler({ id: "refresh", type: "refresh_models", timeoutMs: 5 }),
			new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 25)),
		]);

		expect(response).toMatchObject({
			id: "refresh",
			command: "refresh_models",
			success: true,
			data: { aborted: true },
		});
		expect(refresh).not.toHaveBeenCalled();
	});
});
