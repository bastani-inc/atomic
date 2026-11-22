/**
 * Typed state machine that schedules post-startup background work (such as
 * loading non-eager highlight.js grammars and cold compile-cache warmup) so it
 * never fires while deferred startup or any pre-request phase of the first turn
 * is in flight, while guaranteeing bounded deferral once the first provider
 * request has dispatched or streaming has started.
 */
import { onSessionProviderRequestDispatched } from "../../core/provider-request-dispatch.ts";
import { runsInteractiveEngine } from "../interactive-engine/extension-ui-bridge.ts";

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
 * Hard upper bound on deferral once the first provider request has actually been
 * dispatched (at `before-provider-request`) or streaming has started, and deferred
 * startup is complete. Never armed while `deferredStartupPending` is set or any
 * pre-request phase (hooks, OAuth refresh, model discovery, trust dialog) is running.
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
	readonly runtimeHost?: unknown;
	readonly session?: {
		subscribe?(listener: (event: StreamEventLike) => void): () => void;
	};
}

type BackgroundWarmupRunner = (signal: AbortSignal) => Promise<void> | void;

interface PostStartupHighlightController {
	state: PostStartupHighlightState;
	firstPromptPreflightDepth: number;
	firstRequestDispatched: boolean;
	firstPromptSettled: boolean;
	quietTimer: ReturnType<typeof setTimeout> | undefined;
	maxDeferralTimer: ReturnType<typeof setTimeout> | undefined;
	unsubscribeStreaming: (() => void) | undefined;
	unsubscribeDispatch: (() => void) | undefined;
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
			firstRequestDispatched: false,
			firstPromptSettled: false,
			quietTimer: undefined,
			maxDeferralTimer: undefined,
			unsubscribeStreaming: undefined,
			unsubscribeDispatch: undefined,
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

function clearDispatchSubscription(controller: PostStartupHighlightController): void {
	if (controller.unsubscribeDispatch) {
		try {
			controller.unsubscribeDispatch();
		} catch {
			// Best-effort cleanup.
		}
		controller.unsubscribeDispatch = undefined;
	}
}

function isIsolatedHost(host: PostStartupHighlightHost): boolean {
	return runsInteractiveEngine(host.runtimeHost as Parameters<typeof runsInteractiveEngine>[0]);
}

function isDeferredStartupActive(host: PostStartupHighlightHost): boolean {
	return host.deferredStartupPending === true || host.deferredStartupPromise !== undefined;
}

function isGateBlocked(host: PostStartupHighlightHost, controller: PostStartupHighlightController): boolean {
	// Isolated hosts run pre-request work and provider fetches in a separate engine process;
	// keep their host postStartupTimer firing at 500 ms just as before.
	if (isIsolatedHost(host)) return false;
	return (!controller.firstPromptSettled && controller.firstPromptPreflightDepth > 0) || isDeferredStartupActive(host);
}

function canArmMaxDeferralCap(host: PostStartupHighlightHost, controller: PostStartupHighlightController): boolean {
	return (
		!host.isShuttingDown &&
		!isDeferredStartupActive(host) &&
		(controller.firstRequestDispatched || controller.firstPromptSettled)
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
	clearDispatchSubscription(controller);
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

function maybeArmMaxDeferralCap(host: PostStartupHighlightHost, controller: PostStartupHighlightController): void {
	// Anchor the hard deferral cap at most once, and ONLY after deferred startup has finished
	// and the first provider request has dispatched or streaming/settlement has occurred.
	if (controller.maxDeferralTimer !== undefined || !canArmMaxDeferralCap(host, controller)) return;
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
	maybeArmMaxDeferralCap(host, controller);
	const timer = setTimeout(() => {
		if (controller.quietTimer === timer) controller.quietTimer = undefined;
		if (controller.state !== "quiet_rearm") return;
		if (host.isShuttingDown) {
			stopPostStartupHighlightWarmup(host);
			return;
		}
		if (isGateBlocked(host, controller)) {
			controller.state = "waiting_for_gate";
			maybeArmMaxDeferralCap(host, controller);
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
	if (controller.state === "waiting_for_gate") {
		if (!isGateBlocked(host, controller)) {
			scheduleQuietRearm(host, controller);
		} else {
			maybeArmMaxDeferralCap(host, controller);
		}
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
	clearDispatchSubscription(controller);
	controller.abortController?.abort();
	controller.abortController = undefined;
	controller.firstPromptPreflightDepth = 0;
	controller.firstRequestDispatched = false;
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
		maybeArmMaxDeferralCap(host, controller);
		return;
	}
	startBackgroundWarmup(host, controller);
}

/**
 * Called when the first provider request has reached the `before-provider-request`
 * dispatch point (all pre-request phases — deferred startup, hooks, OAuth refresh,
 * model discovery — are done and the transport request is leaving). Now it is safe
 * to arm the hard deferral cap for slow-TTFT providers.
 */
export function notifyPostStartupProviderRequestDispatched(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller || controller.firstRequestDispatched) return;
	controller.firstRequestDispatched = true;
	clearDispatchSubscription(controller);
	if (controller.state === "waiting_for_gate" || controller.state === "quiet_rearm") {
		maybeArmMaxDeferralCap(host, controller);
	}
}

/**
 * Releases the first-prompt dispatch gate as soon as the first provider request has
 * reached the provider and assistant streaming starts, so long multi-step turns get
 * live highlighting and compile-cache warmup during streaming.
 */
export function notifyPostStartupPromptStreaming(host: PostStartupHighlightHost): void {
	const controller = controllers.get(host);
	if (!controller || controller.firstPromptSettled) return;
	controller.firstRequestDispatched = true;
	controller.firstPromptSettled = true;
	controller.firstPromptPreflightDepth = 0;
	clearStreamingSubscription(controller);
	clearDispatchSubscription(controller);
	maybeRearmFromGate(host, controller);
}

/**
 * Marks the start of a prompt turn; returns an idempotent release function to call in `finally`.
 * On isolated hosts and on turns after the first turn settles, this is a no-op so subsequent
 * turns never block warmup or reset the quiet timer.
 */
export function beginPostStartupPromptTurn(host: PostStartupHighlightHost): () => void {
	if (isIsolatedHost(host)) {
		return () => {};
	}
	const controller = getOrCreateController(host);
	if (controller.firstPromptSettled) {
		return () => {};
	}
	controller.firstPromptPreflightDepth += 1;
	if (controller.state === "quiet_rearm") {
		clearQuietTimer(controller);
		controller.state = "waiting_for_gate";
		maybeArmMaxDeferralCap(host, controller);
	}
	if (controller.unsubscribeStreaming === undefined && typeof host.session?.subscribe === "function") {
		controller.unsubscribeStreaming = host.session.subscribe((event) => {
			if (isPromptStreamingEvent(event)) {
				notifyPostStartupPromptStreaming(host);
			}
		});
	}
	if (
		controller.unsubscribeDispatch === undefined &&
		host.session !== undefined &&
		!controller.firstRequestDispatched
	) {
		controller.unsubscribeDispatch = onSessionProviderRequestDispatched(host.session, () => {
			notifyPostStartupProviderRequestDispatched(host);
		});
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		controller.firstPromptSettled = true;
		controller.firstPromptPreflightDepth = 0;
		clearStreamingSubscription(controller);
		clearDispatchSubscription(controller);
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
	clearDispatchSubscription(controller);
	controller.abortController?.abort();
	controller.abortController = undefined;
	controller.state = "stopped";
}
