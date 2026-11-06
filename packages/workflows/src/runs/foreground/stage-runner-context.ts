import { createStructuredOutputCapture, runCallback } from "@bastani/atomic";
import type { Static, TSchema } from "typebox";
import { RESUME_CONTINUATION_PROMPT } from "../../shared/resume-continuation.js";
import type { StageExecutionMeta, StageOutputOptions } from "../../shared/types.js";
import { StageSessionController } from "./stage-runner-controller.js";
import {
	assistantArtifactTextForGeneration,
	assistantArtifactTextForToolCall,
	assistantMessage,
} from "./stage-runner-messages.js";
import {
	finalizePromptOutput,
	splitPromptOptions,
	stageOutputInstruction,
	validatePromptOutputOptions,
} from "./stage-runner-output.js";
import { agentSessionAdapterDefaultCwd } from "./stage-runner-session-options.js";
import {
	formatStructuredOutputCorrectionPrompt,
	isStructuredOutputContractFailure,
	STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS,
	STRUCTURED_OUTPUT_MISSING_ERROR,
	type StructuredOutputExecutionCapture,
	stageOptionsWithStructuredOutput,
	stringifyStructuredOutputValue,
	WorkflowStructuredOutputContractError,
} from "./stage-runner-structured-output.js";
import type { InternalStageContext, LiveInternalStageContext, StageRunnerOpts } from "./stage-runner-types.js";

