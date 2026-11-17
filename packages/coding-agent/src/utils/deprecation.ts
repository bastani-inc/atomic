import chalk from "chalk";

/**
 * Process-global state shared with the bundled packages that warn about the same removed options (settings, subagents,
 * workflows): the warnings already shown, so each message shows once between them, and where they are shown.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";
const SINK_KEY = "__atomicDeprecationSink";
const UI_PENDING_KEY = "__atomicDeprecationWarningsForUi";

type DeprecationRegistry = typeof globalThis & {
	[EMITTED_KEY]?: Set<string>;
	[SINK_KEY]?: (message: string) => void;
	[UI_PENDING_KEY]?: string[];
};

function registry(): DeprecationRegistry {
	return globalThis as DeprecationRegistry;
}

/**
 * Show a deprecation warning once per process: through the installed sink (the interactive UI renders it as a warning
 * in the chat), or on stderr when no UI owns the terminal. With `showInUi`, a warning written to stderr is shown again
 * by the next sink installed, because the interactive UI clears what was printed before it started; use it for a
 * warning only this process can give, such as a change it made to a file.
 */
export function warnDeprecation(message: string, options: { showInUi?: boolean } = {}): void {
	const state = registry();
	state[EMITTED_KEY] ??= new Set<string>();
	if (state[EMITTED_KEY].has(message)) return;
	state[EMITTED_KEY].add(message);
	const sink = state[SINK_KEY];
	if (sink !== undefined) {
		sink(message);
		return;
	}
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
	if (options.showInUi) {
		state[UI_PENDING_KEY] ??= [];
		state[UI_PENDING_KEY].push(message);
	}
}

/**
 * Route deprecation warnings to a UI while it owns the terminal, instead of writing over it. Warnings kept for a UI
 * (`showInUi`) are shown through it first. Returns the function that restores the previous destination.
 */
export function setDeprecationWarningSink(sink: (message: string) => void): () => void {
	const state = registry();
	const previous = state[SINK_KEY];
	state[SINK_KEY] = sink;
	for (const message of state[UI_PENDING_KEY]?.splice(0) ?? []) sink(message);
	return () => {
		if (state[SINK_KEY] === sink) state[SINK_KEY] = previous;
	};
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	registry()[EMITTED_KEY]?.clear();
	registry()[UI_PENDING_KEY]?.splice(0);
}
