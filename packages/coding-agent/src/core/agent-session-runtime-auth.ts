import { ModelsError } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.ts";
import {
	type AtomicOAuthLoginCallbacks,
	createAuthInteraction,
	normalizeOAuthLoginError,
	OAuthLoginTransactionError,
} from "./oauth-login.ts";

export type { AtomicOAuthLoginCallbacks } from "./oauth-login.ts";

/** Authenticate through provider-owned OAuth metadata. */
export async function loginRuntimeOAuthProvider(
	session: AgentSession,
	provider: string,
	callbacks: AtomicOAuthLoginCallbacks,
): Promise<void> {
	const runtime = session.modelRuntime;
	try {
		await runtime.login(provider, "oauth", createAuthInteraction(callbacks));
	} catch (error) {
		if (
			error instanceof ModelsError &&
			error.code === "auth" &&
			error.message.startsWith("Credential store modify failed")
		) {
			throw new OAuthLoginTransactionError(error);
		}
		throw normalizeOAuthLoginError(error, callbacks.signal, { includeActiveSignal: false });
	}
}
