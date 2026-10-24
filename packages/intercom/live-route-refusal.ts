/**
 * Refusal vocabulary for `register_live_workflow_stage_route`.
 *
 * The broker used one sentence — "owned by another active session" — for every
 * failing precondition, so a stage that started while its workflow owner was
 * reconnecting, or whose capability no longer matched, was reported as a
 * duplicate owner (#3163). Each condition now carries its own code and reason.
 * The code, not the wording, decides whether a stage may try again.
 */

export const LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_CODES = [
	"owner_missing",
	"owner_not_workflow",
	"registrant_not_agent",
	"capability_mismatch",
	"group_mismatch",
	"invalid_stage_key",
	"non_agent_stage_key",
	"duplicate_live_owner",
] as const;

export type LiveWorkflowStageRouteRefusalCode = (typeof LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_CODES)[number];

export const LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_REASONS: Readonly<Record<LiveWorkflowStageRouteRefusalCode, string>> = {
	owner_missing: "Live workflow-stage route has no registered workflow owner",
	owner_not_workflow: "Live workflow-stage route owner is not registered under a workflow invocation group",
	registrant_not_agent: "Live workflow-stage route registrant is not an agent session",
	capability_mismatch: "Live workflow-stage route capability does not match the workflow owner",
	group_mismatch: "Live workflow-stage route registrant is outside the workflow invocation group",
	invalid_stage_key: "Live workflow-stage route keys must be single path segments",
	non_agent_stage_key: "Live workflow-stage route keys name a non-agent workflow node",
	duplicate_live_owner: "Live workflow-stage route is owned by another active session",
};

/**
 * Refusals that a later attempt can legitimately clear without any change on
 * the registrant's side: the owner is re-registering its pending route after a
 * broker reconnect, or the previous attempt's session has not yet been torn
 * down at the broker. Every other code reflects a configuration or authority
 * mismatch that repeats identically on retry.
 */
const TRANSIENT_REFUSAL_CODES: ReadonlySet<LiveWorkflowStageRouteRefusalCode> = new Set([
	"owner_missing",
	"duplicate_live_owner",
]);

export function isLiveWorkflowStageRouteRefusalCode(value: unknown): value is LiveWorkflowStageRouteRefusalCode {
	return (
		typeof value === "string" &&
		(LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_CODES as readonly string[]).includes(value)
	);
}

export function isTransientLiveWorkflowStageRouteRefusal(code: LiveWorkflowStageRouteRefusalCode): boolean {
	return TRANSIENT_REFUSAL_CODES.has(code);
}

/** Broker refusal of a live workflow-stage route registration, classified by construction. */
export class IntercomLiveRouteRefusedError extends Error {
	readonly code: LiveWorkflowStageRouteRefusalCode;
	readonly transient: boolean;

	constructor(code: LiveWorkflowStageRouteRefusalCode, reason: string = LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_REASONS[code]) {
		super(reason);
		this.name = "IntercomLiveRouteRefusedError";
		this.code = code;
		this.transient = isTransientLiveWorkflowStageRouteRefusal(code);
	}
}

/**
 * How long a starting stage keeps waiting out an `owner_missing` refusal. The run's owner
 * registers its route over its own broker connection, which may still be connecting, backing
 * off (up to 30 s) or waiting out 10 s connect and acknowledgement timeouts when the stage
 * starts, so a few quick retries would turn ordinary registration latency into a failed stage
 * (#3904). Past this bound the refusal surfaces as before.
 */
export const LIVE_ROUTE_OWNER_WAIT_MS = 120_000;
const LIVE_ROUTE_OWNER_RETRY_FIRST_MS = 250;
const LIVE_ROUTE_OWNER_RETRY_MAX_MS = 2_000;

/** Delay before the next registration attempt while the owner is missing: doubling, capped at 2 s. */
export function liveRouteOwnerRetryDelayMs(attempt: number): number {
	return Math.min(LIVE_ROUTE_OWNER_RETRY_FIRST_MS * 2 ** attempt, LIVE_ROUTE_OWNER_RETRY_MAX_MS);
}

export function isOwnerMissingRefusal(error: unknown): boolean {
	return error instanceof IntercomLiveRouteRefusedError && error.code === "owner_missing";
}
