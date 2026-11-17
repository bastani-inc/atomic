/**
 * Warnings already shown in this process, shared with the host's deprecation warnings so each removed option is named
 * once however many packages, calls or stages still pass it.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";

/** Warn once per process that an option of the removed automatic model routing is ignored. */
export function warnRemovedRoutingOption(option: string): void {
	const message = `"${option}" is ignored: automatic model routing was removed, so "auto" runs your default model and provider or model restrictions no longer limit "auto" or any fallback model.`;
	const registry = globalThis as typeof globalThis & { [EMITTED_KEY]?: Set<string> };
	registry[EMITTED_KEY] ??= new Set<string>();
	if (registry[EMITTED_KEY].has(message)) return;
	registry[EMITTED_KEY].add(message);
	console.warn(`Deprecation warning: ${message}`);
}
