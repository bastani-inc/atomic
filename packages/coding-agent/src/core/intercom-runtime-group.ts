/**
 * Shared environment contract for runtime Intercom group inheritance.
 *
 * Intercom and subagents are separate built-in packages, so the host owns the
 * key and reader rather than either extension. This keeps both packages on one
 * contract while allowing subagents to run when Intercom is not installed.
 */
export const RUNTIME_INTERCOM_GROUP_ENV = "ATOMIC_INTERCOM_RUNTIME_GROUP";

/** Use one environment entry per session so in-process sessions cannot overwrite each other. */
export function runtimeIntercomGroupEnvKey(sessionId: string): string {
	return `${RUNTIME_INTERCOM_GROUP_ENV}_${encodeURIComponent(sessionId)}`;
}

/** Read one session's non-empty runtime group from the inherited environment. */
export function readRuntimeIntercomGroup(sessionId: string | undefined): string | undefined {
	if (!sessionId) return undefined;
	const value = process.env[runtimeIntercomGroupEnvKey(sessionId)];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
