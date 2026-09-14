/** Startup observations are not model progress or evidence of an attached session. */
export type StageStartupPhase =
	| "model-resolution"
	| "route-authority"
	| "resource-preparation"
	| "reload-queued"
	| "reload-active"
	| "sdk-creation"
	| "extension-binding"
	| "session-attachment"
	| "delivery-readiness"
	| "ready"
	| "first-dispatch";

export interface StageStartupSnapshot {
	readonly phase: StageStartupPhase;
	readonly startedAt: number;
	readonly phaseStartedAt: number;
	readonly settledAt?: number;
	readonly state: "active" | "cancelled" | "failed" | "dispatched";
	/** A cancelled consumer does not release the underlying asynchronous owner. */
	readonly ownershipPending: boolean;
}

export function formatStageStartup(startup: StageStartupSnapshot, now = Date.now()): string {
	const observedAt = startup.state === "dispatched" ? startup.phaseStartedAt : (startup.settledAt ?? now);
	const age = Math.max(0, Math.floor((observedAt - startup.phaseStartedAt) / 1000));
	const total = Math.max(0, Math.floor((observedAt - startup.startedAt) / 1000));
	const recovery =
		startup.state === "cancelled" && startup.ownershipPending
			? "; cleanup pending — do not retry in-process; stop the owning Atomic process before fresh execution"
			: "";
	return `startup ${startup.phase} (${total}s total, ${age}s on current step; ${startup.state})${recovery}`;
}
