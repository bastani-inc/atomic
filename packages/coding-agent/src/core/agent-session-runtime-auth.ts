import { ModelsError } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import {
	createAuthInteraction,
	getLegacyOAuthProvider,
	loginOAuthProvider,
	normalizeOAuthLoginError,
	OAuthLoginTransactionError,
	type AtomicOAuthLoginCallbacks,
} from "./oauth-provider-bridge.ts";
export type { AtomicOAuthLoginCallbacks } from "./oauth-provider-bridge.ts";

/** Authenticate through provider-owned metadata while preserving extension OAuth. */
export async function loginRuntimeOAuthProvider(
	session: AgentSession,
	provider: string,
	callbacks: AtomicOAuthLoginCallbacks,
): Promise<void> {
	const registry = session.modelRegistry;
	if (getLegacyOAuthProvider(provider)) {
		const credential = await loginOAuthProvider(provider, callbacks);
		try {
			await registry.authStorage.asCredentialStore().modify(provider, async () => credential);
		} catch (error) {
			throw new OAuthLoginTransactionError(error);
		}
		return;
	}
	try {
		await registry.login(provider, "oauth", createAuthInteraction(callbacks));
	} catch (error) {
		if (error instanceof ModelsError && error.code === "auth" && error.message.startsWith("Credential store modify failed")) {
			throw new OAuthLoginTransactionError(error);
		}
		throw normalizeOAuthLoginError(error, callbacks.signal, { includeActiveSignal: false });
	}
}
