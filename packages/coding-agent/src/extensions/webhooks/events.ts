/**
 * Turns the host's events into webhook notifications, one per transition.
 *
 * The host fires more than the seven webhook events mean: `agent_end` fires for
 * every loop including nested ones, `agent_settled` fires per prompt
 * completion, a blocked workflow announces itself on two channels, and every
 * lifecycle event is replayed on restore. This reducer is the one place that
 * decides "this is a transition worth a notification", so the sender and the
 * settings screen never have to. It is pure: `reduceWebhookEvent(state, event)`
 * returns the next state, the notifications to send, and the keys whose
 * pending deliveries are now moot (a question answered before the webhook
 * went out). The runtime glue owns the mutable slot; tests drive the function
 * directly with the host's own event shapes.
 *
 * Mapping, from the issue and the decisions on #2345:
 *
 * - Main agent: `agent_end` records the loop's outcome from its final assistant
 *   message; the next `agent_settled` at an idle boundary emits it once as
 *   `agent_finished` (completed) or `agent_stopped` (error or user abort, told
 *   apart by `outcome`). `agent_start` clears it.
 * - Main-chat questions: `ui_prompt_start` with `reason: "ui_prompt"` is
 *   `agent_needs_input`; `/trust` prompts are not. `ui_prompt_end` cancels it.
 *   A workflow stage's question never reaches these hooks, it arrives as a
 *   prompt lifecycle event, so nothing fires twice.
 * - Workflows: a live run-level lifecycle transition of the root run to
 *   completed, failed or blocked; a live prompt `opened` on any run under the
 *   root as `workflow_needs_input`; and, because an active block (provider
 *   failure, budget stop) emits no run-level lifecycle event, the activity
 *   projection's transition into `blocked`/`manual_intervention`. Replayed
 *   events and baseline snapshots are state only, never notifications.
 *
 * Verified against the producers on 2026-09-15 (`workflow-observation-runtime.ts`
 * `capture()`, `store-run-methods.ts` `recordRunBlocked`, `wiring.ts` prompt
 * routing); the plan for #2345 holds the anchors and the harness results.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { redactCredentialShapes } from "../../cli/credential-print.ts";
import type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	UIPromptEndEvent,
	UIPromptStartEvent,
} from "../../core/extensions/agent-events.ts";
import type {
	WorkflowActivityChangedEvent,
	WorkflowActivityReason,
	WorkflowActivityState,
	WorkflowLifecycleEvent,
	WorkflowRootActivity,
} from "../../core/extensions/workflow-events.js";
import { MAX_WEBHOOK_DEDUPE_KEYS } from "./constants.ts";
import type { WebhookEventOutcome, WebhookMessageFields } from "./types.ts";

export type WebhookReducerEvent =
	| AgentStartEvent
	| AgentEndEvent
	| AgentSettledEvent
	| UIPromptStartEvent
	| UIPromptEndEvent
	| WorkflowLifecycleEvent
	| WorkflowActivityChangedEvent;

/** What the glue knows that the event does not. */
export interface WebhookReducerMeta {
	readonly now: number;
	/** `ctx.isIdle()` when a settled event arrives; a nested settle is not a boundary. */
	readonly idle?: boolean;
}

/** One notification to render and send. The glue adds time, project, session and model. */
export interface WebhookNotification {
	/** Produced once per reducer lifetime; also the handle for a later cancel. */
	readonly key: string;
	readonly context: WebhookEventOutcome & Pick<WebhookMessageFields, "runId" | "details">;
}

type AgentOutcome = { readonly outcome: "completed" | "error" | "aborted"; readonly details?: string };
type RootActivity = { readonly state: WorkflowActivityState; readonly reason: WorkflowActivityReason };

export interface WebhookReducerState {
	/** Outcome of the last agent loop, consumed by the next settled event at an idle boundary. */
	readonly lastAgentEnd?: AgentOutcome;
	/** Main-chat prompts seen, so each gets its own key. */
	readonly promptCount: number;
	/** Key of the main-chat prompt currently open, cancelled by `ui_prompt_end`. */
	readonly openPromptKey?: string;
	/** Last activity per workflow root, for the active-blocked transition. */
	readonly roots: ReadonlyMap<string, RootActivity>;
	/** Keys produced so far, oldest first, bounded by MAX_WEBHOOK_DEDUPE_KEYS. */
	readonly delivered: readonly string[];
}

export const INITIAL_WEBHOOK_REDUCER_STATE: WebhookReducerState = {
	promptCount: 0,
	roots: new Map(),
	delivered: [],
};

export interface WebhookReduction {
	readonly state: WebhookReducerState;
	readonly notifications: readonly WebhookNotification[];
	/** Keys whose deliveries, sent or retrying, no longer matter. */
	readonly cancels: readonly string[];
}

/** Baseline from `observeWorkflowActivity`'s first frame: remembered, never notified. */
export function seedWorkflowActivity(
	state: WebhookReducerState,
	roots: readonly WorkflowRootActivity[],
): WebhookReducerState {
	const next = new Map(state.roots);
	for (const root of roots) next.set(root.rootRunId, { state: root.state, reason: root.reason });
	return { ...state, roots: next };
}

