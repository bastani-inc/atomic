import { createStructuredOutputCapture, runCallback } from "@bastani/atomic";
import type { StageExecutionMeta } from "../../shared/types.js";
import { StageSessionController } from "./stage-runner-controller.js";
import { assistantMessage } from "./stage-runner-messages.js";
import {
  finalizePromptOutput,
  splitPromptOptions,
  validatePromptOutputOptions,
} from "./stage-runner-output.js";
import {
  STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS,
  STRUCTURED_OUTPUT_MISSING_ERROR,
  formatStructuredOutputCorrectionPrompt,
  stageOptionsWithStructuredOutput,
  stringifyStructuredOutputValue,
} from "./stage-runner-structured-output.js";
import type { InternalStageContext, StageRunnerOpts } from "./stage-runner-types.js";

export function createStageContext(opts: StageRunnerOpts): InternalStageContext {
  const { stageId, stageName, adapters, runId, signal, stageOptions, executionMode } = opts;
  const structuredOutputCapture = stageOptions?.schema ? createStructuredOutputCapture<unknown>() : undefined;
  const effectiveStageOptions = stageOptionsWithStructuredOutput(stageOptions, structuredOutputCapture);
  const meta: StageExecutionMeta = { runId, stageId, stageName, signal, stageOptions: effectiveStageOptions, executionMode };
  const controller = new StageSessionController(opts, meta, effectiveStageOptions, structuredOutputCapture);
  let lastAssistantText: string | undefined;
  let adapterMessages = [] as InternalStageContext["messages"];

  function runtimeCwd(): string {
    return typeof effectiveStageOptions?.cwd === "string" ? effectiveStageOptions.cwd : process.cwd();
  }

  return {
    name: stageName,

    async prompt(text, options) {
      const { sdkOptions, outputOptions } = splitPromptOptions(options);
      validatePromptOutputOptions(outputOptions);
      if (structuredOutputCapture?.called) {
        throw new Error("atomic-workflows: stage schema supports one prompt() call per stage context because structured_output may be called exactly once. Create a new ctx.stage(...) for each additional schema-backed prompt.");
      }
      if (adapters.prompt) {
        if (structuredOutputCapture) {
          throw new Error("atomic-workflows: stage schema requires an AgentSessionAdapter so the structured_output tool can be registered.");
        }
        const rawText = await runCallback(
          { kind: "workflow.stage_adapter", name: `prompt:${stageName}`, runId, stageId },
          () => adapters.prompt!.prompt(text, meta),
        );
        lastAssistantText = await finalizePromptOutput(rawText, outputOptions, runtimeCwd());
        adapterMessages = assistantMessage(lastAssistantText);
        return lastAssistantText;
      }
      if (structuredOutputCapture) {
        let nextPrompt = text;
        let correctiveAttempts = 0;
        let structuredOutputError = STRUCTURED_OUTPUT_MISSING_ERROR;
        while (!structuredOutputCapture.called) {
          controller.resetStructuredOutputToolError();
          await controller.promptWithFallback(nextPrompt, sdkOptions);
          if (structuredOutputCapture.called) break;
          structuredOutputError = controller.latestStructuredOutputToolError ?? STRUCTURED_OUTPUT_MISSING_ERROR;
          if (correctiveAttempts >= STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS) {
            throw new Error(structuredOutputError);
          }
          correctiveAttempts += 1;
          nextPrompt = formatStructuredOutputCorrectionPrompt(structuredOutputError, correctiveAttempts);
        }
        const rawStructuredText = stringifyStructuredOutputValue(structuredOutputCapture.value);
        lastAssistantText = await finalizePromptOutput(rawStructuredText, outputOptions, runtimeCwd());
        return structuredOutputCapture.value as never;
      }
      await controller.promptWithFallback(text, sdkOptions);
      const rawText = controller.lastAssistantText(lastAssistantText) ?? "";
      lastAssistantText = await finalizePromptOutput(rawText, outputOptions, runtimeCwd());
      return lastAssistantText;
    },

    async complete(text, completeOpts) {
      if (adapters.complete) {
        lastAssistantText = await runCallback(
          { kind: "workflow.stage_adapter", name: `complete:${stageName}`, runId, stageId },
          () => adapters.complete!.complete(text, completeOpts, meta),
        );
        adapterMessages = assistantMessage(lastAssistantText);
        return lastAssistantText;
      }
      if (
        completeOpts?.model !== undefined ||
        completeOpts?.maxTokens !== undefined ||
        completeOpts?.fallbackModels !== undefined
      ) {
        throw new Error(
          "atomic-workflows: complete options require a CompleteAdapter via RunOpts.adapters.complete",
        );
      }
      await controller.promptWithFallback(text, undefined, "complete");
      lastAssistantText = controller.lastAssistantText(lastAssistantText) ?? "";
      return lastAssistantText;
    },

    async sendUserMessage(text, options) {
      await controller.sendUserMessage(text, options);
    },

    async __sendUserMessage(text, options, beforeDelivery) {
      return controller.sendUserMessage(text, options, beforeDelivery);
    },

    async steer(text) {
      await (await controller.ensureSession()).steer(text);
    },

    async followUp(text) {
      await (await controller.ensureSession()).followUp(text);
    },

    subscribe(listener) {
      return controller.subscribe(listener);
    },

    get sessionFile() {
      return controller.currentSession?.sessionFile;
    },

    get sessionId() {
      return controller.requireSession("sessionId").sessionId;
    },

    async setModel(model) {
      await (await controller.ensureSession()).setModel(model);
    },

    setThinkingLevel(level) {
      controller.setThinkingLevel(level);
    },

    async cycleModel() {
      return (await controller.ensureSession()).cycleModel();
    },

    cycleThinkingLevel() {
      return controller.requireSession("cycleThinkingLevel").cycleThinkingLevel();
    },

    get agent() {
      return controller.requireSession("agent").agent;
    },

    get model() {
      return controller.currentSession?.model;
    },

    get thinkingLevel() {
      return controller.requireSession("thinkingLevel").thinkingLevel;
    },

    get messages() {
      return controller.currentSession?.messages ?? adapterMessages;
    },

    get isStreaming() {
      return controller.currentSession?.isStreaming ?? false;
    },

    async navigateTree(targetId, options) {
      return (await controller.ensureSession()).navigateTree(targetId, options);
    },

    async compact() {
      return (await controller.ensureSession()).compact();
    },

    abortCompaction() {
      controller.currentSession?.abortCompaction();
    },

    async abort() {
      await controller.currentSession?.abort();
    },

    async __dispose() {
      await controller.disposeAll();
    },

    __getLastAssistantText() {
      return controller.lastAssistantText(lastAssistantText);
    },

    getLastAssistantText() {
      return controller.lastAssistantText(lastAssistantText);
    },

    async __ensureSession() {
      await controller.ensureSession();
    },

    async __ensureSessionFromFile(sessionFile) {
      await controller.ensureSessionFromFile(sessionFile);
    },

    __sealGeneration() {
      controller.sealGeneration();
    },

    async __closeGeneration() {
      await controller.closeGeneration();
    },

    __sessionMeta() {
      return controller.sessionMeta();
    },

    __agentSession() {
      return controller.agentSession();
    },

    __pendingMessageCount() {
      return controller.pendingMessageCount();
    },

    __modelFallbackMeta() {
      return controller.currentModelFallbackMeta();
    },

    async __requestPause() {
      await controller.requestPause();
    },

    async __resume(message, beforeResolve) {
      return controller.resume(message, beforeResolve);
    },

    __isPaused() {
      return controller.isPaused();
    },

    __structuredOutputFinalized() {
      return structuredOutputCapture?.called === true;
    },
  };
}
