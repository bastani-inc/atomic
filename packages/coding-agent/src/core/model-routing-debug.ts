/** Set to `1` to print automatic model routing fallbacks and failures. */
export const MODEL_ROUTING_DEBUG_ENV = "ATOMIC_MODEL_ROUTING_DEBUG";

export function isModelRoutingDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[MODEL_ROUTING_DEBUG_ENV] === "1";
}

/**
 * Routing fallbacks are recoverable and already recorded in routing metadata, so
 * they stay out of the terminal and agent context unless routing debugging is on.
 */
export function reportModelRoutingDebug(message: string, env: NodeJS.ProcessEnv = process.env): void {
	if (isModelRoutingDebugEnabled(env)) console.warn(message);
}
