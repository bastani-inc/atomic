import { reportDebug } from "./debug.ts";

/**
 * Routing fallbacks are recoverable and already recorded in routing metadata, so they stay out of the terminal and
 * agent context unless model routing debugging is on.
 */
export function reportModelRoutingDebug(message: string, env: NodeJS.ProcessEnv = process.env): void {
	reportDebug("model-routing", "routing", { message }, () => console.warn(message), env);
}
