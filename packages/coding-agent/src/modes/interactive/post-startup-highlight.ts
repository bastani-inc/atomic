/**
 * Typed state machine that schedules post-startup background work (such as
 * loading non-eager highlight.js grammars and cold compile-cache warmup) so it
 * never fires while deferred startup or an active prompt turn is in flight.
 */

export type PostStartupHighlightState =
	| "idle"
	| "timer_armed"
	| "waiting_for_gate"
	| "quiet_rearm"
	| "loading"
	| "done"
	| "stopped";

/** Quiet delay after deferred startup and any active prompt turn finish before starting background work. */
export const POST_STARTUP_HIGHLIGHT_QUIET_MS = 500;

export interface PostStartupHighlightHost {
	readonly isShuttingDown?: boolean;
	readonly deferredStartupPending?: boolean;
	readonly deferredStartupPromise?: Promise<void> | undefined;
}

type BackgroundWarmupRunner = (signal: AbortSignal) => Promise<void> | void;

interface PostStartupHighlightController {
	state: PostStartupHighlightState;
	promptTurnDepth: number;
	quietTimer: ReturnType<typeof setTimeout> | undefined;
	abortController: AbortController | undefined;
	runner: BackgroundWarmupRunner | undefined;
}

const controllers = new WeakMap<PostStartupHighlightHost, PostStartupHighlightController>();

function getOrCreateController(host: PostStartupHighlightHost): PostStartupHighlightController {
	let controller = controllers.get(host);
	if (!controller) {
		controller = {
			state: "idle",
			promptTurnDepth: 0,
			quietTimer: undefined,
			abortController: undefined,
			runner: undefined,
		};
		controllers.set(host, controller);
	}
	return controller;
}

function clearQuietTimer(controller: PostStartupHighlightController): void {
	if (controller.quietTimer !== undefined) {
		clearTimeout(controller.quietTimer);
		controller.quietTimer = undefined;
	}
}

function isGateBlocked(host: PostStartupHighlightHost, controller: PostStartupHighlightController): boolean {
	return (
		controller.promptTurnDepth > 0 ||
		host.deferredStartupPending === true ||
		host.deferredStartupPromise !== undefined
	);
}

function startBackgroundWarmup(host: PostStartupHighlightHost, controller: PostStartupHighlightController): void {
	if (host.isShuttingDown) {
		controller.state = "stopped";
		return;
	}
	const runner = controller.runner;
	if (!runner) {
		controller.state = "done";
		return;
	}
	controller.state = "loading";
	const abortController = new AbortController();
	controller.abortController = abortController;
	void Promise.resolve()
		.then(() => runner(abortController.signal))
		.then(
			() => {
				if (controller.abortController === abortController) {
					controller.abortController = undefined;
					if (controller.state === "loading") {
						controller.state = abortController.signal.aborted ? "stopped" : "done";
					}
				}
			},
			() => {
				if (controller.abortController === abortController) {
					controller.abortController = undefined;
					if (controller.state === "loading") {
						controller.state = "stopped";
					}
				}
			},
		);
}

function scheduleQuietRearm(host: PostStartupHighlightHost, controller: PostStartupHighlightController): void {
	clearQuietTimer(controller);
	controller.state = "quiet_rearm";
	const timer = setTimeout(() => {
		if (controller.quietTimer === timer) controller.quietTimer = undefined;
		if (controller.state !== "quiet_rearm") return;
		if (host.isShuttingDown) {
			controller.state = "stopped";
			return;
		}
		if (isGateBlocked(host, controller)) {
			controller.state = "waiting_for_gate";
			return;
		}
		startBackgroundWarmup(host, controller);
	}, POST_STARTUP_HIGHLIGHT_QUIET_MS);
	timer.unref?.();
	controller.quietTimer = timer;
}

function maybeRearmFromGate(host: PostStartupHighlightHost, controller: PostStartupHighlightController): void {
	if (host.isShuttingDown) {
		stopPostStartupHighlightWarmup(host);
		return;
	}
	if (controller.state === "waiting_for_gate" && !isGateBlocked(host, controller)) {
		scheduleQuietRearm(host, controller);
	}
}

/**
 * Arms the post-startup background warmup state machine for a new `run()` lifecycle.
 * The initial 500 ms timer lives in `InteractiveMode.run()` (`postStartupTimer`), which
 * calls {@link onPostStartupTimerFired} when it elapses.
 */
export function armPostStartupHighlightWarmup(host: PostStartupHighlightHost, runner: BackgroundWarmupRunner): void {
	const controller = getOrCreateController(host);
	clearQuietTimer(controller);
	controller.abortController?.abort();
	controller.abortController = undefined;
	controller.runner = runner;
	controller.state = host.isShuttingDown ? "stopped" : "timer_armed";
}

/** Called when `InteractiveMode.run()`'s 500 ms `postStartupTimer` fires. */
export function onPostStartupTimerFired(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller) return;
	if (host.isShuttingDown) {
		stopPostStartupHighlightWarmup(host);
		return;
	}
	if (controller.state !== "timer_armed") return;
	if (isGateBlocked(host, controller)) {
		controller.state = "waiting_for_gate";
		return;
	}
	startBackgroundWarmup(host, controller);
}

/** Marks the start of a prompt turn; returns an idempotent release function to call in `finally`. */
export function beginPostStartupPromptTurn(host: PostStartupHighlightHost): () => void {
	const controller = getOrCreateController(host);
	controller.promptTurnDepth += 1;
	if (controller.state === "quiet_rearm") {
		clearQuietTimer(controller);
		controller.state = "waiting_for_gate";
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		controller.promptTurnDepth = Math.max(0, controller.promptTurnDepth - 1);
		maybeRearmFromGate(host, controller);
	};
}

/** Called when deferred startup finishes (whether it succeeded or failed). */
export function notifyPostStartupDeferredComplete(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller) return;
	maybeRearmFromGate(host, controller);
}

/** Stops any pending quiet timer and aborts any in-flight background warmup. */
export function stopPostStartupHighlightWarmup(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller) return;
	clearQuietTimer(controller);
	controller.abortController?.abort();
	controller.abortController = undefined;
	controller.state = "stopped";
}
