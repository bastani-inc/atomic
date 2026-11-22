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

import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import type {
	ActivityReport,
	Cleanup,
	TaskElapsedSpan,
	TaskId,
} from "../../../coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../../coding-agent/src/core/tasks/supervisor.js";
import type { AttemptOutcome, TestSessionOptions } from "../runs/inprocess/runner.js";
import type { RunSyncOptions as BaseRunSyncOptions } from "./types-config.js";

/** Optional bridge for an already-admitted task; does not admit or replace execution. */
export interface TaskExecutionHooks {
	readonly taskId?: TaskId;
	signal: AbortSignal;
	reportActivity(report: ActivityReport): void;
	bindTranscript?(source: TaskTranscriptSource & { readonly settledReply?: AssistantMessage }): void;
	/** Record (or, with `undefined`, remove) one extension status written by the child session's extensions. */
	setExtensionStatus?(statusKey: string, text: string | undefined): void;
	/** The child session ended: drop the statuses it set. */
	clearExtensionStatuses?(): void;
	bindChildSession?(session: { sessionId: string; sessionFile: string | undefined }): void;
	/** The model and thinking level the child's session started on, and the session's leaf entry at that moment. */
	bindChildLaunch?(launch: {
		model: string | undefined;
		thinking: string | undefined;
		leafId: string | null;
		leafSeq?: number;
	}): void;
	/** `late`: they were read in the notice of results that came after their calls were answered. */
	toolResultsSaved?(toolCallIds: readonly string[], late?: boolean): void;
	/** The child's session saved the notices of these finished background tasks held for it. */
	noticesSaved?(completionIds: readonly string[]): void;
	/**
	 * The user paused the child from its chat (Esc), or its next turn started after that: recorded so a restart restores
	 * it as it was. A pause reports the leaf entry of the child's session it was taken at (`null` for an empty session),
	 * and settles once its record is saved: `false` when it could not be.
	 */
	reportTurnPaused?(paused: boolean, leafId?: string | null): Promise<boolean> | undefined;
	/** Where the child is in its start, until its first turn starts; `undefined` once it has, or the start ended. */
	reportStart?(progress: import("../runs/shared/start-progress.js").SubagentStartProgress | undefined): void;
	onExecution(execution: { result: Promise<AttemptOutcome>; cleanup: Promise<Cleanup> }): void;
}

export interface RunSyncOptions extends BaseRunSyncOptions {
	/** The dispatcher starts this span; all attempts and results of that execution share it. */
	readonly elapsedSpan?: TaskElapsedSpan;
	/** Save a fresh observation when this span stops or a new turn starts on the same task. */
	readonly onElapsedSpanChanged?: () => void;
	taskExecution?: TaskExecutionHooks;
	testSession?: false | TestSessionOptions;
}
