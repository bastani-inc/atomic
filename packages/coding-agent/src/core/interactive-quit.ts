/** How the interactive app quits a runtime: `handlerLimitMs` absent leaves the bound to the engine's host. */
export interface InteractiveQuit {
	readonly handlerLimitMs?: number;
}

const interactiveQuits = new WeakMap<object, InteractiveQuit>();

/**
 * Makes `runtime`'s `dispose()` quit as the interactive app does, which gives the sessions' `session_shutdown` handlers
 * about five seconds: an extension's `pi.exec` command still running is ended first, and with `handlerLimitMs` the
 * handlers are waited for at most that long from the start of the dispose, as an interactive engine's are before its
 * host ends it. The rest of each session's close still runs and is waited for.
 */
export function quitAsInteractiveApp(runtime: object, quit: InteractiveQuit = {}): void {
	interactiveQuits.set(runtime, quit);
}

/** How `runtime` quits when it was told to quit as the interactive app does. */
export function interactiveQuitOf(runtime: object): InteractiveQuit | undefined {
	return interactiveQuits.get(runtime);
}
