import type { Credential } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import type { HostInputFormRequest } from "../../core/extensions/ui-types.ts";
import { createAuthInteraction, isOAuthLoginCancelled } from "../../core/oauth-login.ts";
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
	private readonly inputForm: ProviderLoginInput | undefined;
	private readonly oauthTransport: OAuthInteractionTransport | undefined;
	constructor(inputForm?: ProviderLoginInput, oauthTransport?: OAuthInteractionTransport) {
		this.inputForm = inputForm;
		this.oauthTransport = oauthTransport;
	}

	async login(session: AgentSession, provider: string, loginId = provider): Promise<RpcLoginProviderResult> {
		if (!session.modelRuntime.getProvider(provider)?.auth.apiKey)
			throw new Error(`Provider does not support API-key login: ${provider}`);
		if (!this.inputForm) throw new Error("Provider login requires an interactive input host");
		const controller = this.begin(provider, loginId);
		try {
			const credential = await session.modelRuntime.login(provider, "api_key", {
				signal: controller.signal,
				prompt: async (prompt) => {
					const values = await this.inputForm!.open(
						{
							title: prompt.message,
							heading: "PROVIDER LOGIN",
							submitLabel: "[ Submit ]",
							fields: [
								{
									name: "value",
									type: "string",
									required: false,
									initialValue: "",
									placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
								},
							],
						},
						controller.signal,
					);
					if (!values || controller.signal.aborted) throw new Error("Login cancelled");
					return values.value ?? "";
				},
				notify: () => {},
			});
			if (controller.signal.aborted) return { provider, cancelled: true };
			if (credential.type !== "api_key")
				throw new Error(`Provider returned an unexpected ${credential.type} credential`);
			// The key came from the host's own input form; it is confirmed by type
			// and never sent back down the stdout pipe.
			return { provider, cancelled: false, type: "api_key", ...this.catalog(session) };
		} catch (error) {
			if (controller.signal.aborted || (error instanceof Error && error.message === "Login cancelled"))
				return { provider, cancelled: true };
			throw error;
		} finally {
			this.finish(loginId, controller);
		}
	}

	async loginOAuth(session: AgentSession, provider: string, loginId = provider): Promise<RpcOAuthLoginProviderResult> {
		if (!session.modelRuntime.getProvider(provider)?.auth.oauth)
			throw new Error(`Unknown OAuth provider: ${provider}`);
		if (!this.oauthTransport) throw new Error("OAuth login requires an interactive host");
		const controller = this.begin(provider, loginId);
		try {
			const callbacks = createRpcOAuthCallbacks(provider, loginId, controller.signal, this.oauthTransport);
			try {
				await session.modelRuntime.login(provider, "oauth", createAuthInteraction(callbacks));
			} catch (error) {
				if (isOAuthLoginCancelled(error, controller.signal)) return { provider, cancelled: true };
				throw error;
			}
			if (controller.signal.aborted) return { provider, cancelled: true };
			session.refreshCurrentModelFromRegistry();
			return { provider, cancelled: false, ...this.catalog(session) };
		} finally {
			this.finish(loginId, controller);
		}
	}

	async save(session: AgentSession, provider: string, credential: Credential): Promise<RpcModelCatalog> {
		await session.modelRuntime.saveCredential(provider, credential);
		session.refreshCurrentModelFromRegistry();
		return this.catalog(session);
	}
	cancel(provider: string, loginId?: string): void {
		if (loginId !== undefined) {
			const active = this.controllers.get(loginId);
			if (active?.provider === provider) active.controller.abort();
			return;
		}
		for (const active of this.controllers.values()) if (active.provider === provider) active.controller.abort();
	}
	private begin(provider: string, loginId: string): AbortController {
		if ([...this.controllers.values()].some((active) => active.provider === provider))
			throw new Error(`Login already in progress: ${provider}`);
		const controller = new AbortController();
		this.controllers.set(loginId, { provider, controller });
		return controller;
	}
	private finish(loginId: string, controller: AbortController): void {
		if (this.controllers.get(loginId)?.controller === controller) this.controllers.delete(loginId);
	}
	private catalog(session: AgentSession): RpcModelCatalog {
		return {
			models: [...session.modelRuntime.getAvailableSnapshot()],
			scopedModels: [...session.scopedModels],
			customAuthProviders: [],
			oauthProviders: session.modelRuntime.getOAuthProviderMetadata(),
		};
	}
}
