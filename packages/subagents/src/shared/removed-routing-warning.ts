/**
 * Warnings already shown in this process and where to show them, shared with the host's deprecation warnings: each
 * removed option is named once however many packages or calls still pass it, and while the interactive UI owns
 * the terminal it renders the warning instead of the text being written over it.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";
const SINK_KEY = "__atomicDeprecationSink";
/** The host's own warning function, when it is loaded: it shows a warning the way it shows its own. */
const WARN_KEY = "__atomicWarnDeprecation";

type DeprecationRegistry = typeof globalThis & {
	[EMITTED_KEY]?: Set<string>;
	[SINK_KEY]?: (message: string, notice: { once?: string }) => void;
	[WARN_KEY]?: (message: string, options?: { once?: string }) => void;
};

/**
 * Warn once per process that an option of the removed automatic model routing is ignored. With `saved`, naming a
 * settings file and the values it keeps, the warning is shown once across starts while that file keeps those values.
 */
export function warnRemovedRoutingOption(option: string, saved?: string): void {
	warnDeprecationOnce(
		`"${option}" is ignored: automatic model routing was removed, so "auto" runs your default model and provider or model restrictions no longer limit "auto" or any fallback model.`,
		saved,
	);
}

/** Show a deprecation warning once per process (or, with `saved`, once across starts), as the host shows its own. */
export function warnDeprecationOnce(message: string, saved?: string): void {
	const registry = globalThis as DeprecationRegistry;
	const warn = registry[WARN_KEY];
	if (warn !== undefined) {
		warn(message, saved === undefined ? {} : { once: saved });
		return;
	}
	registry[EMITTED_KEY] ??= new Set<string>();
	if (registry[EMITTED_KEY].has(message)) return;
	registry[EMITTED_KEY].add(message);
	const sink = registry[SINK_KEY];
	if (sink !== undefined) sink(message, {});
	else console.warn(`Deprecation warning: ${message}`);
}
