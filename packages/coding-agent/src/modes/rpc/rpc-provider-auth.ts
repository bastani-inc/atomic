import type { AgentSession } from "../../core/agent-session.ts";
import type { AuthCredential } from "../../core/auth-storage.ts";
import type { HostInputFormRequest } from "../../core/extensions/ui-types.ts";
import {
	getOAuthProviderMetadata,
	isOAuthLoginCancelled,
	loginOAuthProvider,
	normalizeOAuthLoginError,
} from "../../core/oauth-provider-bridge.ts";
import { createRpcOAuthCallbacks, type OAuthInteractionTransport } from "./rpc-oauth-interaction.ts";
import type { RpcLoginProviderResult, RpcModelCatalog, RpcOAuthLoginProviderResult } from "./rpc-types.ts";

export interface ProviderLoginInput {
	open(request: HostInputFormRequest, signal?: AbortSignal): Promise<Record<string, string> | undefined>;
}

interface ActiveLogin {
	provider: string;
	controller: AbortController;
}

export class RpcProviderAuth {
	private readonly controllers = new Map<string, ActiveLogin>();
	private readonly inputForm?: ProviderLoginInput;
	private readonly oauthTransport?: OAuthInteractionTransport;

	constructor(inputForm?: ProviderLoginInput, oauthTransport?: OAuthInteractionTransport) {
		this.inputForm = inputForm;
		this.oauthTransport = oauthTransport;
	}

	async login(session: AgentSession, provider: string, loginId = provider): Promise<RpcLoginProviderResult> {
		const customAuth = session.modelRegistry.getCustomApiKeyAuth(provider);
		if (!customAuth) throw new Error(`Provider does not support custom API-key login: ${provider}`);
		if (!this.inputForm) throw new Error("Provider login requires an interactive input host");
		const controller = this.begin(provider, loginId);
		try {
			const credential = await customAuth.login({
				signal: controller.signal,
				prompt: async (prompt) => {
					const values = await this.inputForm!.open({
						title: prompt.message,
						heading: "PROVIDER LOGIN",
						submitLabel: "[ Submit ]",
						fields: [{
							name: "value", type: "string", required: false, initialValue: "",
							placeholder: prompt.placeholder,
						}],
					}, controller.signal);
					if (!values || controller.signal.aborted) throw new Error("Login cancelled");
					return values.value ?? "";
				},
			});
			if (controller.signal.aborted) return { provider, cancelled: true };
			session.modelRegistry.authStorage.set(provider, credential);
			await session.modelRegistry.refresh();
			return { provider, cancelled: false, credential, ...this.catalog(session) };
		} catch (error) {
			if (controller.signal.aborted || (error instanceof Error && error.message === "Login cancelled")) {
				return { provider, cancelled: true };
			}
			throw error;
		} finally {
			this.finish(loginId, controller);
		}
	}

	async loginOAuth(session: AgentSession, provider: string, loginId = provider): Promise<RpcOAuthLoginProviderResult> {
		if (!getOAuthProviderMetadata().some(({ id }) => id === provider)) {
			throw new Error(`Unknown OAuth provider: ${provider}`);
		}
		if (!this.oauthTransport) throw new Error("OAuth login requires an interactive host");
		const controller = this.begin(provider, loginId);
		try {
			const callbacks = createRpcOAuthCallbacks(provider, loginId, controller.signal, this.oauthTransport);
			let credential: AuthCredential;
			try {
				credential = await loginOAuthProvider(provider, callbacks);
			} catch (error) {
				if (isOAuthLoginCancelled(error, controller.signal)) return { provider, cancelled: true };
				throw error;
			}
			if (controller.signal.aborted) return { provider, cancelled: true };
			await this.persistOAuthAndRefresh(session, provider, credential, controller.signal);
			return { provider, cancelled: false, ...this.catalog(session) };
		} finally {
			this.finish(loginId, controller);
		}
	}

	async save(session: AgentSession, provider: string, credential: AuthCredential): Promise<RpcModelCatalog> {
		await session.modelRegistry.authStorage.asCredentialStore().modify(provider, async () => credential);
		await session.modelRegistry.refresh();
		session.refreshCurrentModelFromRegistry();
		return this.catalog(session);
	}

	cancel(provider: string, loginId?: string): void {
		if (loginId !== undefined) {
			const active = this.controllers.get(loginId);
			if (active?.provider === provider) active.controller.abort();
			return;
		}
		for (const active of this.controllers.values()) {
			if (active.provider === provider) active.controller.abort();
		}
	}

	private begin(provider: string, loginId: string): AbortController {
		if ([...this.controllers.values()].some((active) => active.provider === provider)) {
			throw new Error(`Login already in progress: ${provider}`);
		}
		const controller = new AbortController();
		this.controllers.set(loginId, { provider, controller });
		return controller;
	}

	private finish(loginId: string, controller: AbortController): void {
		if (this.controllers.get(loginId)?.controller === controller) this.controllers.delete(loginId);
	}

	private async persistOAuthAndRefresh(
		session: AgentSession,
		provider: string,
		credential: AuthCredential,
		signal: AbortSignal,
	): Promise<void> {
		const storage = session.modelRegistry.authStorage;
		const previous = storage.get(provider);
		const credentialStore = storage.asCredentialStore();
		if (signal.aborted) throw normalizeOAuthLoginError(signal.reason, signal);
		await credentialStore.modify(provider, async () => credential);
		try {
			if (signal.aborted) throw normalizeOAuthLoginError(signal.reason, signal);
			const result = await session.modelRegistry.refresh();
			const failures = [...result.errors.entries()];
			if (failures.length > 0) {
				throw new Error(failures.map(([id, error]) => `${id}: ${error.message}`).join("; "));
			}
			if (signal.aborted) throw normalizeOAuthLoginError(signal.reason, signal);
			if (result.aborted) throw new Error("Model refresh aborted after OAuth login");
			session.refreshCurrentModelFromRegistry();
		} catch (error) {
			if (previous === undefined) await credentialStore.delete(provider);
			else await credentialStore.modify(provider, async () => previous);
			throw error;
		}
	}

	private catalog(session: AgentSession): RpcModelCatalog {
		return {
			models: session.modelRegistry.getAvailable(),
			scopedModels: [...session.scopedModels],
			customAuthProviders: session.modelRegistry.getCustomApiKeyAuthProviders(),
			oauthProviders: getOAuthProviderMetadata(),
		};
	}
}
