/** `session.subscribe(source, handler)`: session-level event subscriptions with short-lived child sessions. */

import type { AgentSessionInternalSurface as AgentSession } from "../agent-session-methods.ts";
import type { CreateAgentSessionOptions } from "../sdk-types.ts";
import {
	type EventSubscriptionHandle,
	openEventSubscription,
	validateEventSource,
	validateSubscriptionAdmission,
} from "./admission.js";
import { SubscriptionChildUnavailableError, SubscriptionClosedError, SubscriptionConfigError } from "./errors.js";
import { createSubscriberReportTool, formatEventReport, seedEventPrompt, toolsWithReport } from "./prompts.js";
import type { EventSource, Subscription, SubscriptionAdmission, SubscriptionEvent } from "./types.js";

/** Custom message type of a report delivered into the subscribing session. */
export const EVENT_REPORT_MESSAGE_TYPE = "event_report";
/** Session entry recording a subscription; it never enters model context. */
export const EVENT_SUBSCRIPTION_ENTRY_TYPE = "event_subscription";
/** Session entry recording one processed event id; it never enters model context. */
export const EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE = "event_subscription_processed";

export interface SessionEventTaskOptions
	extends Pick<CreateAgentSessionOptions, "model" | "thinkingLevel" | "tools" | "noTools" | "excludedTools"> {
	/** The subscriber's handling instructions; the event is appended. */
	readonly prompt: string;
}

export interface SessionEventTaskResult {
	readonly text: string;
	readonly sessionId: string;
}

/** One event's short-lived child, handed to the `session.subscribe` handler. */
export interface SessionEventChild {
	readonly name: string;
	readonly subscriptionId: string;
	readonly event: SubscriptionEvent;
	/**
	 * Runs a short-lived child session seeded with the event and `options.prompt`. The child gets a
	 * `report_to_subscriber` tool that calls `report`, and is disposed when it finishes.
	 */
	task(options: SessionEventTaskOptions): Promise<SessionEventTaskResult>;
	/** Delivers a short report into the subscribing session. Call it only when the event matters. */
	report(text: string): Promise<void>;
}

export type SessionEventHandler = (event: SubscriptionEvent, child: SessionEventChild) => void | Promise<void>;

export interface SessionSubscribeOptions extends SubscriptionAdmission {
	/** Names the subscription. Its children are named `<name>#<n>/<event id>`. Defaults to the source id. */
	readonly name?: string;
}

export interface EventReportDetails {
	readonly subscriptionId: string;
	readonly eventId: string;
	readonly child: string;
}

interface ProcessedEntryData {
	readonly subscription?: string;
	readonly eventId?: string;
}

const ordinalsBySession = new WeakMap<object, Map<string, number>>();
const openBySession = new WeakMap<object, Set<EventSubscriptionHandle>>();

/** Cancels every open subscription of a closing session. Their `done` promises reject with an AbortError. */
export function cancelSessionSubscriptions(session: AgentSession): void {
	const open = openBySession.get(session);
	if (open === undefined) return;
	const reason = new DOMException("The subscribing session closed", "AbortError");
	for (const handle of [...open]) handle.cancel(reason);
}

function processedIds(session: AgentSession, subscription: string): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE) continue;
		const data = entry.data as ProcessedEntryData | undefined;
		if (data?.subscription === subscription && typeof data.eventId === "string") ids.add(data.eventId);
	}
	return ids;
}

function attachCleanupCause(primary: unknown, cleanupCause: unknown): void {
	if (Object.isExtensible(primary)) {
		Object.defineProperty(primary as object, "cleanupCause", { value: cleanupCause, enumerable: false });
	}
}

/**
 * Runs `work`, then `dispose`. When `work` failed, a disposal failure is attached to its error as `cleanupCause`
 * instead of replacing it; after a successful `work`, a disposal failure propagates.
 */
export async function runThenDispose<T>(work: () => Promise<T>, dispose: () => Promise<void>): Promise<T> {
	let result: T;
	try {
		result = await work();
	} catch (error) {
		await dispose().catch((cleanupCause: unknown) => attachCleanupCause(error, cleanupCause));
		throw error;
	}
	await dispose();
	return result;
}

