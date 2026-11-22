/**
 * Typed state machine that schedules post-startup background work (such as
 * loading non-eager highlight.js grammars and cold compile-cache warmup) so it
 * never fires while deferred startup or the first prompt's request dispatch is
 * in flight, while guaranteeing bounded deferral across long streaming turns
 * and back-to-back turns on both isolated and in-process hosts.
 */

export type PostStartupHighlightState =
	| "idle"
	| "timer_armed"
	| "waiting_for_gate"
	| "quiet_rearm"
	| "loading"
	| "done"
	| "stopped";

/** Short quiet delay after deferred startup and the first prompt's request dispatch settle. */
export const POST_STARTUP_HIGHLIGHT_QUIET_MS = 150;

/**
 * Hard upper bound on deferral from the moment the 500 ms post-startup timer enters
 * `waiting_for_gate`. Anchored once and never reset by later turns, so slow provider
 * TTFT or repeated rapid turns can never starve background highlight loading or
 * compile-cache warmup on either host.
 */
export const POST_STARTUP_MAX_DEFERRAL_MS = 1_200;

interface StreamEventLike {
	readonly type?: string;
	readonly message?: { readonly role?: string };
}

export interface PostStartupHighlightHost {
	readonly isShuttingDown?: boolean;
	readonly deferredStartupPending?: boolean;
	readonly deferredStartupPromise?: Promise<void> | undefined;
	readonly session?: {
		subscribe?(listener: (event: StreamEventLike) => void): () => void;
	};
}

type BackgroundWarmupRunner = (signal: AbortSignal) => Promise<void> | void;

interface PostStartupHighlightController {
	state: PostStartupHighlightState;
	firstPromptPreflightDepth: number;
	firstPromptSettled: boolean;
	quietTimer: ReturnType<typeof setTimeout> | undefined;
	maxDeferralTimer: ReturnType<typeof setTimeout> | undefined;
	unsubscribeStreaming: (() => void) | undefined;
	abortController: AbortController | undefined;
	runner: BackgroundWarmupRunner | undefined;
}

const controllers = new WeakMap<PostStartupHighlightHost, PostStartupHighlightController>();

