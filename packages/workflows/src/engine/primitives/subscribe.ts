/** `ctx.subscribe` and `ctx.events`: event streams handled in tracked child stages or inline in the run body. */

import {
	createSubscriberReportTool,
	DEFAULT_SUBSCRIPTION_MAX_CONCURRENT,
	type EventSource,
	type EventSubscriptionHandle,
	formatEventReport,
	isSubscriptionError,
	openEventSubscription,
	SubscriptionClosedError,
	SubscriptionConfigError,
	type SubscriptionEvent,
	type SubscriptionStats,
	seedEventPrompt,
	toolsWithReport,
	validateEventSource,
	validateSubscriptionAdmission,
} from "@bastani/atomic";
import type { DurableWorkflowBackend } from "../../durable/backend.js";
import {
	recordSubscription,
	recordSubscriptionEventProcessed,
	subscriptionEventProcessed,
} from "../../durable/subscription-records.js";
import type { ParallelFailFastScope } from "../../runs/foreground/executor-types.js";
import type {
	WorkflowEventChild,
	WorkflowEventHandler,
	WorkflowEventPrimitives,
	WorkflowEventStream,
	WorkflowEventSubscriber,
	WorkflowEventsOptions,
	WorkflowSubscribeOptions,
	WorkflowSubscription,
	WorkflowTaskOptions,
	WorkflowTaskResult,
} from "../../shared/types.js";
import { classifyFailureFrom } from "../../shared/workflow-failures-classifier.js";

export interface WorkflowEventRuntime {
	readonly runId: string;
	readonly backend: DurableWorkflowBackend;
	/** `ctx.task` that honors a fixed-parent, detached scope. */
	readonly task: (
		name: string,
		options: WorkflowTaskOptions,
		scope: ParallelFailFastScope,
	) => Promise<WorkflowTaskResult>;
	/** Graph parents for event children when no subscriber stage is known. */
	readonly currentParents: () => readonly string[];
	readonly subscriberStageId: (subscriber: WorkflowEventSubscriber) => string | undefined;
	/** Records a report as a run notice when the subscription has no subscriber stage. */
	readonly recordReportNotice: (id: string, message: string) => void;
	/**
	 * Delivers a report into the subscriber stage. A stage replayed from the journal after a resume has no live session,
	 * so its retained session takes the report instead.
	 */
	readonly deliverReport: (
		subscriber: WorkflowEventSubscriber,
		message: string,
		subscriptionId: string,
	) => Promise<void>;
	/** Lets an unobserved subscription failure fail the run. */
	readonly watch: <T>(promise: Promise<T>) => Promise<T>;
}

export interface WorkflowEventPrimitiveSet extends WorkflowEventPrimitives {
	/** Subscriptions and inline streams this run opened; each is tracked work even when no event starts a child. */
	readonly opened: number;
	/** Stops every open source and waits for admitted events, at the end of the run body. */
	closeAndDrain(): Promise<void>;
	/** Cancels every open subscription when the run is cancelled: handlers abort and `done` rejects with `reason`. */
	cancel(reason: unknown): void;
	/** Stops every open source and drops queued events without waiting, when the run fails. */
	stopIntake(reason: unknown): void;
}

function validateName(name: string | undefined, field: string): void {
	if (name !== undefined && (typeof name !== "string" || name.length === 0)) {
		throw new SubscriptionConfigError(field, "not-string");
	}
}

function validateSubscriber(subscriber: WorkflowEventSubscriber | undefined): void {
	if (subscriber === undefined) return;
	const candidate = subscriber as Partial<WorkflowEventSubscriber> | null;
	if (candidate === null || typeof candidate.name !== "string" || typeof candidate.sendUserMessage !== "function") {
		throw new SubscriptionConfigError("options.subscriber", "not-stage");
	}
}

/**
 * A subscription failure keeps the run-level classification of what caused it, so a journal that became unavailable
 * still fails the run as `storage_unavailable` rather than as an unknown failure.
 */
function classifiedFailure(error: unknown): never {
	if (isSubscriptionError(error) && error.cause !== undefined) throw classifyFailureFrom(error, error.cause);
	throw error;
}

