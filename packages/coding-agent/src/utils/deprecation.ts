import chalk from "chalk";

/**
 * Warnings already shown in this process. The set lives on `globalThis` so the bundled packages that warn about the
 * same removed option (settings, subagents, workflows) show each message once between them.
 */
const EMITTED_KEY = "__atomicDeprecationWarnings";

function emittedDeprecationWarnings(): Set<string> {
	const registry = globalThis as typeof globalThis & { [EMITTED_KEY]?: Set<string> };
	registry[EMITTED_KEY] ??= new Set<string>();
	return registry[EMITTED_KEY];
}

export function warnDeprecation(message: string): void {
	const emitted = emittedDeprecationWarnings();
	if (emitted.has(message)) return;
	emitted.add(message);
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings().clear();
}
