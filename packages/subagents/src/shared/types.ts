/**
 * Type definitions for the subagent extension.
 *
 * This module remains the stable public import path and re-exports the
 * focused sibling modules that hold the concrete type groups and helpers.
 */

export * from "./types-config.js";
export * from "./types-depth.js";
export * from "./types-foreground-state.js";
export * from "./types-output.js";
export * from "./types-results.js";
export * from "./types-runtime.js";

import type { ActivityReport, Cleanup } from "../../../coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../../coding-agent/src/core/tasks/supervisor.js";
import type { AttemptOutcome, TestSessionOptions } from "../runs/inprocess/runner.js";
import type { RunSyncOptions as BaseRunSyncOptions } from "./types-config.js";

/** Optional bridge for an already-admitted task; does not admit or replace execution. */
export interface TaskExecutionHooks {
	signal: AbortSignal;
	reportActivity(report: ActivityReport): void;
	bindTranscript?(source: TaskTranscriptSource): void;
	onExecution(execution: { result: Promise<AttemptOutcome>; cleanup: Promise<Cleanup> }): void;
	yieldTaskWait(reason: "intercom-coordination"): void;
	/** True only while the launching tool call still blocks on this task and can return a handoff as its result. */
	isParentObserving(): boolean;
}

export interface RunSyncOptions extends BaseRunSyncOptions {
	taskExecution?: TaskExecutionHooks;
	testSession?: false | TestSessionOptions;
}