export function createWorkflowEventPrimitives(runtime: WorkflowEventRuntime): WorkflowEventPrimitiveSet {
	const ordinals = new Map<string, number>();
	let opened = 0;
	interface OpenSubscription {
		readonly drain: () => Promise<SubscriptionStats>;
		readonly stop: (reason: unknown) => void;
		readonly cancel: (reason: unknown) => void;
	}
	const open = new Set<OpenSubscription>();

	const nextOrdinal = (name: string): number => {
		const ordinal = (ordinals.get(name) ?? 0) + 1;
		ordinals.set(name, ordinal);
		return ordinal;
	};

	const track = (entry: OpenSubscription, done: Promise<SubscriptionStats>): void => {
		open.add(entry);
		const forget = (): void => {
			open.delete(entry);
		};
		void done.then(forget, forget);
	};

	const subscribe = (
		source: EventSource,
		handler: WorkflowEventHandler,
		options: WorkflowSubscribeOptions = {},
	): WorkflowSubscription => {
		validateEventSource(source, "source");
		if (typeof handler !== "function") throw new SubscriptionConfigError("handler", "not-function");
		validateName(options.name, "options.name");
		validateSubscriptionAdmission(options, "options");
		validateSubscriber(options.subscriber);
		opened += 1;
		const name = options.name ?? source.id;
		const ordinal = nextOrdinal(name);
		const key = `${name}#${ordinal}`;
		const id = `${runtime.runId}/${key}`;
		const subscriber = options.subscriber;
		const frontier = Object.freeze([...runtime.currentParents()]);
		const childParents = (): readonly string[] => {
			const subscriberId = subscriber === undefined ? undefined : runtime.subscriberStageId(subscriber);
			return subscriberId === undefined ? frontier : [subscriberId];
		};
		const maxConcurrent = options.maxConcurrent ?? DEFAULT_SUBSCRIPTION_MAX_CONCURRENT;
		const ready = recordSubscription(runtime.backend, runtime.runId, {
			subscription: key,
			source: source.id,
			mode: "child",
			maxConcurrent,
			maxRate: options.maxRate ?? null,
		});
		let reportCount = 0;
		let closed = false;
		const handle: EventSubscriptionHandle = openEventSubscription({
			id,
			source,
			admission: { maxConcurrent, maxRate: options.maxRate },
			ready,
			alreadyProcessed: (eventId) => subscriptionEventProcessed(runtime.backend, runtime.runId, key, eventId),
			handle: async (event) => {
				const childName = `${key}/${encodeURIComponent(event.id)}`;
				const report = async (text: string): Promise<void> => {
					if (typeof text !== "string") throw new SubscriptionConfigError("report.text", "not-string");
					if (closed) throw new SubscriptionClosedError(id, "report");
					const message = formatEventReport(childName, event.id, text);
					if (subscriber === undefined) {
						reportCount += 1;
						runtime.recordReportNotice(`${id}:report:${reportCount}`, message);
					} else {
						await runtime.deliverReport(subscriber, message, id);
					}
					handle.recordReport();
				};
				const child: WorkflowEventChild = {
					name: childName,
					subscriptionId: id,
					event,
					task: (taskOptions) => {
						const { task: instructions, ...rest } = taskOptions;
						return runtime.task(
							childName,
							{
								...rest,
								prompt: seedEventPrompt(rest.prompt ?? instructions ?? "", name, event),
								customTools: [...(rest.customTools ?? []), createSubscriberReportTool(report, "stage")],
								...(rest.tools === undefined ? {} : { tools: toolsWithReport(rest.tools) }),
								durableRestartFromPrompt: true,
							},
							{
								failed: false,
								activeStages: new Map(),
								detached: true,
								get parentIds() {
									return childParents();
								},
							},
						);
					},
					report,
				};
				await handler(event, child);
			},
			recordProcessed: (event) => recordSubscriptionEventProcessed(runtime.backend, runtime.runId, key, event.id),
		});
		const markClosed = (): void => {
			closed = true;
		};
		void handle.done.then(markClosed, markClosed);
		track({ drain: handle.close, stop: handle.stop, cancel: handle.cancel }, handle.done);
		return {
			id: handle.id,
			done: runtime.watch(handle.done.catch(classifiedFailure)),
			stats: handle.stats,
			close: handle.close,
		};
	};

	const events = (source: EventSource, options: WorkflowEventsOptions = {}): WorkflowEventStream => {
		validateEventSource(source, "source");
		validateName(options.name, "options.name");
		validateSubscriptionAdmission({ maxRate: options.maxRate }, "options");
		opened += 1;
		const name = options.name ?? source.id;
		const key = `${name}#${nextOrdinal(name)}`;
		const id = `${runtime.runId}/${key}`;
		const ready = recordSubscription(runtime.backend, runtime.runId, {
			subscription: key,
			source: source.id,
			mode: "inline",
			maxConcurrent: 1,
			maxRate: options.maxRate ?? null,
		});
		const delivered: SubscriptionEvent[] = [];
		let waiting: PromiseWithResolvers<IteratorResult<SubscriptionEvent>> | undefined;
		let current: { readonly release: (processed: boolean) => void } | undefined;
		let ended = false;

		const settleWaiting = (): void => {
			if (waiting === undefined) return;
			const next = delivered.shift();
			if (next !== undefined) {
				waiting.resolve({ value: next, done: false });
				waiting = undefined;
				return;
			}
			if (!ended) return;
			waiting.resolve(observed.then(() => ({ value: undefined, done: true })));
			waiting = undefined;
		};

		const releaseCurrent = (processed: boolean): void => {
			const releasing = current;
			current = undefined;
			releasing?.release(processed);
		};

		const handle = openEventSubscription({
			id,
			source,
			admission: { maxConcurrent: 1, maxRate: options.maxRate },
			ready,
			alreadyProcessed: (eventId) => subscriptionEventProcessed(runtime.backend, runtime.runId, key, eventId),
			handle: async (event) => {
				const released = Promise.withResolvers<boolean>();
				current = { release: released.resolve };
				delivered.push(event);
				settleWaiting();
				return await released.promise;
			},
			recordProcessed: (event) => recordSubscriptionEventProcessed(runtime.backend, runtime.runId, key, event.id),
		});
		const observed = runtime.watch(handle.done.catch(classifiedFailure));
		const markEnded = (): void => {
			ended = true;
			settleWaiting();
		};
		void handle.done.then(markEnded, markEnded);
		const closeStream = (processed: boolean): Promise<SubscriptionStats> => {
			delivered.length = 0;
			releaseCurrent(processed);
			return handle.close({ discardQueued: true });
		};
		const finish = async (): Promise<IteratorResult<SubscriptionEvent>> => {
			await closeStream(true);
			return { value: undefined, done: true };
		};
		track(
			{
				drain: () => closeStream(false),
				stop: (reason) => {
					delivered.length = 0;
					releaseCurrent(false);
					handle.stop(reason);
				},
				cancel: (reason) => {
					delivered.length = 0;
					releaseCurrent(false);
					handle.cancel(reason);
				},
			},
			handle.done,
		);
		const stream: WorkflowEventStream = {
			id,
			stats: handle.stats,
			close: () => closeStream(true),
			next: () => {
				releaseCurrent(true);
				waiting ??= Promise.withResolvers<IteratorResult<SubscriptionEvent>>();
				const result = waiting.promise;
				settleWaiting();
				return result;
			},
			return: finish,
			throw: async (error?: unknown) => {
				await closeStream(false);
				throw error;
			},
			[Symbol.asyncIterator]() {
				return stream;
			},
		};
		return stream;
	};

	return {
		get opened() {
			return opened;
		},
		subscribe,
		events,
		stopIntake: (reason) => {
			for (const entry of open) entry.stop(reason);
		},
		cancel: (reason) => {
			for (const entry of open) entry.cancel(reason);
		},
		closeAndDrain: async () => {
			// A failed subscription already surfaces through its watched `done` or its stream's next(); draining only waits.
			while (open.size > 0) await Promise.allSettled([...open].map((entry) => entry.drain()));
		},
	};
}
