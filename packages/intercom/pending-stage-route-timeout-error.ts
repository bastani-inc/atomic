import { IntercomBrokerTimeoutError } from "./recoverable-disconnect.js";

export type IntercomPendingStageRouteTimeoutCode = "pending_stage_route_timeout";

/** The step that was waiting: the broker's answer to a workflow run's pending-stage route registration. */
export type IntercomPendingStageRouteTimeoutPhase = "pending-stage-route-registration";

const PENDING_STAGE_ROUTE_TIMEOUT_HINT =
	"Resume the run, and Intercom registers its route again; run `atomic intercom restart` if the broker keeps timing out.";

export interface IntercomPendingStageRouteTimeoutFields {
	readonly runId: string;
	/** Rows of the stage roster the registration carried; never the rows themselves. */
	readonly stageCount: number;
	readonly timeoutMs: number;
	/**
	 * Whole milliseconds from writing the registration to the bound expiring, on the monotonic clock; past `timeoutMs`
	 * when the event loop was late.
	 */
	readonly elapsedMs: number;
}

/**
 * The broker accepted a workflow run's pending-stage route registration but did not acknowledge it within its bound.
 * It is an {@link IntercomBrokerTimeoutError}, so every recoverable-disconnect check still recognizes it; `cause` is
 * the failed broker health check when the connection was given up as well.
 */
export class IntercomPendingStageRouteTimeoutError extends IntercomBrokerTimeoutError {
	override readonly name = "IntercomPendingStageRouteTimeoutError" as const;
	readonly code: IntercomPendingStageRouteTimeoutCode = "pending_stage_route_timeout";
	readonly phase: IntercomPendingStageRouteTimeoutPhase = "pending-stage-route-registration";
	readonly retryable = true as const;
	readonly hint = PENDING_STAGE_ROUTE_TIMEOUT_HINT;
	readonly runId: string;
	readonly stageCount: number;
	readonly timeoutMs: number;
	readonly elapsedMs: number;

	constructor(fields: IntercomPendingStageRouteTimeoutFields, options?: ErrorOptions) {
		super(
			`Pending-stage route registration timed out: run ${fields.runId} with ${fields.stageCount} roster stages, unanswered after ${fields.elapsedMs} ms of ${fields.timeoutMs} ms (pending_stage_route_timeout). ${PENDING_STAGE_ROUTE_TIMEOUT_HINT}`,
			options,
		);
		this.runId = fields.runId;
		this.stageCount = fields.stageCount;
		this.timeoutMs = fields.timeoutMs;
		this.elapsedMs = fields.elapsedMs;
	}
}

/** True for an {@link IntercomPendingStageRouteTimeoutError}, including one from another realm, by `name` and `code`. */
export function isIntercomPendingStageRouteTimeoutError(value: unknown): value is IntercomPendingStageRouteTimeoutError {
	if (value instanceof IntercomPendingStageRouteTimeoutError) return true;
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return name === "IntercomPendingStageRouteTimeoutError" && code === "pending_stage_route_timeout";
}
