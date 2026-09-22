import type { AuthInteraction } from "@bastani/pi-ai";
import type { AgentSession } from "../../core/agent-session.js";
import { type AtomicOAuthLoginCallbacks, normalizeOAuthLoginError } from "../../core/oauth-login.ts";
import { operationSignal, raceWithAbortSignal } from "../../utils/abort.js";
import type { RpcClient } from "../rpc/rpc-client.ts";
import { loginRpcOAuthProvider } from "../rpc/rpc-oauth-client.ts";
import type { RemoteModelCatalog } from "./remote-model-catalog.ts";

export type { AtomicOAuthLoginCallbacks } from "../../core/oauth-login.ts";

/** Acquire and persist OAuth entirely in the engine, transporting only UI callbacks and catalog metadata. */
export async function loginIsolatedOAuthProvider(
	session: AgentSession,
	client: RpcClient,
	catalog: RemoteModelCatalog,
	provider: string,
	callbacks: AtomicOAuthLoginCallbacks,
): Promise<{ modelsRefreshed: true }> {
	const remoteCatalog = await loginRpcOAuthProvider(client, provider, callbacks);
	if (remoteCatalog.cancelled) {
		throw normalizeOAuthLoginError(callbacks.signal?.reason ?? new Error("Login cancelled"), callbacks.signal);
	}
	catalog.apply(remoteCatalog);
	// The engine owns persistence. Refresh the frontend snapshot only after its
	// credential transaction and catalog refresh both complete successfully.
	await session.modelRuntime.reloadCredentials({ refreshAvailability: false });
	return { modelsRefreshed: true };
}

/**
 * Acquire an API key with the frontend's login dialog, then persist it in the engine.
 *
 * The engine owns credential storage for the isolated runtime, so the frontend
 * only collects the key and adopts the engine's catalog and credential snapshot
 * afterwards. A cancelled dialog persists nothing on either side. The engine save
 * deliberately skips the remote catalog refresh: catalog freshness belongs to
 * /model's bounded background refresh, and a failed fetch would otherwise leave the
 * key persisted in the engine while the frontend took the error branch.
 */
export async function loginIsolatedApiKeyProvider(
	session: AgentSession,
	client: RpcClient,
	catalog: RemoteModelCatalog,
	provider: string,
	interaction: AuthInteraction,
): Promise<{ modelsRefreshed: true }> {
	const apiKeyAuth = session.modelRuntime.getProvider(provider)?.auth.apiKey;
	if (!apiKeyAuth?.login) throw new Error(`Provider does not support api_key login: ${provider}`);
	const signal = operationSignal(interaction.signal);
	signal.throwIfAborted();
	const credential = await raceWithAbortSignal(apiKeyAuth.login({ ...interaction, signal }), signal);
	if (signal.aborted) throw normalizeOAuthLoginError(signal.reason ?? new Error("Login cancelled"), signal);
	const remoteCatalog = await client.saveProviderCredential(provider, credential, { refreshCatalog: false });
	catalog.apply(remoteCatalog);
	await session.modelRuntime.reloadCredentials({ refreshAvailability: false });
	return { modelsRefreshed: true };
}