function getOrCreateController(host: PostStartupHighlightHost): PostStartupHighlightController {
	let controller = controllers.get(host);
	if (!controller) {
		controller = {
			state: "idle",
			firstPromptPreflightDepth: 0,
			firstPromptSettled: false,
			quietTimer: undefined,
			maxDeferralTimer: undefined,
			unsubscribeStreaming: undefined,
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

function clearMaxDeferralTimer(controller: PostStartupHighlightController): void {
	if (controller.maxDeferralTimer !== undefined) {
		clearTimeout(controller.maxDeferralTimer);
		controller.maxDeferralTimer = undefined;
	}
}

function clearStreamingSubscription(controller: PostStartupHighlightController): void {
	if (controller.unsubscribeStreaming) {
		try {
			controller.unsubscribeStreaming();
		} catch {
			// Best-effort cleanup.
		}
		controller.unsubscribeStreaming = undefined;
	}
}

function isGateBlocked(host: PostStartupHighlightHost, controller: PostStartupHighlightController): boolean {
	return (
		(!controller.firstPromptSettled && controller.firstPromptPreflightDepth > 0) ||
		host.deferredStartupPending === true ||
		host.deferredStartupPromise !== undefined
	);
}

function isPromptStreamingEvent(event: StreamEventLike | undefined): boolean {
	if (!event) return false;
	return (
		(event.type === "message_start" && event.message?.role === "assistant") ||
		event.type === "message_update" ||
		event.type === "tool_execution_start"
	);
}

function startBackgroundWarmup(host: PostStartupHighlightHost, controller: PostStartupHighlightController): void {
	clearQuietTimer(controller);
	clearMaxDeferralTimer(controller);
	clearStreamingSubscription(controller);
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
		.then(() => {
			// Re-check after microtask hop: a synchronous stop() before this microtask drains must not run runner().
			if (abortController.signal.aborted || host.isShuttingDown || controller.state !== "loading") return;
			return runner(abortController.signal);
		})
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

function armMaxDeferralCap(host: PostStartupHighlightHost, controller: PostStartupHighlightController): void {
	// Anchor the hard deferral cap once on entering waiting_for_gate; never reset it on later turns.
	if (controller.maxDeferralTimer !== undefined) return;
	const timer = setTimeout(() => {
		if (controller.maxDeferralTimer === timer) controller.maxDeferralTimer = undefined;
		if (host.isShuttingDown) {
			stopPostStartupHighlightWarmup(host);
			return;
		}
		if (controller.state === "waiting_for_gate" || controller.state === "quiet_rearm") {
			startBackgroundWarmup(host, controller);
		}
	}, POST_STARTUP_MAX_DEFERRAL_MS);
	timer.unref?.();
	controller.maxDeferralTimer = timer;
}

function scheduleQuietRearm(host: PostStartupHighlightHost, controller: PostStartupHighlightController): void {
	clearQuietTimer(controller);
	controller.state = "quiet_rearm";
	const timer = setTimeout(() => {
		if (controller.quietTimer === timer) controller.quietTimer = undefined;
		if (controller.state !== "quiet_rearm") return;
		if (host.isShuttingDown) {
			stopPostStartupHighlightWarmup(host);
			return;
		}
		if (isGateBlocked(host, controller)) {
			controller.state = "waiting_for_gate";
			armMaxDeferralCap(host, controller);
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
	clearMaxDeferralTimer(controller);
	clearStreamingSubscription(controller);
	controller.abortController?.abort();
	controller.abortController = undefined;
	controller.firstPromptPreflightDepth = 0;
	controller.firstPromptSettled = false;
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
		armMaxDeferralCap(host, controller);
		return;
	}
	startBackgroundWarmup(host, controller);
}

/**
 * Releases the first-prompt dispatch gate as soon as the first provider request has
 * reached the provider and assistant streaming starts, so long multi-step turns get
 * live highlighting and compile-cache warmup during streaming.
 */
export function notifyPostStartupPromptStreaming(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller || controller.firstPromptSettled) return;
	controller.firstPromptSettled = true;
	controller.firstPromptPreflightDepth = 0;
	clearStreamingSubscription(controller);
	maybeRearmFromGate(host, controller);
}

/**
 * Marks the start of a prompt turn; returns an idempotent release function to call in `finally`.
 * Only the first turn's request dispatch (before assistant streaming starts or the turn finishes)
 * holds the gate; subsequent turns never block warmup or reset the quiet timer.
 */
export function beginPostStartupPromptTurn(host: PostStartupHighlightHost): () => void {
	const controller = getOrCreateController(host);
	if (controller.firstPromptSettled) {
		return () => {};
	}
	controller.firstPromptPreflightDepth += 1;
	if (controller.state === "quiet_rearm") {
		clearQuietTimer(controller);
		controller.state = "waiting_for_gate";
		armMaxDeferralCap(host, controller);
	}
	if (controller.unsubscribeStreaming === undefined && typeof host.session?.subscribe === "function") {
		controller.unsubscribeStreaming = host.session.subscribe((event) => {
			if (isPromptStreamingEvent(event)) {
				notifyPostStartupPromptStreaming(host);
			}
		});
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		controller.firstPromptSettled = true;
		controller.firstPromptPreflightDepth = 0;
		clearStreamingSubscription(controller);
		maybeRearmFromGate(host, controller);
	};
}

/** Called when deferred startup finishes (whether it succeeded or failed). */
export function notifyPostStartupDeferredComplete(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller) return;
	maybeRearmFromGate(host, controller);
}

/** Stops any pending timers and aborts any in-flight background warmup. */
export function stopPostStartupHighlightWarmup(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller) return;
	clearQuietTimer(controller);
	clearMaxDeferralTimer(controller);
	clearStreamingSubscription(controller);
	controller.abortController?.abort();
	controller.abortController = undefined;
	controller.state = "stopped";
}
