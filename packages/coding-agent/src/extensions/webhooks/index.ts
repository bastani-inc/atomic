/**
 * The webhooks built-in: the one place where the config file, the reducer and
 * the sender meet.
 *
 * Every other module in this folder is pure. This file owns the three things
 * that are not: which session may send, the reducer's state, and the deliveries
 * in flight.
 *
 * **Ownership.** Every AgentSession builds its own extension runner, so a
 * workflow stage's own LM session loads this built-in again. Without a guard one
 * stage finishing would report "the agent finished" to Slack. The guard is
 * Herdr's, copied rather than reinvented (`../herdr/index.ts`): a closure over
 * the bound runner and session manager, `ownsBinding(ctx)` at the top of every
 * handler, and an admission gate that declines a non-TUI session, a session
 * without UI, a subagent, and anything carrying an orchestration context.
 *
 * **Cancellation, three kinds.** A config change aborts everything in flight,
 * because the destinations the user meant may no longer be the ones being
 * written to. A question answered before its notification left cancels that
 * notification: the reducer reports the key, and aborting its signal is what
 * re-checks it before *every* remaining attempt, since `fetchWithRetry` tests
 * the caller's signal at the top of each attempt and abandons the wait between
 * them. Shutdown drains for a bounded grace and starts nothing new.
 *
 * Delivery never blocks the agent. A send is started and only the shutdown
 * drain ever awaits it; a send that throws is reported, never rethrown into the
 * host's event dispatch.
 */
import { basename } from "node:path";
import { getExtensionContextOwner, publishExtensionContextEffect } from "../../core/extensions/runner-context.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";
import type { WorkflowActivitySubscription } from "../../core/extensions/workflow-events.js";
import { readWebhooksFile, webhooksConfigPath } from "./config.ts";
import { WEBHOOK_SHUTDOWN_GRACE_MS } from "./constants.ts";
import {
	INITIAL_WEBHOOK_REDUCER_STATE,
	reduceWebhookEvent,
	seedWorkflowActivity,
	type WebhookNotification,
	type WebhookReducerEvent,
	type WebhookReducerState,
} from "./events.ts";
import { sendWebhook, type WebhookSendOptions, type WebhookSendOutcome } from "./sender.ts";
import { renderWebhookBody } from "./template.ts";
import type { WebhookDestination, WebhookMessageContext } from "./types.ts";

export interface WebhooksExtensionOptions {
	/** Config path override (tests). */
	readonly configPath?: string;
	/** Transport seam (tests); defaults to the bounded sender. */
	readonly send?: (
		target: WebhookDestination,
		body: string,
		options: WebhookSendOptions,
	) => Promise<WebhookSendOutcome>;
	/** Shutdown drain budget; tests shrink it. */
	readonly shutdownGraceMs?: number;
}

/** A session may send only when it is the real interactive one, not a stage or subagent. */
function admits(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI && !ctx.subagentPolicy && ctx.orchestrationContext === undefined;
}

