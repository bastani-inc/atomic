import { yieldToEventLoop } from "../utils/event-loop.ts";

export type CallbackActivityKind =
	| "extension.hook"
	| "renderer"
	| "tool.execute"
	| "tool.prepare"
	| "workflow.ctx_tool"
	| "workflow.run"
	| "workflow.stage_adapter";

export interface CallbackActivity {
	id: string;
	kind: CallbackActivityKind;
	name: string;
	startedAt: number;
	sourcePath?: string;
	toolCallId?: string;
	runId?: string;
	stageId?: string;
}

export interface CallbackActivityReporter {
	started(activity: CallbackActivity): void;
	finished(activityId: string): void;
}

export interface CallbackActivityDescriptor {
	kind: CallbackActivityKind;
	name: string;
	sourcePath?: string;
	toolCallId?: string;
	runId?: string;
	stageId?: string;
}

let reporter: CallbackActivityReporter | undefined;
let nextActivityId = 0;

export function setCallbackActivityReporter(next: CallbackActivityReporter | undefined): void {
	reporter = next;
}

function beginActivity(descriptor: CallbackActivityDescriptor):
	| {
			activity: CallbackActivity;
			reporter: CallbackActivityReporter;
	  }
	| undefined {
	const activeReporter = reporter;
	if (!activeReporter) return undefined;
	const activity: CallbackActivity = {
		...descriptor,
		id: `callback_${++nextActivityId}`,
		startedAt: performance.now(),
	};
	activeReporter.started(activity);
	return { activity, reporter: activeReporter };
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
	const active = beginActivity(descriptor);
	if (!active) return callback();
	try {
		return await callback();
	} finally {
		active.reporter.finished(active.activity.id);
	}
}
