import type {
  RecordStagePromptAnswerOptions,
  ResolveStagePendingPromptOptions,
  Store,
} from "./store-public-types.js";
import type { PendingPrompt } from "./store-types.js";
import { isTerminalStageStatus, TERMINAL_STATUSES, type StoreContext } from "./store-internal.js";

type PromptStoreMethods = Pick<
  Store,
  | "recordPendingPrompt"
  | "resolvePendingPrompt"
  | "awaitPendingPrompt"
  | "recordStagePendingPrompt"
  | "resolveStagePendingPrompt"
  | "awaitStagePendingPrompt"
  | "recordStagePromptAnswer"
  | "recordStagePromptDraft"
  | "getStagePromptDraft"
  | "clearStagePromptDraft"
  | "getStagePromptAnswer"
  | "clearStagePromptAnswer"
>;

export function createPromptStoreMethods(context: StoreContext): PromptStoreMethods {
  const { state } = context;

  return {
    recordPendingPrompt(runId: string, prompt: PendingPrompt): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (run.pendingPrompt !== undefined) return false;
      run.pendingPrompt = { ...prompt };
      context.bumpAndNotify();
      return true;
    },

    resolvePendingPrompt(runId: string, promptId: string, response: unknown): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const pending = run.pendingPrompt;
      if (!pending || pending.id !== promptId) return false;
      run.pendingPrompt = undefined;
      // Notify first so observers see the cleared state before the waiter resumes the workflow body.
      context.bumpAndNotify();
      const entry = state.resolvers.get(promptId);
      if (entry) {
        state.resolvers.delete(promptId);
        entry.resolve(response);
      }
      return true;
    },

    awaitPendingPrompt(runId: string, promptId: string): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const run = context.findRun(runId);
        if (!run) {
          reject(new Error(`atomic-workflows: run "${runId}" not found`));
          return;
        }
        const pending = run.pendingPrompt;
        if (!pending || pending.id !== promptId) {
          reject(new Error(`atomic-workflows: pending prompt "${promptId}" not registered on run "${runId}"`));
          return;
        }
        state.resolvers.set(promptId, { promptId, resolve, reject });
      });
    },

    recordStagePendingPrompt(runId: string, stageId: string, prompt: PendingPrompt): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      if (isTerminalStageStatus(stage.status)) return false;
      if (stage.pendingPrompt !== undefined) return false;
      stage.pendingPrompt = { ...prompt };
      stage.promptFootprint = { ...prompt };
      stage.status = "awaiting_input";
      stage.awaitingInputSince = prompt.createdAt;
      context.bumpAndNotify();
      return true;
    },

    resolveStagePendingPrompt(
      runId: string,
      stageId: string,
      promptId: string,
      response: unknown,
      options: ResolveStagePendingPromptOptions = {},
    ): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      const pending = stage.pendingPrompt;
      if (!pending || pending.id !== promptId) return false;
      state.stagePromptDrafts.delete(context.stagePromptDraftKey(runId, stageId, promptId));
      if (options.recordAnswer !== false) {
        state.stagePromptAnswers.set(context.stagePromptAnswerKey(runId, stageId), {
          runId,
          stageId,
          promptId,
          kind: pending.kind,
          value: response,
          answeredAt: Date.now(),
          ...(options.answerSource !== undefined ? { answerSource: options.answerSource } : {}),
        });
        stage.promptAnswerState = "available";
      } else {
        state.stagePromptAnswers.delete(context.stagePromptAnswerKey(runId, stageId));
        delete stage.promptAnswerState;
      }
      stage.pendingPrompt = undefined;
      if (stage.status === "awaiting_input") {
        stage.status = "running";
        delete stage.awaitingInputSince;
      }
      context.bumpAndNotify();
      const entry = state.resolvers.get(promptId);
      if (entry) {
        state.resolvers.delete(promptId);
        entry.resolve(response);
      }
      return true;
    },

    awaitStagePendingPrompt(runId: string, stageId: string, promptId: string): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const run = context.findRun(runId);
        if (!run) {
          reject(new Error(`atomic-workflows: run "${runId}" not found`));
          return;
        }
        const stage = context.findStage(run, stageId);
        if (!stage) {
          reject(new Error(`atomic-workflows: stage "${stageId}" not found on run "${runId}"`));
          return;
        }
        const pending = stage.pendingPrompt;
        if (!pending || pending.id !== promptId) {
          reject(
            new Error(
              `atomic-workflows: pending prompt "${promptId}" not registered on stage "${stageId}" in run "${runId}"`,
            ),
          );
          return;
        }
        state.resolvers.set(promptId, { promptId, resolve, reject });
      });
    },

    recordStagePromptAnswer(
      runId: string,
      stageId: string,
      prompt: PendingPrompt,
      response: unknown,
      options: RecordStagePromptAnswerOptions = {},
    ): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      if (isTerminalStageStatus(stage.status)) return false;
      state.stagePromptAnswers.set(context.stagePromptAnswerKey(runId, stageId), {
        runId,
        stageId,
        promptId: prompt.id,
        kind: prompt.kind,
        value: response,
        answeredAt: Date.now(),
        ...(options.answerSource !== undefined ? { answerSource: options.answerSource } : {}),
      });
      if (stage.promptFootprint === undefined) stage.promptFootprint = { ...prompt };
      stage.promptAnswerState = "available";
      if (stage.status === "awaiting_input") {
        stage.status = "running";
        delete stage.awaitingInputSince;
      }
      context.bumpAndNotify();
      return true;
    },

    recordStagePromptDraft(runId: string, stageId: string, promptId: string, text: string): boolean {
      if (context.stageHasActiveTextPrompt(runId, stageId, promptId) === undefined) return false;
      state.stagePromptDrafts.set(context.stagePromptDraftKey(runId, stageId, promptId), text);
      return true;
    },

    getStagePromptDraft(runId: string, stageId: string, promptId: string): string | undefined {
      if (context.stageHasActiveTextPrompt(runId, stageId, promptId) === undefined) return undefined;
      return state.stagePromptDrafts.get(context.stagePromptDraftKey(runId, stageId, promptId));
    },

    clearStagePromptDraft(runId: string, stageId: string, promptId: string): boolean {
      return state.stagePromptDrafts.delete(context.stagePromptDraftKey(runId, stageId, promptId));
    },

    getStagePromptAnswer(runId: string, stageId: string) {
      return state.stagePromptAnswers.get(context.stagePromptAnswerKey(runId, stageId));
    },

    clearStagePromptAnswer(runId: string, stageId: string): void {
      const removed = state.stagePromptAnswers.delete(context.stagePromptAnswerKey(runId, stageId));
      const run = context.findRun(runId);
      const stage = run ? context.findStage(run, stageId) : undefined;
      const clearAvailabilityMarker = stage?.promptAnswerState === "available";
      if (clearAvailabilityMarker) {
        delete stage.promptAnswerState;
      }
      if (removed || clearAvailabilityMarker) {
        context.bumpAndNotify();
      }
    },
  };
}