export function createWebhooksExtension(options: WebhooksExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const send = options.send ?? sendWebhook;
		const graceMs = options.shutdownGraceMs ?? WEBHOOK_SHUTDOWN_GRACE_MS;

		let boundSessionManager: ExtensionContext["sessionManager"] | undefined;
		let boundRunner: object | undefined;
		const retiredRunners = new WeakSet<object>();
		const ownsBinding = (ctx: ExtensionContext) =>
			boundSessionManager !== undefined && getExtensionContextOwner(ctx) === boundRunner;

		let state: WebhookReducerState = INITIAL_WEBHOOK_REDUCER_STATE;
		let destinations: readonly WebhookDestination[] = [];
		let subscription: WorkflowActivitySubscription | undefined;
		let draining = false;
		/** One controller per notification key, so a cancel reaches only its own deliveries. */
		const inFlight = new Map<string, Set<AbortController>>();
		/** Keys cancelled before their delivery started; a cancel can beat the send. */
		const cancelledKeys = new Set<string>();
		/** Notices already shown, keyed by destination and kind, so one broken config says it once. */
		const seenDiagnostics = new Set<string>();
		const settling = new Set<Promise<unknown>>();

		const notifyOnce = (ctx: ExtensionContext, key: string, message: string, kind: "warning" | "error"): void => {
			if (seenDiagnostics.has(key)) return;
			seenDiagnostics.add(key);
			ctx.ui.notify(`Webhooks: ${message}`, kind);
		};

		const abortKey = (key: string): void => {
			for (const controller of inFlight.get(key) ?? []) controller.abort();
			inFlight.delete(key);
		};
		const abortEverything = (): void => {
			for (const key of [...inFlight.keys()]) abortKey(key);
		};

		/**
		 * Read the file and replace the destination list. Any delivery in flight is
		 * abandoned first: it was aimed at the destinations the user has just
		 * changed, and finishing it would write to a target they may have disabled.
		 */
		const loadConfig = (ctx: ExtensionContext): void => {
			abortEverything();
			const result = readWebhooksFile(options.configPath ?? webhooksConfigPath());
			switch (result.kind) {
				case "current":
					destinations = result.destinations;
					for (const diagnostic of result.diagnostics) {
						const label = diagnostic.name ?? `entry ${diagnostic.index}`;
						notifyOnce(
							ctx,
							`config:${label}:${diagnostic.message}`,
							`${label} was skipped. ${diagnostic.message}`,
							"warning",
						);
					}
					if (result.omitted > 0) {
						notifyOnce(ctx, "config:omitted", `${result.omitted} further destinations were skipped.`, "warning");
					}
					return;
				case "absent":
					destinations = [];
					return;
				case "unreadable":
					destinations = [];
					notifyOnce(ctx, "config:unreadable", `${result.path} could not be read (${result.code}).`, "error");
					return;
				case "malformed":
					destinations = [];
					notifyOnce(ctx, "config:malformed", result.message, "error");
					return;
				case "unsupported":
					destinations = [];
					notifyOnce(ctx, "config:unsupported", result.message, "error");
					return;
			}
		};

		/** What the templates need beyond the event itself: who and where, from the live context. */
		const contextFor = (ctx: ExtensionContext, notification: WebhookNotification): WebhookMessageContext => ({
			...notification.context,
			at: Date.now(),
			project: basename(ctx.cwd),
			...(ctx.sessionManager.getSessionName() === undefined ? {} : { session: ctx.sessionManager.getSessionName() }),
			sessionId: ctx.sessionManager.getSessionId(),
			// The model id, not its display name: a receiver routing on it wants the
			// stable identifier, and the id is what every other surface prints.
			...(ctx.model === undefined ? {} : { model: ctx.model.id }),
		});

		const describeOutcome = (destination: WebhookDestination, outcome: WebhookSendOutcome): string | undefined => {
			switch (outcome.kind) {
				case "accepted":
				case "cancelled":
					return undefined;
				case "rejected":
					return `${destination.name} refused the request (HTTP ${outcome.status}). Check its URL and headers in the config file.`;
				case "exhausted":
					return outcome.lastAttemptTimedOut
						? `${destination.name} did not answer in time after ${outcome.attempts} attempts; the notification may still have been delivered.`
						: `${destination.name} could not be reached after ${outcome.attempts} attempts (${outcome.lastFailure}).`;
			}
		};

		/** Start one delivery per subscribed destination. Never awaited by a handler. */
		const deliver = (ctx: ExtensionContext, notification: WebhookNotification): void => {
			if (draining || cancelledKeys.has(notification.key)) return;
			const context = contextFor(ctx, notification);
			for (const destination of destinations) {
				if (!destination.enabled || !destination.events.includes(notification.context.event)) continue;
				const controller = new AbortController();
				const controllers = inFlight.get(notification.key) ?? new Set<AbortController>();
				controllers.add(controller);
				inFlight.set(notification.key, controllers);
				const settled = send(destination, renderWebhookBody(destination, context), { signal: controller.signal })
					.then((outcome) => {
						const message = describeOutcome(destination, outcome);
						if (message !== undefined)
							notifyOnce(ctx, `send:${destination.name}:${outcome.kind}`, message, "warning");
					})
					.catch((error: unknown) => {
						// A throw here is a bug in the sender, not a delivery failure, and
						// it must not surface as an unhandled rejection in the host.
						notifyOnce(
							ctx,
							`send:${destination.name}:internal`,
							`${destination.name} failed unexpectedly: ${error instanceof Error ? error.name : "unknown error"}.`,
							"error",
						);
					})
					.finally(() => {
						controllers.delete(controller);
						if (controllers.size === 0) inFlight.delete(notification.key);
						settling.delete(settled);
					});
				settling.add(settled);
			}
		};

		/** One reduction: advance the state, cancel what is moot, start what is new. */
		const observe = (ctx: ExtensionContext, event: WebhookReducerEvent): void => {
			if (!ownsBinding(ctx)) return;
			const reduction = reduceWebhookEvent(state, event, { now: Date.now(), idle: ctx.isIdle() });
			state = reduction.state;
			for (const key of reduction.cancels) {
				cancelledKeys.add(key);
				abortKey(key);
			}
			for (const notification of reduction.notifications) deliver(ctx, notification);
		};

		const start = (ctx: ExtensionContext): void => {
			const runner = getExtensionContextOwner(ctx);
			if (retiredRunners.has(runner)) return;
			if (boundSessionManager !== undefined && ctx.sessionManager !== boundSessionManager) return;
			if (!admits(ctx)) return;
			if (boundRunner !== undefined && boundRunner !== runner) retiredRunners.add(boundRunner);
			boundRunner = runner;
			boundSessionManager = ctx.sessionManager;
			draining = false;
			state = INITIAL_WEBHOOK_REDUCER_STATE;
			cancelledKeys.clear();
			seenDiagnostics.clear();
			subscription?.dispose();
			loadConfig(ctx);
			// The first frame is the baseline: the roots that were already blocked
			// before this session bound are remembered, never reported. Later changes
			// arrive as workflow_activity_changed events, so this observer deliberately
			// ignores everything except that first snapshot.
			subscription = ctx.observeWorkflowActivity((frame) => {
				if (frame.kind !== "snapshot" || frame.availability !== "ready") return;
				state = seedWorkflowActivity(state, frame.roots);
			});
		};

		pi.on("session_start", (_event, ctx) => publishExtensionContextEffect(ctx, () => start(ctx)));
		pi.on("agent_start", (event, ctx) => observe(ctx, event));
		pi.on("agent_end", (event, ctx) => observe(ctx, event));
		pi.on("agent_settled", (event, ctx) => observe(ctx, event));
		pi.on("ui_prompt_start", (event, ctx) => observe(ctx, event));
		pi.on("ui_prompt_end", (event, ctx) => observe(ctx, event));
		pi.on("workflow_lifecycle", (event, ctx) => observe(ctx, event));
		pi.on("workflow_activity_changed", (event, ctx) => observe(ctx, event));

		pi.on("session_shutdown", async (event, ctx) => {
			if (!ownsBinding(ctx)) return;
			// A non-quit stop may restart this runner unless a successor takes over first.
			if (event.reason === "quit" && boundRunner !== undefined) retiredRunners.add(boundRunner);
			draining = true;
			subscription?.dispose();
			subscription = undefined;
			// Clear the binding before awaiting: a successor can bind while this
			// drain runs, and finishing here must not clear that newer binding.
			boundSessionManager = undefined;
			const pending = [...settling];
			if (pending.length === 0) return;
			// Bounded: a quitting user does not wait on someone else's HTTP server.
			// Whatever has not answered by then is abandoned, and the receiver may
			// still have accepted it, which is why the docs say a duplicate is possible.
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.allSettled(pending),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, graceMs);
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
			abortEverything();
		});
	};
}

export default function webhooksExtension(pi: ExtensionAPI): void {
	createWebhooksExtension()(pi);
}