export function reduceWebhookEvent(
	state: WebhookReducerState,
	event: WebhookReducerEvent,
	meta: WebhookReducerMeta,
): WebhookReduction {
	switch (event.type) {
		case "agent_start":
			return unchanged({ ...state, lastAgentEnd: undefined });
		case "agent_end": {
			const outcome = agentOutcome(event.messages);
			return unchanged(outcome === undefined ? state : { ...state, lastAgentEnd: outcome });
		}
		case "agent_settled": {
			if (meta.idle !== true || state.lastAgentEnd === undefined) return unchanged(state);
			const { outcome, details } = state.lastAgentEnd;
			const context: WebhookNotification["context"] =
				outcome === "completed"
					? { event: "agent_finished", outcome, ...(details === undefined ? {} : { details }) }
					: { event: "agent_stopped", outcome, ...(details === undefined ? {} : { details }) };
			return emit({ ...state, lastAgentEnd: undefined }, [{ key: `${context.event}:${meta.now}`, context }]);
		}
		case "ui_prompt_start": {
			if (event.reason !== "ui_prompt") return unchanged(state);
			const promptCount = state.promptCount + 1;
			const key = `agent_needs_input:${promptCount}`;
			return emit({ ...state, promptCount, openPromptKey: key }, [
				{
					key,
					context: {
						event: "agent_needs_input",
						outcome: "needs_input",
						...(event.title === undefined ? {} : { details: event.title }),
					},
				},
			]);
		}
		case "ui_prompt_end": {
			if (event.reason !== "ui_prompt" || state.openPromptKey === undefined) return unchanged(state);
			return { state: { ...state, openPromptKey: undefined }, notifications: [], cancels: [state.openPromptKey] };
		}
		case "workflow_lifecycle":
			return reduceLifecycle(state, event);
		case "workflow_activity_changed":
			return reduceActivity(state, event.root, meta.now);
	}
}

function reduceLifecycle(state: WebhookReducerState, event: WorkflowLifecycleEvent): WebhookReduction {
	// Replay is history being re-read on restore or reload, not something happening now.
	if (event.delivery !== "live") return unchanged(state);
	const { target, rootRunId } = event;
	if (target.kind === "prompt") {
		const key = `workflow_needs_input:${target.promptId}`;
		if (target.status === "opened") {
			return emit(state, [
				{ key, context: { event: "workflow_needs_input", outcome: "needs_input", runId: rootRunId } },
			]);
		}
		return { state, notifications: [], cancels: [key] };
	}
	// Only the root run's own terminal transitions; a child run's failure is the parent's to classify.
	if (target.kind !== "run" || target.runId !== rootRunId || target.previousStatus === target.status) {
		return unchanged(state);
	}
	const context = runTransition(target.status, rootRunId);
	if (context === undefined) return unchanged(state);
	return emit(state, [{ key: `${context.event}:${rootRunId}:${event.occurredAt}`, context }]);
}

function runTransition(
	status: WorkflowLifecycleEvent["target"]["status"],
	runId: string,
): WebhookNotification["context"] | undefined {
	switch (status) {
		case "completed":
			return { event: "workflow_completed", outcome: "completed", runId };
		case "failed":
			return { event: "workflow_failed", outcome: "failed", runId };
		case "blocked":
			return { event: "workflow_blocked", outcome: "blocked", runId };
		default:
			return undefined;
	}
}

function reduceActivity(state: WebhookReducerState, root: WorkflowRootActivity, now: number): WebhookReduction {
	const previous = state.roots.get(root.rootRunId);
	const roots = new Map(state.roots);
	roots.set(root.rootRunId, { state: root.state, reason: root.reason });
	const next = { ...state, roots };
	const enteredBlock =
		root.state === "blocked" &&
		root.reason === "manual_intervention" &&
		!(previous?.state === "blocked" && previous.reason === "manual_intervention");
	if (!enteredBlock) return unchanged(next);
	return emit(next, [
		{
			key: `workflow_blocked:${root.rootRunId}:${now}`,
			context: { event: "workflow_blocked", outcome: "blocked", runId: root.rootRunId },
		},
	]);
}

function unchanged(state: WebhookReducerState): WebhookReduction {
	return { state, notifications: [], cancels: [] };
}

/** Records each key, drops any already produced, and keeps the memory bounded. */
function emit(state: WebhookReducerState, candidates: readonly WebhookNotification[]): WebhookReduction {
	const delivered = [...state.delivered];
	const notifications: WebhookNotification[] = [];
	for (const candidate of candidates) {
		if (delivered.includes(candidate.key)) continue;
		delivered.push(candidate.key);
		notifications.push(candidate);
	}
	const kept = delivered.length > MAX_WEBHOOK_DEDUPE_KEYS ? delivered.slice(-MAX_WEBHOOK_DEDUPE_KEYS) : delivered;
	return { state: { ...state, delivered: kept }, notifications, cancels: [] };
}

/**
 * The loop's outcome is on its final assistant message: `stopReason` says how
 * it ended, `errorMessage` says why when it did not. The details excerpt is
 * the error text for a failure (through the credential redactor, since a
 * provider's message can quote a request) and the response text otherwise;
 * the template bounds its length. No assistant message means no loop to
 * report.
 */
function agentOutcome(messages: readonly AgentMessage[]): AgentOutcome | undefined {
	let last: (AgentMessage & { role: "assistant" }) | undefined;
	for (const message of messages) if (message.role === "assistant") last = message;
	if (last === undefined) return undefined;
	const text = last.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	const details = (value: string | undefined) => (value === undefined || value.length === 0 ? {} : { details: value });
	switch (last.stopReason) {
		case "error":
			return { outcome: "error", ...details(last.errorMessage ? redactCredentialShapes(last.errorMessage) : text) };
		case "aborted":
			return { outcome: "aborted", ...details(text) };
		default:
			return { outcome: "completed", ...details(text) };
	}
}