export function createStageContext(opts: StageRunnerOpts): LiveInternalStageContext {
	const { stageId, stageName, adapters, runId, workflowIntercomGroup, signal, stageOptions, executionMode } = opts;
	const stageCwd =
		stageOptions?.cwd ??
		stageOptions?.sessionManager?.getCwd() ??
		agentSessionAdapterDefaultCwd(adapters.agentSession) ??
		opts.defaultCwd ??
		process.cwd();
	const structuredOutputCapture = stageOptions?.schema ? createStructuredOutputCapture<Static<TSchema>>() : undefined;
	const structuredOutputExecutionCapture: StructuredOutputExecutionCapture<Static<TSchema>> | undefined =
		stageOptions?.schema ? {} : undefined;
	const effectiveStageOptions = stageOptionsWithStructuredOutput(
		adapters.sessionStore === undefined ||
			stageOptions?.sessionStore !== undefined ||
			stageOptions?.sessionDir !== undefined ||
			stageOptions?.sessionManager !== undefined
			? stageOptions
			: { ...stageOptions, sessionStore: adapters.sessionStore },
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
	};
	const controller = new StageSessionController(
		{ ...opts, defaultCwd: stageCwd },
		meta,
		effectiveStageOptions,
		structuredOutputCapture,
	);
	let lastAssistantText: string | undefined;
	let lastFinalizedOutput: string | undefined;
	let lastFinalizedMessageCount: number | undefined;
	let structuredArtifactFinalized = false;
	let adapterMessages = [] as InternalStageContext["messages"];
	let artifactOptions: StageOutputOptions | undefined;
	let artifactClosed = false;
	let artifactText: string | undefined;
	let continuing = false;

	async function exportArtifact(): Promise<string> {
		const text = assistantArtifactTextForGeneration(controller.outputGenerationMessages());
		if (text !== artifactText || lastFinalizedOutput === undefined) {
			lastFinalizedOutput = await finalizePromptOutput(
				text,
				artifactOptions!,
				stageCwd,
				runId,
				controller.currentSession?.messages,
			);
			artifactText = text;
			lastAssistantText = lastFinalizedOutput;
		}
		return lastFinalizedOutput!;
	}

	function finalizedOutputIsCurrent(): boolean {
		if (lastFinalizedOutput === undefined) return false;
		if (artifactOptions !== undefined || structuredArtifactFinalized) return true;
		return (
			lastFinalizedMessageCount === undefined ||
			controller.currentSession?.messages.length === lastFinalizedMessageCount
		);
	}

	return {
		name: stageName,

		async prompt(text, options) {
			if (continuing && artifactOptions) options = { ...options, ...artifactOptions };
			const { sdkOptions, outputOptions } = splitPromptOptions(options);
			validatePromptOutputOptions(outputOptions);
			const hasOutputArtifact = typeof outputOptions.output === "string" && outputOptions.output.length > 0;
			// The runtime owns the artifact write, so it states that contract itself
			// rather than relying on every workflow definition to describe it.
			const outputInstruction = stageOutputInstruction(outputOptions, structuredOutputCapture !== undefined);
			const promptText = `${text}${outputInstruction}`;
			// What a call a durable resume replays inside its turn sends, unless the turn already holds its answer.
			const continuationText = `${RESUME_CONTINUATION_PROMPT}${outputInstruction}`;
			if (structuredOutputCapture?.called) {
				throw new Error(
					"atomic-workflows: stage schema supports one prompt() call per stage context because structured_output may be called exactly once. Create a new ctx.stage(...) for each additional schema-backed prompt.",
				);
			}
			if (!continuing) {
				controller.beginOutputGeneration(hasOutputArtifact && !structuredOutputCapture && !adapters.prompt);
				artifactOptions = undefined;
				artifactClosed = false;
				artifactText = undefined;
				if (effectiveStageOptions?.model === "auto") await controller.preparePrompt(promptText);
			}
			if (hasOutputArtifact && !structuredOutputCapture && !adapters.prompt) artifactOptions = outputOptions;
			if (adapters.prompt) {
				if (structuredOutputCapture) {
					throw new Error(
						"atomic-workflows: stage schema requires an AgentSessionAdapter so the structured_output tool can be registered.",
					);
				}
				const rawText = await runCallback(
					{ kind: "workflow.stage_adapter", name: `prompt:${stageName}`, runId, stageId },
					() => {
						controller.assertAutoExecutionCurrent();
						return adapters.prompt!.prompt(promptText, meta);
					},
				);
				if (typeof rawText !== "string") return rawText as never;
				adapterMessages = assistantMessage(rawText);
				lastAssistantText = await finalizePromptOutput(rawText, outputOptions, stageCwd, runId, adapterMessages);
				lastFinalizedOutput = lastAssistantText;
				lastFinalizedMessageCount = controller.currentSession?.messages.length;
				return lastAssistantText;
			}
			if (structuredOutputCapture) {
				let structuredOutputError = STRUCTURED_OUTPUT_MISSING_ERROR;
				let executionFailure: string | undefined;
				// One correction budget per model candidate. A candidate that spends
				// the whole budget without capturing a structured result has failed,
				// however clean its turns looked, so it fails over on the same chain
				// rate limits use and the next candidate starts again from the
				// original stage prompt (issue #2812).
				while (!structuredOutputCapture.called) {
					let nextPrompt = promptText;
					let newSessionPrompt: string | undefined;
					let correctiveAttempts = 0;
					controller.beginStructuredOutputCandidateCycle();
					while (!structuredOutputCapture.called) {
						controller.resetStructuredOutputToolError();
						await controller.promptWithFallback(
							nextPrompt,
							sdkOptions,
							undefined,
							newSessionPrompt,
							continuationText,
						);
						if (structuredOutputCapture.called) break;
						structuredOutputError = controller.structuredOutputFailureReason();
						executionFailure ??= controller.structuredOutputExecutionFailure();
						if (!isStructuredOutputContractFailure(structuredOutputError))
							executionFailure ??= structuredOutputError;
						if (correctiveAttempts >= STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS) break;
						correctiveAttempts += 1;
						nextPrompt = formatStructuredOutputCorrectionPrompt(
							structuredOutputError,
							correctiveAttempts,
							hasOutputArtifact,
						);
						// A retry that lands in a new session re-sends the stage prompt
						// ahead of the correction (issue #3323).
						newSessionPrompt = `${promptText}\n\n${nextPrompt}`;
					}
					if (structuredOutputCapture.called) break;
					if (!(await controller.failCandidateForStructuredOutputExhaustion(structuredOutputError))) {
						throw executionFailure === undefined
							? new WorkflowStructuredOutputContractError(structuredOutputError)
							: new Error(executionFailure);
					}
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
					stageCwd,
					runId,
					sessionMessages,
				);
				lastFinalizedOutput = lastAssistantText;
				lastFinalizedMessageCount = controller.currentSession?.messages.length;
				if (hasOutputArtifact) structuredArtifactFinalized = true;
				return executionSnapshot.value as never;
			}
			await controller.promptWithFallback(promptText, sdkOptions, undefined, undefined, continuationText);
			if (artifactOptions) return (await exportArtifact()) as never;
			const rawText = controller.lastAssistantText(lastAssistantText) ?? "";
			lastAssistantText = await finalizePromptOutput(
				rawText,
				outputOptions,
				stageCwd,
				runId,
				controller.currentSession?.messages,
			);
			lastFinalizedOutput = lastAssistantText;
			lastFinalizedMessageCount = controller.currentSession?.messages.length;
			return lastAssistantText;
		},

		async __continuePrompt(text) {
			continuing = true;
			try {
				return await this.prompt(text);
			} finally {
				continuing = false;
			}
		},

		async complete(text, completeOpts) {
			artifactOptions = undefined;
			if (adapters.complete) {
				if (effectiveStageOptions?.model === "auto" && completeOpts?.model === undefined)
					await controller.preparePrompt(text);
				lastFinalizedOutput = undefined;
				lastFinalizedMessageCount = undefined;
				lastAssistantText = await runCallback(
					{ kind: "workflow.stage_adapter", name: `complete:${stageName}`, runId, stageId },
					() => {
						controller.assertAutoExecutionCurrent();
						return adapters.complete!.complete(text, completeOpts, meta);
					},
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
			if (controller.holdWhileReleased(text, "steer")) return;
			if (effectiveStageOptions?.model === "auto") await controller.preparePrompt(text);
			await (await controller.ensureSession()).steer(text);
		},

		async followUp(text) {
			if (controller.holdWhileReleased(text, "followUp")) return;
			if (effectiveStageOptions?.model === "auto") await controller.preparePrompt(text);
			await (await controller.ensureSession()).followUp(text);
		},

		async __queueUserText(text, kind, options) {
			if (controller.holdWhileReleased(text, kind, options)) return;
			if (effectiveStageOptions?.model === "auto") await controller.preparePrompt(text);
			const session = await controller.ensureSession();
			if (kind === "steer") await session.steer(text, undefined, options);
			else await session.followUp(text, undefined, options);
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
			return controller.releasedSessionId() ?? controller.requireSession("sessionId").sessionId;
		},

		async setModel(model) {
			await controller.setModel(model);
		},

		async setThinkingLevel(level) {
			await controller.setThinkingLevel(level);
		},

		async cycleModel() {
			return (await controller.ensureSession()).cycleModel();
		},

		cycleThinkingLevel() {
			return controller.requireSession("cycleThinkingLevel").cycleThinkingLevel();
		},

		get agent() {
			controller.throwIfReleased("agent");
			return controller.requireSession("agent").agent;
		},

		get model() {
			const released = controller.releasedModelSettings();
			if (released === undefined) return controller.currentSession?.model;
			// A stage a resumed run starts released never saw its session's values: it says so instead of undefined.
			if (released.model === undefined) controller.throwIfReleased("model");
			return released.model;
		},

		get thinkingLevel() {
			const released = controller.releasedModelSettings();
			if (released === undefined) return controller.requireSession("thinkingLevel").thinkingLevel;
			if (released.thinkingLevel === undefined) controller.throwIfReleased("thinkingLevel");
			return released.thinkingLevel as InternalStageContext["thinkingLevel"];
		},

		get messages() {
			controller.throwIfReleased("messages");
			return controller.currentSession?.messages ?? adapterMessages;
		},

		async readMessages() {
			if (controller.sessionReleased()) return controller.readReleasedMessages();
			return controller.currentSession?.messages ?? adapterMessages;
		},

		__residentMessages() {
			return controller.currentSession?.messages ?? adapterMessages;
		},

		get isStreaming() {
			return controller.currentSession?.isStreaming ?? false;
		},

		async navigateTree(targetId, options) {
			return controller.navigateTree(targetId, options);
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

		async release() {
			await controller.release();
		},

		async rehydrate() {
			await controller.rehydrate();
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
			if (controller.awaitingAutoPrompt || controller.isReleased()) return;
			await controller.ensureSession();
		},

		async __ensureSessionFromId(sessionId) {
			await controller.ensureSessionFromId(sessionId);
		},

		__sealGeneration(closedForGood) {
			controller.sealGeneration(closedForGood);
		},

		async __closeGeneration(closedForGood) {
			await controller.closeGeneration(closedForGood);
			if (artifactOptions && !artifactClosed) {
				await exportArtifact();
				artifactClosed = true;
			}
			return artifactOptions ? lastFinalizedOutput : undefined;
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

		__persistedSessionStore() {
			return controller.persistedSessionStore();
		},

		__idleForRelease() {
			return controller.isIdleForRelease();
		},

		__turnLoopBusy() {
			return controller.isTurnLoopBusy();
		},

		__generationClosedUnderStage() {
			return controller.generationClosedUnderStage();
		},

		async __queueIntoLiveTurn(text, kind, options) {
			// The stage's current session, without waiting for a creation still in flight (#3996).
			const session = controller.currentSession;
			if (session?.isStreaming !== true) return false;
			if (kind === "steer") await session.steer(text, undefined, options);
			else await session.followUp(text, undefined, options);
			return true;
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

		__isReleased() {
			return controller.isReleased();
		},

		__holdsInput() {
			return controller.holdsInput();
		},

		__releaseIdle() {
			return controller.releaseIdle();
		},

		__releaseForPrompt() {
			return controller.releaseForPrompt();
		},

		__idleSince() {
			return controller.idleSince();
		},

		__startReleased(wait, sessionId) {
			controller.resumeReleased(wait, sessionId);
		},
	};
}
