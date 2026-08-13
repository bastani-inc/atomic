import { createStructuredOutputCapture, runCallback } from "@bastani/atomic";
import type { Static, TSchema } from "typebox";
import type { StageExecutionMeta } from "../../shared/types.js";
import { StageSessionController } from "./stage-runner-controller.js";
import { assistantArtifactTextForToolCall, assistantMessage } from "./stage-runner-messages.js";
import {
	finalizePromptOutput,
	splitPromptOptions,
	stageOutputInstruction,
	validatePromptOutputOptions,
} from "./stage-runner-output.js";
import {
	formatStructuredOutputCorrectionPrompt,
	STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS,
	STRUCTURED_OUTPUT_MISSING_ERROR,
	type StructuredOutputExecutionCapture,
	stageOptionsWithStructuredOutput,
	stringifyStructuredOutputValue,
} from "./stage-runner-structured-output.js";
import type { InternalStageContext, StageRunnerOpts } from "./stage-runner-types.js";

export function createStageContext(opts: StageRunnerOpts): InternalStageContext {
	const { stageId, stageName, adapters, runId, workflowIntercomGroup, signal, stageOptions, executionMode } = opts;
	const structuredOutputCapture = stageOptions?.schema ? createStructuredOutputCapture<Static<TSchema>>() : undefined;
	const structuredOutputExecutionCapture: StructuredOutputExecutionCapture<Static<TSchema>> | undefined =
		stageOptions?.schema ? {} : undefined;
	const effectiveStageOptions = stageOptionsWithStructuredOutput(
		stageOptions,
		structuredOutputCapture,
		structuredOutputExecutionCapture,
	);
	const meta: StageExecutionMeta = {
		runId,
		stageId,
		stageName,
		...(workflowIntercomGroup === undefined ? {} : { workflowIntercomGroup }),
		signal,
		stageOptions: effectiveStageOptions,
		executionMode,
		...(effectiveStageOptions?.sessionAdapter === undefined
			? {}
			: { sessionAdapter: effectiveStageOptions.sessionAdapter }),
	};
	const controller = new StageSessionController(opts, meta, effectiveStageOptions, structuredOutputCapture);
	let lastAssistantText: string | undefined;
	let lastFinalizedOutput: string | undefined;
	let lastFinalizedMessageCount: number | undefined;
	let structuredArtifactFinalized = false;
	let adapterMessages = [] as InternalStageContext["messages"];

	function runtimeCwd(): string {
		return typeof effectiveStageOptions?.cwd === "string" ? effectiveStageOptions.cwd : process.cwd();
	}

	function finalizedOutputIsCurrent(): boolean {
		return (
			lastFinalizedOutput !== undefined &&
			(structuredArtifactFinalized ||
				lastFinalizedMessageCount === undefined ||
				controller.currentSession?.messages.length === lastFinalizedMessageCount)
		);
	}

	return {
		name: stageName,

		async prompt(text, options) {
			const { sdkOptions, outputOptions } = splitPromptOptions(options);
			validatePromptOutputOptions(outputOptions);
			const hasOutputArtifact = typeof outputOptions.output === "string" && outputOptions.output.length > 0;
			// The runtime owns the artifact write, so it states that contract itself
			// rather than relying on every workflow definition to describe it.
			const promptText = `${text}${stageOutputInstruction(outputOptions, structuredOutputCapture !== undefined)}`;
			if (structuredOutputCapture?.called) {
				throw new Error(
					"atomic-workflows: stage schema supports one prompt() call per stage context because structured_output may be called exactly once. Create a new ctx.stage(...) for each additional schema-backed prompt.",
				);
			}
			if (adapters.prompt) {
				if (structuredOutputCapture) {
					throw new Error(
						"atomic-workflows: stage schema requires an AgentSessionAdapter so the structured_output tool can be registered.",
					);
				}
				const rawText = await runCallback(
					{ kind: "workflow.stage_adapter", name: `prompt:${stageName}`, runId, stageId },
					() => adapters.prompt!.prompt(promptText, meta),
				);
				adapterMessages = assistantMessage(rawText);
				lastAssistantText = await finalizePromptOutput(
					rawText,
					outputOptions,
					runtimeCwd(),
					runId,
					adapterMessages,
				);
				lastFinalizedOutput = lastAssistantText;
				lastFinalizedMessageCount = controller.currentSession?.messages.length;
				return lastAssistantText;
			}
			if (structuredOutputCapture) {
				let nextPrompt = promptText;
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
					nextPrompt = formatStructuredOutputCorrectionPrompt(
						structuredOutputError,
						correctiveAttempts,
						hasOutputArtifact,
					);
				}
				const sessionMessages = controller.currentSession?.messages;
				const executionSnapshot = structuredOutputExecutionCapture?.snapshot;
				if (executionSnapshot === undefined) {
					throw new Error(
						"atomic-workflows: structured_output completed without an execution snapshot; the successful tool call could not be paired with its result.",
					);
				}
				// The exact successful tool-call message owns the artifact. When it
				// carries no ordinary text — or the session no longer holds it after
				// model-fallback recreation — fall back to the last non-structured
				// assistant text so an earlier-turn deliverable is not discarded
				// (issue #2198); only when no prose exists anywhere is the artifact
				// empty, and its receipt then carries the empty-artifact warning.
				const rawOutputText = hasOutputArtifact
					? (assistantArtifactTextForToolCall(sessionMessages ?? [], executionSnapshot.toolCallId) ?? "")
					: stringifyStructuredOutputValue(executionSnapshot.value);
				lastAssistantText = await finalizePromptOutput(
					rawOutputText,
					outputOptions,
					runtimeCwd(),
					runId,
					sessionMessages,
				);
				lastFinalizedOutput = lastAssistantText;
				lastFinalizedMessageCount = controller.currentSession?.messages.length;
				if (hasOutputArtifact) structuredArtifactFinalized = true;
				return executionSnapshot.value as never;
			}
			await controller.promptWithFallback(promptText, sdkOptions);
			const rawText = controller.lastAssistantText(lastAssistantText) ?? "";
			lastAssistantText = await finalizePromptOutput(
				rawText,
				outputOptions,
				runtimeCwd(),
				runId,
				controller.currentSession?.messages,
			);
			lastFinalizedOutput = lastAssistantText;
			lastFinalizedMessageCount = controller.currentSession?.messages.length;
			return lastAssistantText;
		},

		async complete(text, completeOpts) {
			if (adapters.complete) {
				lastFinalizedOutput = undefined;
				lastFinalizedMessageCount = undefined;
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
			lastFinalizedOutput = undefined;
			lastFinalizedMessageCount = undefined;
			lastAssistantText = controller.lastAssistantText(lastAssistantText) ?? "";
			return lastAssistantText;
		},

		async sendUserMessage(text, options) {
			await controller.sendUserMessage(text, options);
		},

		async __sendUserMessage(text, options, beforeDelivery, preparation) {
			return controller.sendUserMessage(text, options, beforeDelivery, preparation);
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

		__subscribeDeliveryActivity(listener) {
			return controller.subscribeDeliveryActivity(listener);
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
			await controller.abort();
		},

		async __dispose() {
			await controller.disposeAll();
		},

		__getLastAssistantText() {
			return finalizedOutputIsCurrent() ? lastFinalizedOutput : controller.lastAssistantText(lastAssistantText);
		},

		getLastAssistantText() {
			return finalizedOutputIsCurrent() ? lastFinalizedOutput : controller.lastAssistantText(lastAssistantText);
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

		__sessionStats() {
			return controller.sessionStats();
		},

		__pendingMessageCount() {
			return controller.pendingMessageCount();
		},

		__settlesQueuedMessages() {
			return controller.settlesQueuedMessages();
		},

		__modelFallbackMeta() {
			return controller.currentModelFallbackMeta();
		},

		async __requestPause() {
			await controller.requestPause();
		},

		async __resume(message, beforeResolve, beforeRelease) {
			return controller.resume(message, beforeResolve, beforeRelease);
		},

		__isPaused() {
			return controller.isPaused();
		},

		__structuredOutputFinalized() {
			return structuredOutputCapture?.called === true;
		},
	};
}
