import { ModelsError } from "@bastani/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { AgentSessionInternalSurface } from "./agent-session-methods.ts";
import { CredentialSynchronizationError } from "./model-runtime.js";
import {
	type AtomicOAuthLoginCallbacks,
	createAuthInteraction,
	normalizeOAuthLoginError,
	OAuthLoginTransactionError,
} from "./oauth-login.ts";
import { sessionGenerationClosing, sessionLifetime, trackSessionWork } from "./session-lifecycle-work.ts";

export type { AtomicOAuthLoginCallbacks } from "./oauth-login.ts";

/** Authenticate through provider-owned OAuth metadata. */
export async function loginRuntimeOAuthProvider(
	session: AgentSession,
	provider: string,
	callbacks: AtomicOAuthLoginCallbacks,
): Promise<void> {
	const lifetime = sessionLifetime(session);
	if (
		(session as unknown as AgentSessionInternalSurface)._disposed ||
		sessionGenerationClosing.has(session) ||
		lifetime.aborted
	)
		throw Object.assign(new Error("Session is closed"), { code: "SessionClosed" });
	const signal = callbacks.signal ? AbortSignal.any([callbacks.signal, lifetime]) : lifetime;
	return trackSessionWork(session, () => login(session, provider, { ...callbacks, signal }));
}

async function login(session: AgentSession, provider: string, callbacks: AtomicOAuthLoginCallbacks): Promise<void> {
	const runtime = session.modelRuntime;
	try {
		await runtime.login(provider, "oauth", createAuthInteraction(callbacks), {
			getDeviceId: () => session.settingsManager.getOrCreateDeviceId(),
		});
	} catch (error) {
		if (error instanceof CredentialSynchronizationError) throw error;
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
