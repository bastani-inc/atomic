import { yieldToEventLoop } from "../utils/event-loop.ts";

export type CallbackActivityKind = "extension.hook" | "renderer" | "tool.execute" | "tool.prepare";

export interface CallbackActivity {
	id: string;
	kind: CallbackActivityKind;
	name: string;
	startedAt: number;
	sourcePath?: string;
	toolCallId?: string;
}

export interface CallbackActivityReporter {
	started(activity: CallbackActivity): void | Promise<void>;
	finished(activityId: string): void;
}

export interface CallbackActivityDescriptor {
	kind: CallbackActivityKind;
	name: string;
	sourcePath?: string;
	toolCallId?: string;
}

let reporter: CallbackActivityReporter | undefined;
let nextActivityId = 0;
let pendingCallbackStart: Promise<void> | undefined;

export function setCallbackActivityReporter(next: CallbackActivityReporter | undefined): void {
	reporter = next;
}

function beginActivity(descriptor: CallbackActivityDescriptor):
	| {
			activity: CallbackActivity;
			reporter: CallbackActivityReporter;
			written: Promise<void> | undefined;
	  }
	| undefined {
	const activeReporter = reporter;
	if (!activeReporter) return undefined;
	const activity: CallbackActivity = {
		...descriptor,
		id: `callback_${++nextActivityId}`,
		startedAt: performance.now(),
	};
	const started = activeReporter.started(activity);
	const written = started === undefined ? undefined : started.catch(() => {});
	return { activity, reporter: activeReporter, written };
}

export function runSynchronousCallback<T>(descriptor: CallbackActivityDescriptor, callback: () => T): T {
	const active = beginActivity(descriptor);
	if (!active) return callback();
	try {
		return callback();
	} finally {
		active.reporter.finished(active.activity.id);
	}
}

export async function runCallback<T>(
	descriptor: CallbackActivityDescriptor,
	callback: () => T | Promise<T>,
): Promise<T> {
	if (!reporter) return callback();
	// Let the last healthy heartbeat leave first, then announce the callback
	// immediately before it can run. Announcing before this yield lets later
	// callbacks overtake the attribution while an earlier callback blocks.
	await yieldToEventLoop();
	while (pendingCallbackStart !== undefined) await pendingCallbackStart;
	const active = beginActivity(descriptor);
	if (!active) return callback();
	try {
		if (active.written === undefined) return await callback();
		const starting = Promise.withResolvers<void>();
		pendingCallbackStart = starting.promise;
		let result: T | Promise<T>;
		try {
			await active.written;
			result = callback();
		} finally {
			pendingCallbackStart = undefined;
			starting.resolve();
		}
		return await result;
	} finally {
		active.reporter.finished(active.activity.id);
	}
}
