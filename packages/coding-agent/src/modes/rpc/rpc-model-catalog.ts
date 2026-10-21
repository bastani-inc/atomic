import type { AgentSession } from "../../core/agent-session.js";
import type { RpcModelCatalog } from "./rpc-types.ts";

/**
 * The engine's model catalog, plus what a host without the engine's extensions needs to show their providers in
 * `/login` and `/logout`: which offer API-key login, and their auth status. Stored credentials are left out because
 * the host reads the shared credential store itself.
 */
export function createRpcModelCatalog(session: Pick<AgentSession, "modelRuntime" | "scopedModels">): RpcModelCatalog {
	const runtime = session.modelRuntime;
	const registered = new Set(runtime.getRegisteredProviderIds());
	return {
		models: [...runtime.getAvailableSnapshot()],
		scopedModels: [...session.scopedModels],
		customAuthProviders: runtime.getApiKeyLoginProviderMetadata().filter((provider) => registered.has(provider.id)),
		oauthProviders: runtime.getOAuthProviderMetadata(),
		providerAuthStatuses: [...registered]
			.map((provider) => ({ provider, status: runtime.getProviderAuthStatus(provider) }))
			.filter(({ status }) => status.source !== "stored"),
	};
}
