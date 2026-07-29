import type { AgentSession } from "../../core/agent-session.ts";
import {
	normalizeOAuthLoginError,
	type AtomicOAuthLoginCallbacks,
} from "../../core/oauth-login.ts";
import type { RpcClient } from "../rpc/rpc-client.ts";
import { loginRpcOAuthProvider } from "../rpc/rpc-oauth-client.ts";
import type { RemoteModelCatalog } from "./remote-model-catalog.ts";
export type { AtomicOAuthLoginCallbacks } from "../../core/oauth-login.ts";

/** Acquire and persist OAuth entirely in the engine, transporting only UI callbacks and catalog metadata. */
export async function loginIsolatedOAuthProvider(
	_session: AgentSession,
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
	// Reload only after the engine transaction and catalog refresh both succeed.
	return { modelsRefreshed: true };
}
