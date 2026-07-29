import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { type AtomicOAuthLoginCallbacks, resetLegacyOAuthProviders } from "../src/core/oauth-provider-bridge.ts";
import { RemoteModelCatalog } from "../src/modes/interactive-engine/remote-model-catalog.ts";
import { loginIsolatedOAuthProvider } from "../src/modes/interactive-engine/isolated-auth.ts";
import { dispatchRpcOAuthRequest } from "../src/modes/rpc/rpc-oauth-client.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-auth-routing.ts";
import { resolveLoginProviderReference } from "../src/modes/interactive/login-provider-options.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import type { RpcPendingExtensionRequests } from "../src/modes/rpc/rpc-extension-ui.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const createRuntime = (async () => { throw new Error("not used"); }) as CreateAgentSessionRuntimeFactory;
const harnesses: Harness[] = [];
afterEach(() => {
	resetLegacyOAuthProviders();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

async function createRuntimeHarness() {
	const harness = await createHarness({ withConfiguredAuth: false });
	harnesses.push(harness);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		createRuntime,
	);
	return { harness, runtime };
}

describe("isolated engine OAuth", () => {
	it("transports JSON-safe descriptors for engine-only extension OAuth", async () => {
		const { harness, runtime } = await createRuntimeHarness();
		harness.session.modelRegistry.registerProvider("corp-oauth", {
			oauth: {
				name: "Corp OAuth",
				usesCallbackServer: true,
				login: async () => ({ access: "secret", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
		harness.session.modelRegistry.registerProvider("openrouter", {
			oauth: {
				name: "Latest OpenRouter Override",
				login: async () => ({ access: "override", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
		const handler = createRpcCommandHandler({
			runtimeHost: runtime, getSession: () => harness.session, rebindSession: async () => {}, output: () => {},
		});

		const response = await handler({ id: "catalog", type: "get_available_models" });
		expect(response).toMatchObject({ success: true, data: { oauthProviders: expect.arrayContaining([
			{ id: "corp-oauth", name: "Corp OAuth", usesCallbackServer: true },
			{ id: "openrouter", name: "Latest OpenRouter Override" },
			expect.objectContaining({ id: "kimi-coding", name: "Kimi Code (subscription)" }),
		]) } });
		const serialized = JSON.stringify(response);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("refreshToken");
		expect(serialized).not.toContain("getApiKey");
	});

	it("exposes transported OAuth descriptors through the frontend auth surface", async () => {
		const { harness } = await createRuntimeHarness();
		const catalog = new RemoteModelCatalog({} as never);
		catalog.apply({
			models: [], scopedModels: [], customAuthProviders: [],
			oauthProviders: [{ id: "corp-oauth", name: "Corp OAuth", loginLabel: "Sign in", usesCallbackServer: true }],
		});
		resetLegacyOAuthProviders();
		catalog.patch(harness.session);

		expect(harness.session.modelRegistry.authStorage.getOAuthProviders()).toEqual([
			{ id: "corp-oauth", name: "Corp OAuth", loginLabel: "Sign in", usesCallbackServer: true },
		]);
		expect(harness.session.modelRegistry.getProviderDisplayName("corp-oauth")).toBe("Corp OAuth");
		const getOptions = InteractiveModeBase.prototype.getLoginProviderOptions as (
			this: { session: typeof harness.session }, authType?: "oauth" | "api_key",
		) => Array<{ id: string; name: string; authType: "oauth" | "api_key" }>;
		const options = getOptions.call({ session: harness.session });
		expect(options).toContainEqual({ id: "corp-oauth", name: "Corp OAuth", authType: "oauth" });
		expect(resolveLoginProviderReference(options, "corp-oauth")).toMatchObject({
			kind: "direct", option: { id: "corp-oauth", authType: "oauth" },
		});
		catalog.apply({
			models: [], scopedModels: [], customAuthProviders: [],
			oauthProviders: [{ id: "corp-oauth", name: "Renamed Corp OAuth" }],
		});
		expect(harness.session.modelRegistry.getProviderDisplayName("corp-oauth")).toBe("Renamed Corp OAuth");
	});

	it("runs custom OAuth in the engine, round-trips callbacks, and never returns tokens", async () => {
		const { harness, runtime } = await createRuntimeHarness();
		const observed: string[] = [];
		harness.session.modelRegistry.registerProvider("corp-oauth", {
			oauth: {
				name: "Corp OAuth",
				login: async (baseCallbacks) => {
					const callbacks = baseCallbacks as AtomicOAuthLoginCallbacks;
					callbacks.onAuth({ url: "https://login.invalid", instructions: "open" });
					callbacks.onDeviceCode({ userCode: "ABCD", verificationUri: "https://device.invalid" });
					callbacks.onProgress?.("waiting");
					callbacks.onInfo?.("notice", [{ label: "Docs", url: "https://docs.invalid" }]);
					const prompt = await callbacks.onPrompt({ message: "Tenant", placeholder: "acme" });
					const selected = await callbacks.onSelect({ message: "Account", options: [{ id: "one", label: "One" }] });
					const manual = await callbacks.onManualCodeInput?.();
					return { access: `engine-secret-${prompt}-${selected}-${manual}`, refresh: "engine-refresh", expires: Date.now() + 60_000 };
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
		const pending: RpcPendingExtensionRequests = new Map();
		const output = (frame: object) => {
			if (!("type" in frame) || frame.type !== "extension_ui_request") return;
			const request = frame as RpcExtensionUIRequest;
			observed.push(request.method);
			const record = pending.get(request.id);
			if (!record) return;
			const value = request.method === "oauth_prompt" ? "acme"
				: request.method === "oauth_select" ? "one"
				: request.method === "oauth_manual_code" ? "manual" : undefined;
			if (value !== undefined) queueMicrotask(() => record.resolve({ type: "extension_ui_response", id: request.id, value }));
		};
		const handler = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output,
			pendingExtensionRequests: pending,
		});

		const response = await handler({ id: "login", type: "login_provider", provider: "corp-oauth", authType: "oauth" });
		expect(observed).toEqual([
			"oauth_auth", "oauth_device_code", "oauth_progress", "oauth_info", "oauth_prompt", "oauth_select", "oauth_manual_code",
		]);
		expect(harness.authStorage.get("corp-oauth")).toMatchObject({ type: "oauth", access: "engine-secret-acme-one-manual" });
		expect(response).toMatchObject({ success: true, data: { provider: "corp-oauth", cancelled: false } });
		expect(JSON.stringify(response)).not.toContain("engine-secret");
		expect(JSON.stringify(response)).not.toContain("engine-refresh");
	});

	it("dispatches correlated OAuth callbacks in the frontend", async () => {
		const calls: string[] = [];
		const responses: object[] = [];
		const frontendCallbacks: AtomicOAuthLoginCallbacks = {
			onAuth: () => calls.push("auth"),
			onDeviceCode: () => calls.push("device"),
			onProgress: () => calls.push("progress"),
			onInfo: () => calls.push("info"),
			onPrompt: async () => "prompt-value",
			onSelect: async () => "selected-value",
			onManualCodeInput: async () => "manual-value",
			onManualCodeCancel: () => calls.push("manual-cancel"),
		};
		const respond = async (response: object) => { responses.push(response); };
		const requests = [
			{ type: "extension_ui_request", id: "1", method: "oauth_auth", provider: "corp", loginId: "login-a", info: { url: "https://login" } },
			{ type: "extension_ui_request", id: "2", method: "oauth_device_code", provider: "corp", loginId: "login-a", info: { userCode: "A", verificationUri: "https://device" } },
			{ type: "extension_ui_request", id: "3", method: "oauth_progress", provider: "corp", loginId: "login-a", message: "wait" },
			{ type: "extension_ui_request", id: "4", method: "oauth_info", provider: "corp", loginId: "login-a", message: "info", links: [] },
			{ type: "extension_ui_request", id: "5", method: "oauth_prompt", provider: "corp", loginId: "login-a", prompt: { message: "Prompt" } },
			{ type: "extension_ui_request", id: "6", method: "oauth_select", provider: "corp", loginId: "login-a", prompt: { message: "Pick", options: [] } },
			{ type: "extension_ui_request", id: "7", method: "oauth_manual_code", provider: "corp", loginId: "login-a" },
			{ type: "extension_ui_request", id: "8", method: "oauth_manual_code_cancel", provider: "corp", loginId: "login-a" },
		] as const;
		await dispatchRpcOAuthRequest("corp", "login-a", frontendCallbacks, { ...requests[0], loginId: "stale" }, respond);
		expect(calls).toEqual([]);
		for (const request of requests) await dispatchRpcOAuthRequest("corp", "login-a", frontendCallbacks, request, respond);

		expect(calls).toEqual(["auth", "device", "progress", "info", "manual-cancel"]);
		expect(responses).toEqual([
			{ type: "extension_ui_response", id: "5", value: "prompt-value" },
			{ type: "extension_ui_response", id: "6", value: "selected-value" },
			{ type: "extension_ui_response", id: "7", value: "manual-value" },
		]);
	});

	it("uses engine-owned acquisition and applies the catalog only after success", async () => {
		let reloads = 0;
		let applied = 0;
		let acquired = 0;
		const remoteCatalog = { models: [], scopedModels: [], customAuthProviders: [], oauthProviders: [] };
		const client = {
			onExtensionUIRequest: () => () => {},
			respondExtensionUI: async () => {},
			cancelLoginProvider: async () => {},
			requestInternal: async (command: { provider: string }) => {
				acquired += 1;
				expect(command.provider).toBe("corp");
				return { provider: command.provider, cancelled: false as const, ...remoteCatalog };
			},
		};
		await loginIsolatedOAuthProvider(
			{ modelRegistry: { authStorage: { reload: () => { reloads += 1; } } } } as never,
			client as never,
			{ apply: () => { applied += 1; } } as never,
			"corp",
			{ onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined },
		);
		expect({ acquired, reloads, applied }).toEqual({ acquired: 1, reloads: 1, applied: 1 });
	});

	it("cancels only the active engine OAuth transaction without overwriting prior credentials", async () => {
		const { harness, runtime } = await createRuntimeHarness();
		harness.authStorage.set("corp-oauth", { type: "api_key", key: "previous" });
		harness.session.modelRegistry.registerProvider("corp-oauth", {
			oauth: {
				name: "Corp OAuth",
				login: async (callbacks) => {
					await callbacks.onPrompt({ message: "Block" });
					return { access: "should-not-save", refresh: "refresh", expires: Date.now() + 60_000 };
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
		const pending: RpcPendingExtensionRequests = new Map();
		let promptReady!: () => void;
		const prompt = new Promise<void>((resolve) => { promptReady = resolve; });
		const handler = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			pendingExtensionRequests: pending,
			output: (frame) => {
				if ("method" in frame && frame.method === "oauth_prompt") promptReady();
			},
		});
		let resolved = false;
		const login = handler({
			id: "login", type: "login_provider", provider: "corp-oauth", authType: "oauth", loginId: "active-login",
		}).then((response) => { resolved = true; return response; });
		await prompt;
		await handler({
			id: "stale-cancel", type: "cancel_login_provider", provider: "corp-oauth", loginId: "stale-login",
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		await handler({
			id: "cancel", type: "cancel_login_provider", provider: "corp-oauth", loginId: "active-login",
		});
		const response = await login;

		expect(response).toMatchObject({ success: true, data: { provider: "corp-oauth", cancelled: true } });
		expect(harness.authStorage.get("corp-oauth")).toEqual({ type: "api_key", key: "previous" });
		expect(pending.size).toBe(0);
	});


	it("isolates concurrent provider callbacks and cancellation by login id", async () => {
		const { harness, runtime } = await createRuntimeHarness();
		for (const provider of ["corp-a", "corp-b"]) {
			harness.session.modelRegistry.registerProvider(provider, {
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
			});
		}
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
		const loginA = handler({ id: "a", type: "login_provider", provider: "corp-a", authType: "oauth", loginId: "login-a" });
		let bResolved = false;
		const loginB = handler({ id: "b", type: "login_provider", provider: "corp-b", authType: "oauth", loginId: "login-b" })
			.then((result) => { bResolved = true; return result; });
		await vi.waitFor(() => expect(promptIds.size).toBe(2));

		await handler({ id: "cancel-a", type: "cancel_login_provider", provider: "corp-a", loginId: "login-a" });
		expect(await loginA).toMatchObject({ data: { provider: "corp-a", cancelled: true } });
		await Promise.resolve();
		expect(bResolved).toBe(false);
		pending.get(promptIds.get("login-b")!)?.resolve({ type: "extension_ui_response", id: promptIds.get("login-b")!, value: "ok" });
		expect(await loginB).toMatchObject({ data: { provider: "corp-b", cancelled: false } });
		expect(harness.authStorage.get("corp-a")).toBeUndefined();
		expect(harness.authStorage.get("corp-b")).toMatchObject({ type: "oauth", access: "corp-b-ok" });
	});
	it("does not apply or reload cancelled or failed isolated OAuth results", async () => {
		let reloads = 0;
		let applied = 0;
		const client = {
			onExtensionUIRequest: () => () => {},
			respondExtensionUI: async () => {},
			cancelLoginProvider: async () => {},
			requestInternal: async () => ({ provider: "corp", cancelled: true as const }),
		};
		await expect(loginIsolatedOAuthProvider(
			{ modelRegistry: { authStorage: { reload: () => { reloads += 1; } } } } as never,
			client as never,
			{ apply: () => { applied += 1; } } as never,
			"corp",
			{ onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined },
		)).rejects.toMatchObject({ message: "Login cancelled" });
		expect({ reloads, applied }).toEqual({ reloads: 0, applied: 0 });
		const persistenceFailure = new Error("auth.json is read-only");
		await expect(loginIsolatedOAuthProvider(
			{ modelRegistry: { authStorage: { reload: () => { reloads += 1; } } } } as never,
			{ ...client, requestInternal: async () => { throw persistenceFailure; } } as never,
			{ apply: () => { applied += 1; } } as never,
			"corp",
			{ onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined },
		)).rejects.toBe(persistenceFailure);
		expect({ reloads, applied }).toEqual({ reloads: 0, applied: 0 });
	});


	it("normalizes intentional frontend callback cancellation without applying catalog state", async () => {
		const abort = new DOMException("dialog closed", "AbortError");
		let listener: ((request: RpcExtensionUIRequest) => void) | undefined;
		let applied = 0;
		let reloaded = 0;
		const client = {
			onExtensionUIRequest: (next: (request: RpcExtensionUIRequest) => void) => { listener = next; return () => {}; },
			respondExtensionUI: async () => {},
			cancelLoginProvider: async () => {},
			requestInternal: async (command: { provider: string; loginId: string }) => {
				listener?.({
					type: "extension_ui_request", id: "auth", method: "oauth_auth",
					provider: command.provider, loginId: command.loginId, info: { url: "https://login.invalid" },
				});
				return { provider: command.provider, cancelled: true as const };
			},
		};
		let caught: unknown;
		try {
			await loginIsolatedOAuthProvider(
				{ modelRegistry: { authStorage: { reload: () => { reloaded += 1; } } } } as never,
				client as never,
				{ apply: () => { applied += 1; } } as never,
				"corp",
				{ onAuth: () => { throw abort; }, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined },
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toMatchObject({ message: "Login cancelled", cause: abort });
		expect({ applied, reloaded }).toEqual({ applied: 0, reloaded: 0 });
	});
	it("keeps the acquired credential when post-login model refresh reports provider errors", async () => {
		const { harness, runtime } = await createRuntimeHarness();
		harness.authStorage.set("corp-oauth", { type: "api_key", key: "previous" });
		harness.session.modelRegistry.registerProvider("corp-oauth", {
			oauth: {
				name: "Corp OAuth",
				login: async () => ({ access: "new-secret", refresh: "new-refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
		harness.session.modelRegistry.refresh = async () => ({
			aborted: false,
			errors: new Map([["corp-oauth", new Error("catalog unavailable")]]),
		});
		const handler = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			pendingExtensionRequests: new Map(),
			output: () => {},
		});

		const response = await handler({
			id: "login", type: "login_provider", provider: "corp-oauth", authType: "oauth",
		});
		expect(response).toMatchObject({ success: true, data: { provider: "corp-oauth", cancelled: false } });
		expect(harness.authStorage.get("corp-oauth")).toMatchObject({ type: "oauth", access: "new-secret" });
	});

	it("keeps a thrown post-login model refresh failure visible without rolling back", async () => {
		const { harness, runtime } = await createRuntimeHarness();
		harness.authStorage.set("corp-oauth", { type: "api_key", key: "previous" });
		harness.session.modelRegistry.registerProvider("corp-oauth", {
			oauth: {
				name: "Corp OAuth",
				login: async () => ({ access: "new-secret", refresh: "new-refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
		const refreshFailure = new DOMException("refresh transport aborted", "AbortError");
		harness.session.modelRegistry.refresh = async () => { throw refreshFailure; };
		const handler = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			pendingExtensionRequests: new Map(),
			output: () => {},
		});

		await expect(handler({
			id: "login", type: "login_provider", provider: "corp-oauth", authType: "oauth",
		})).rejects.toThrow("refresh transport aborted");
		expect(harness.authStorage.get("corp-oauth")).toMatchObject({ type: "oauth", access: "new-secret" });
	});

	it("completes login and keeps the credential when model refresh reports an aborted result", async () => {
		const { harness, runtime } = await createRuntimeHarness();
		harness.authStorage.set("corp-oauth", { type: "api_key", key: "previous" });
		harness.session.modelRegistry.registerProvider("corp-oauth", {
			oauth: {
				name: "Corp OAuth",
				login: async () => ({ access: "new-secret", refresh: "new-refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
		});
		harness.session.modelRegistry.refresh = async () => ({ aborted: true, errors: new Map() });
		const handler = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			pendingExtensionRequests: new Map(),
			output: () => {},
		});

		const response = await handler({
			id: "login", type: "login_provider", provider: "corp-oauth", authType: "oauth",
		});
		expect(response).toMatchObject({ success: true, data: { provider: "corp-oauth", cancelled: false } });
		expect(harness.authStorage.get("corp-oauth")).toMatchObject({ type: "oauth", access: "new-secret" });
	});
});