async function runChildSession(
	options: CreateAgentSessionOptions,
	prompt: string,
	signal: AbortSignal,
): Promise<SessionEventTaskResult> {
	signal.throwIfAborted();
	const { createAgentSession } = await import("../sdk.ts");
	const { session: child } = await createAgentSession(options);
	let aborting: Promise<void> = Promise.resolve();
	let abortFailure: { readonly error: unknown } | undefined;
	const abortChild = (): void => {
		aborting = child.abort().then(undefined, (error: unknown) => {
			abortFailure = { error };
		});
	};
	signal.addEventListener("abort", abortChild, { once: true });
	return await runThenDispose(
		async () => {
			signal.throwIfAborted();
			await child.prompt(prompt);
			signal.throwIfAborted();
			return { text: child.getLastAssistantText() ?? "", sessionId: child.sessionId };
		},
		async () => {
			signal.removeEventListener("abort", abortChild);
			await aborting;
			await child.dispose();
			if (abortFailure !== undefined) throw abortFailure.error;
		},
	);
}

/** Implements `AgentSession.subscribe(source, handler, options?)`. */
export function subscribeSession(
	session: AgentSession,
	source: EventSource,
	handler: SessionEventHandler | undefined,
	options: SessionSubscribeOptions = {},
): Subscription {
	validateEventSource(source, "source");
	if (typeof handler !== "function") throw new SubscriptionConfigError("handler", "not-function");
	const eventHandler = handler;
	if (options.name !== undefined && (typeof options.name !== "string" || options.name.length === 0)) {
		throw new SubscriptionConfigError("options.name", "not-string");
	}
	validateSubscriptionAdmission(options, "options");
	if (session._disposed)
		throw new SubscriptionClosedError(`${session.sessionId}/${options.name ?? source.id}`, "subscribe");
	const name = options.name ?? source.id;
	let ordinals = ordinalsBySession.get(session);
	if (ordinals === undefined) {
		ordinals = new Map();
		ordinalsBySession.set(session, ordinals);
	}
	const ordinal = (ordinals.get(name) ?? 0) + 1;
	ordinals.set(name, ordinal);
	const key = `${name}#${ordinal}`;
	const id = `${session.sessionId}/${key}`;
	const processed = processedIds(session, key);
	const ready = session.sessionManager
		.appendCustomEntry(EVENT_SUBSCRIPTION_ENTRY_TYPE, {
			subscription: key,
			source: source.id,
			...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
			...(options.maxRate === undefined ? {} : { maxRate: { ...options.maxRate } }),
		})
		.then(() => undefined);
	let closed = false;
	const handle = openEventSubscription({
		id,
		source,
		admission: options,
		ready,
		alreadyProcessed: (eventId) => processed.has(eventId),
		handle: async (event, signal) => {
			const childName = `${key}/${encodeURIComponent(event.id)}`;
			const report = async (text: string): Promise<void> => {
				if (typeof text !== "string") throw new SubscriptionConfigError("report.text", "not-string");
				if (closed) throw new SubscriptionClosedError(id, "report");
				const details: EventReportDetails = { subscriptionId: id, eventId: event.id, child: childName };
				await session.sendCustomMessage(
					{
						customType: EVENT_REPORT_MESSAGE_TYPE,
						content: formatEventReport(childName, event.id, text),
						display: true,
						details,
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
				handle.recordReport();
			};
			const child: SessionEventChild = {
				name: childName,
				subscriptionId: id,
				event,
				task: async (taskOptions) => {
					const resolve = session._childSessionOptions;
					if (resolve === undefined) throw new SubscriptionChildUnavailableError(id, session.sessionId);
					const { SessionManager } = await import("../session-manager.ts");
					const { prompt, ...childOptions } = taskOptions;
					return await runChildSession(
						resolve({
							...childOptions,
							...(childOptions.tools === undefined ? {} : { tools: toolsWithReport(childOptions.tools) }),
							sessionManager: SessionManager.inMemory(session._cwd),
							customTools: [createSubscriberReportTool(report, "session")],
						}),
						seedEventPrompt(prompt, name, event),
						signal,
					);
				},
				report,
			};
			await eventHandler(event, child);
		},
		recordProcessed: async (event) => {
			await session.sessionManager.appendCustomEntry(EVENT_SUBSCRIPTION_PROCESSED_ENTRY_TYPE, {
				subscription: key,
				eventId: event.id,
			});
		},
	});
	let open = openBySession.get(session);
	if (open === undefined) {
		open = new Set();
		openBySession.set(session, open);
	}
	const sessionOpen = open;
	sessionOpen.add(handle);
	const markClosed = (): void => {
		closed = true;
		sessionOpen.delete(handle);
	};
	void handle.done.then(markClosed, markClosed);
	return { id: handle.id, done: handle.done, stats: handle.stats, close: handle.close };
}
