/**
 * Warnings already shown in this process and where to show them, shared with the host's deprecation warnings: each
 * removed option is named once however many packages, calls or stages still pass it, and while the interactive UI owns
 * the terminal it renders the warning instead of the text being written over it.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";
const SINK_KEY = "__atomicDeprecationSink";

type DeprecationRegistry = typeof globalThis & {
	[EMITTED_KEY]?: Set<string>;
	[SINK_KEY]?: (message: string) => void;
};

/** Warn once per process that an option of the removed automatic model routing is ignored. */
export function warnRemovedRoutingOption(option: string): void {
	const message = `"${option}" is ignored: automatic model routing was removed, so "auto" runs your default model and provider or model restrictions no longer limit "auto" or any fallback model.`;
	const registry = globalThis as DeprecationRegistry;
	registry[EMITTED_KEY] ??= new Set<string>();
	if (registry[EMITTED_KEY].has(message)) return;
	registry[EMITTED_KEY].add(message);
	const sink = registry[SINK_KEY];
	if (sink !== undefined) sink(message);
	else console.warn(`Deprecation warning: ${message}`);
}
