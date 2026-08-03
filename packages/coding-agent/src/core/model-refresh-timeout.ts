/** Shared deadline for interactive model-catalog refreshes. */
export const INTERACTIVE_MODEL_REFRESH_TIMEOUT_MS = 15_000;

/**
 * Provider auth checks are local probes, but extensions can implement them with
 * commands or other work that ignores cancellation. Logout must acknowledge a
 * persisted credential deletion before the RPC client's 30-second deadline.
 */
export const POST_LOGOUT_AUTH_CHECK_TIMEOUT_MS = 1_000;
