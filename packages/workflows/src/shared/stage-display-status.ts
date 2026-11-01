import type { StageStartupPhase } from "./stage-startup.js";
import type { StageSnapshot, StageStatus } from "./store-types.js";

/**
 * How a stage's state reads to the user. A stage on a local worker whose session has not started yet
 * reads as `queued`: it has nothing to chat with until then (#3996). Display only; the stage's stored
 * status stays `running`.
 */
export type StageDisplayStatus = StageStatus | "queued";

const STARTUP_STEP_TEXT: Record<StageStartupPhase, string> = {
	"model-resolution": "resolving model",
	"route-authority": "waiting for model route",
	"resource-preparation": "loading resources",
	"reload-queued": "waiting to reload resources",
	"reload-active": "reloading resources",
	"sdk-creation": "creating session",
	"extension-binding": "binding extensions",
	"session-attachment": "attaching session",
	"delivery-readiness": "preparing message delivery",
	ready: "session ready",
	"first-dispatch": "session ready",
};

/** The fields of a stage, or of a summary of one, that say whether its session has started. */
export type StageStartupView = Pick<
	StageSnapshot,
	"status" | "workerExecution" | "startup" | "nodeKind" | "workflowChild" | "workflowChildRun"
>;

/** Whether `stage` runs on a local worker and is still starting its session. */
export function isPooledStageStarting(stage: StageStartupView | undefined): boolean {
	if (stage === undefined || stage.workerExecution === undefined || stage.status !== "running") return false;
	if (stage.nodeKind === "tool" || stage.workflowChild !== undefined || stage.workflowChildRun !== undefined)
		return false;
	const startup = stage.startup;
	return startup !== undefined && startup.state === "active" && startup.phase !== "ready";
}

export function stageDisplayStatus(stage: StageStartupView): StageDisplayStatus {
	return isPooledStageStarting(stage) ? "queued" : stage.status;
}

/** What a stage on a local worker is doing before its session starts (`creating session`); undefined once it has. */
export function pooledStageStartingStep(stage: StageStartupView | undefined): string | undefined {
	const startup = stage?.startup;
	if (startup === undefined || !isPooledStageStarting(stage)) return undefined;
	return STARTUP_STEP_TEXT[startup.phase];
}

/**
 * What a stage on a local worker is doing before its session starts, with how long it has been
 * starting: `creating session 32s`. Undefined once the session has started.
 */
export function pooledStageStartingText(stage: StageStartupView | undefined, now = Date.now()): string | undefined {
	const step = pooledStageStartingStep(stage);
	if (step === undefined || stage?.startup === undefined) return undefined;
	const seconds = Math.max(0, Math.floor((now - stage.startup.startedAt) / 1000));
	return `${step} ${seconds}s`;
}
