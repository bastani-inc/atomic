/** `ctx.subscribe` and `ctx.events`: event streams handled in tracked child stages or inline in the run body. */

import {
	DEFAULT_SUBSCRIPTION_MAX_CONCURRENT,
	defineTool,
	type EventSource,
	type EventSubscriptionHandle,
	formatEventReport,
	openEventSubscription,
	SUBSCRIPTION_REPORT_TOOL_NAME,
	SubscriptionClosedError,
	SubscriptionConfigError,
	type SubscriptionEvent,
	type SubscriptionStats,
	seedEventPrompt,
	validateEventSource,
	validateSubscriptionAdmission,
} from "@bastani/atomic";
import { Type } from "typebox";
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
	/** Lets an unobserved subscription failure fail the run. */
	readonly watch: <T>(promise: Promise<T>) => Promise<T>;
}

export interface WorkflowEventPrimitiveSet extends WorkflowEventPrimitives {
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
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		typeof candidate.name !== "string" ||
		typeof candidate.sendUserMessage !== "function"
	) {
		throw new SubscriptionConfigError("options.subscriber", "not-stage");
	}
}

const reportParameters = Type.Object({ text: Type.String({ description: "The report: a few sentences at most." }) });

function reportTool(report: (text: string) => Promise<void>) {
	return defineTool({
		name: SUBSCRIPTION_REPORT_TOOL_NAME,
		label: "Report to subscriber",
		description:
			"Send a short report about this event to the stage that subscribed to it. Call it at most once, and only when the event matters.",
		parameters: reportParameters,
		async execute(_toolCallId, params) {
			await report(params.text);
			return { content: [{ type: "text", text: "Report delivered to the subscriber." }], details: undefined };
		},
	});
}

export function createWorkflowEventPrimitives(runtime: WorkflowEventRuntime): WorkflowEventPrimitiveSet {
	const ordinals = new Map<string, number>();
	interface OpenSubscription {
		readonly drain: () => Promise<SubscriptionStats>;
		readonly stop: (reason: unknown) => void;
		readonly cancel: (reason: unknown) => void;
	}
	const open = new Set<OpenSubscription>();

	const nextKey = (name: string): string => {
		const ordinal = (ordinals.get(name) ?? 0) + 1;
		ordinals.set(name, ordinal);
		return `${name}#${ordinal}`;
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
		const name = options.name ?? source.id;
		const key = nextKey(name);
		const id = `${runtime.runId}/${key}`;
		const subscriber = options.subscriber;
		const subscriberId = subscriber === undefined ? undefined : runtime.subscriberStageId(subscriber);
		const parentIds = Object.freeze(subscriberId === undefined ? [...runtime.currentParents()] : [subscriberId]);
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
			admission: { maxConcurrent, ...(options.maxRate === undefined ? {} : { maxRate: options.maxRate }) },
			ready,
			alreadyProcessed: (eventId) => subscriptionEventProcessed(runtime.backend, runtime.runId, key, eventId),
			handle: async (event) => {
				const childName = `${name}/${event.id}`;
				const report = async (text: string): Promise<void> => {
					if (typeof text !== "string") throw new SubscriptionConfigError("report.text", "not-string");
					if (closed) throw new SubscriptionClosedError(id, "report");
					const message = formatEventReport(childName, event.id, text);
					if (subscriber === undefined) {
						reportCount += 1;
						runtime.recordReportNotice(`${id}:report:${reportCount}`, message);
					} else {
						await subscriber.sendUserMessage(message, { deliverAs: "steer" });
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
								customTools: [...(rest.customTools ?? []), reportTool(report)],
							},
							{ failed: false, activeStages: new Map(), parentIds, detached: true },
						);
					},
					report,
				};
				await handler(event, child);
				await recordSubscriptionEventProcessed(runtime.backend, runtime.runId, key, event.id);
			},
		});
		const markClosed = (): void => {
			closed = true;
		};
		void handle.done.then(markClosed, markClosed);
		track({ drain: handle.close, stop: handle.stop, cancel: handle.cancel }, handle.done);
		return {
			id: handle.id,
			done: runtime.watch(handle.done),
			stats: handle.stats,
			close: handle.close,
		};
	};

	const events = (source: EventSource, options: WorkflowEventsOptions = {}): WorkflowEventStream => {
		validateEventSource(source, "source");
		validateName(options.name, "options.name");
		validateSubscriptionAdmission(
			options.maxRate === undefined ? undefined : { maxRate: options.maxRate },
			"options",
		);
		const name = options.name ?? source.id;
		const key = nextKey(name);
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
		let closing = false;
		let observed: Promise<SubscriptionStats> | undefined;

		const settleWaiting = (): void => {
			if (waiting === undefined) return;
			const next = delivered.shift();
			if (next !== undefined) {
				waiting.resolve({ value: next, done: false });
				waiting = undefined;
				return;
			}
			if (!ended || observed === undefined) return;
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
			admission: { maxConcurrent: 1, ...(options.maxRate === undefined ? {} : { maxRate: options.maxRate }) },
			ready,
			alreadyProcessed: (eventId) => subscriptionEventProcessed(runtime.backend, runtime.runId, key, eventId),
			handle: async (event) => {
				if (closing) return;
				const released = Promise.withResolvers<boolean>();
				current = { release: released.resolve };
				delivered.push(event);
				settleWaiting();
				if (await released.promise) {
					await recordSubscriptionEventProcessed(runtime.backend, runtime.runId, key, event.id);
				}
			},
		});
		observed = runtime.watch(handle.done);
		const markEnded = (): void => {
			ended = true;
			settleWaiting();
		};
		void handle.done.then(markEnded, markEnded);
		const closeStream = (processed: boolean): Promise<SubscriptionStats> => {
			closing = true;
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
