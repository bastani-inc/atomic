import chalk from "chalk";

/**
 * Process-global state shared with the bundled packages that warn about the same removed options (settings, subagents,
 * workflows): the warnings already shown, so each message shows once between them, and where they are shown.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";
const SINK_KEY = "__atomicDeprecationSink";

type DeprecationRegistry = typeof globalThis & {
	[EMITTED_KEY]?: Set<string>;
	[SINK_KEY]?: (message: string) => void;
};

function registry(): DeprecationRegistry {
	return globalThis as DeprecationRegistry;
}

/**
 * Show a deprecation warning once per process: through the installed sink (the interactive UI renders it as a warning
 * in the chat), or on stderr when no UI owns the terminal.
 */
export function warnDeprecation(message: string): void {
	const state = registry();
	state[EMITTED_KEY] ??= new Set<string>();
	if (state[EMITTED_KEY].has(message)) return;
	state[EMITTED_KEY].add(message);
	const sink = state[SINK_KEY];
	if (sink !== undefined) sink(message);
	else console.warn(chalk.yellow(`Deprecation warning: ${message}`));
}

/**
 * Route deprecation warnings to a UI while it owns the terminal, instead of writing over it. Returns the function that
 * restores the previous destination.
 */
export function setDeprecationWarningSink(sink: (message: string) => void): () => void {
	const state = registry();
	const previous = state[SINK_KEY];
	state[SINK_KEY] = sink;
	return () => {
		if (state[SINK_KEY] === sink) state[SINK_KEY] = previous;
	};
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	registry()[EMITTED_KEY]?.clear();
}
