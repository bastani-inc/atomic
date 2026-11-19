import type { WorkflowModelAttempt } from "../../shared/types.js";
import type { WorkflowResolvedModelCandidate } from "../shared/model-fallback.js";
import type { StageSessionEvent } from "./stage-runner-types.js";

/**
 * One prompt's turn while the stage moves it from model candidate to model candidate. The stage replaces the session a
 * failed candidate ran in, so nothing in the next session's events says that the turn goes on. The stage says so with
 * the events a session's own model fallback sends: `model_fallback_start` before the next candidate's request, once a
 * request of this prompt failed, and `model_fallback_end` (not successful) when the prompt ends, or pauses, before
 * that request starts. A stage chat then counts the turn's time and tokens from its start across the switch, and ends
 * the count when the switch never reaches a request; a later prompt starts its own count.
 */
export class StageFallbackTurn {
	/** Requests started when the turn last announced a switch, or when it began. */
	private runsAnnounced: number;
	private switching = false;

	constructor(
		private readonly runsStarted: () => number,
		private readonly emit: (event: StageSessionEvent) => void,
	) {
		this.runsAnnounced = runsStarted();
	}

	/** The turn's next request goes to `to`'s new session; `failed` is the attempt it moves on from. */
	switchTo(to: WorkflowResolvedModelCandidate, attempt: number, failed: WorkflowModelAttempt | undefined): void {
		const runs = this.runsStarted();
		// Before any request of this prompt there is no turn to continue; one switch is announced per failed request.
		if (runs === this.runsAnnounced) return;
		this.runsAnnounced = runs;
		this.switching = true;
		this.emit({
			type: "model_fallback_start",
			from: failed?.model ?? "",
			to: to.id,
			...(failed?.reasoningLevel === undefined ? {} : { fromThinkingLevel: failed.reasoningLevel }),
			...(to.reasoningLevel === undefined ? {} : { toThinkingLevel: to.reasoningLevel }),
			reason: failed?.error ?? "",
			attempt,
		});
	}

	/** The prompt is over, or paused: a switch whose request has not started ends the turn here. */
	ended(): void {
		if (!this.switching || this.runsStarted() > this.runsAnnounced) return;
		this.switching = false;
		this.emit({ type: "model_fallback_end", success: false });
	}
}
