import type { QuestionnaireResult, QuestionParams } from "@bastani/atomic";
import { currentStageUiBroker, type StageUiBroker } from "../shared/stage-ui-broker.js";
import type { Store } from "../shared/store.js";
import type { PendingPrompt } from "../shared/store-types.js";
import type { PiUISurface } from "./ui-surface.js";

export interface WorkflowHumanInputContext {
	readonly hasUI?: boolean;
	readonly hasHumanInput?: boolean;
	readonly ui?: PiUISurface;
}

// Private runner seam, not a second host contract. The runner retains request
// identity, validation and cancellation ownership across adapter changes.
const WORKFLOW_INPUT = Symbol.for("atomic-coding-agent/workflow-input@1");
interface WorkflowInputBridge {
	active(): boolean;
	available(): boolean;
	bindingRevision(): number;
	subscribe(listener: () => void): () => void;
	scope(
		runId: string,
		stageId: string,
		sessionId?: string,
	): {
		ui: PiUISurface;
		questionnaire(params: QuestionParams, signal?: AbortSignal): Promise<QuestionnaireResult>;
	};
}
export function workflowInputBridge(ui: PiUISurface | undefined): WorkflowInputBridge | undefined {
	return (ui as (PiUISurface & { [WORKFLOW_INPUT]?: WorkflowInputBridge }) | undefined)?.[WORKFLOW_INPUT];
}

/** Live routing only; callbacks are never written into persisted prompt descriptors. */
export interface StageQuestionnaireInput {
	ui: PiUISurface;
	usesOwnBinding(): boolean;
}

/**
 * #3105: a non-presenting host consumes runtime-owned pending descriptors through
 * the runner's validated dialogs. CLI prompts still belong to the attached graph
 * host; background runs must not open dialogs in the main chat.
 */
export function bindWorkflowHumanInput(
	store: Store,
	ctx: WorkflowHumanInputContext,
	stageUiBroker: StageUiBroker = currentStageUiBroker(),
): () => void {
	const ownerInput = workflowInputBridge(ctx.ui);
	const requests = new Map<string, { controller: AbortController; ownBinding: boolean }>();
	const childSubscriptions = new Map<string, () => void>();
	const bindingChanged = (childKey?: string): void => {
		for (const [key, request] of requests) {
			// Rebind only this child, or inherited requests when the parent changes.
			// Closing the workflow owner still retires every live presentation.
			if (childKey === undefined ? request.ownBinding && ownerInput?.active() : key !== childKey) continue;
			request.controller.abort();
			requests.delete(key);
		}
		refresh();
	};
	let disposed = false;
	const refresh = (): void => {
		if (disposed || ownerInput?.active() === false) return;
		const pending = new Set<string>();
		for (const run of store.runs()) {
			if (run.status !== "running" && run.status !== "paused") continue;
			for (const stage of run.stages) {
				if (stage.status !== "awaiting_input") continue;
				const prompt = stage.pendingPrompt;
				const questionnaire = stageUiBroker.peekStageQuestionnaire(run.id, stage.id);
				if (!prompt && !questionnaire) continue;
				const key = `${run.id}\0${stage.id}\0${questionnaire?.requestId ?? prompt!.id}`;
				pending.add(key);
				const childInput = questionnaire?.humanInput;
				if (childInput && !childSubscriptions.has(key)) {
					const unsubscribe = workflowInputBridge(childInput.ui)?.subscribe(() => bindingChanged(key));
					if (unsubscribe) childSubscriptions.set(key, unsubscribe);
				}
				const ownBinding = childInput?.usesOwnBinding() === true;
				const input = ownBinding ? workflowInputBridge(childInput.ui) : ownerInput;
				const available = ownBinding ? input?.available() : ctx.hasUI === false && ctx.hasHumanInput === true;
				if (requests.has(key) || run.status === "paused" || !available) continue;
				const controller = new AbortController();
				requests.set(key, { controller, ownBinding });
				// Defer presentation until the publisher has installed its pending waiter.
				void Promise.resolve().then(async () => {
					if (controller.signal.aborted) return;
					if (store.runs().find((candidate) => candidate.id === run.id)?.status !== "running") {
						if (requests.get(key)?.controller === controller) requests.delete(key);
						controller.abort();
						return;
					}
					try {
						const scoped = input?.scope(run.id, stage.id, questionnaire?.sessionId);
						if (questionnaire) {
							const answer = await scoped?.questionnaire(questionnaire.params, controller.signal);
							if (controller.signal.aborted || !answer || answer.cancelled || answer.error) return;
							if (stageUiBroker.peekStageQuestionnaire(run.id, stage.id)?.requestId !== questionnaire.requestId)
								return;
							stageUiBroker.answerStagePrompt(
								run.id,
								stage.id,
								{ raw: answer },
								{ answerSource: "workflow_ui" },
							);
						} else if (prompt) {
							const answer = await ask(scoped?.ui ?? ctx.ui, prompt, controller.signal);
							if (controller.signal.aborted || answer === undefined) return;
							store.resolveStagePendingPrompt(run.id, stage.id, prompt.id, answer, {
								answerSource: "workflow_ui",
							});
						}
					} catch {
						// Withdrawal, cancellation and malformed replies never settle a durable
						// gate. Keep its descriptor available for explicit answer/resumption.
					}
				});
			}
		}
		for (const [key, { controller }] of requests) {
			if (pending.has(key)) continue;
			controller.abort();
			requests.delete(key);
		}
		for (const [key, unsubscribe] of childSubscriptions) {
			if (pending.has(key)) continue;
			unsubscribe();
			childSubscriptions.delete(key);
		}
	};
	const unsubscribe = store.subscribeInvalidation(refresh);
	const unsubscribeRegistered = stageUiBroker.onStageRequestRegistered(refresh);
	const unsubscribeBinding = ownerInput?.subscribe(bindingChanged);
	refresh();
	return () => {
		disposed = true;
		unsubscribe();
		unsubscribeRegistered();
		unsubscribeBinding?.();
		for (const unsubscribe of childSubscriptions.values()) unsubscribe();
		childSubscriptions.clear();
		for (const { controller } of requests.values()) controller.abort();
		requests.clear();
	};
}

async function ask(ui: PiUISurface | undefined, prompt: PendingPrompt, signal: AbortSignal): Promise<unknown> {
	switch (prompt.kind) {
		case "input":
			return ui?.input?.(prompt.message, undefined, { signal });
		case "confirm":
			return ui?.confirm?.("Workflow approval", prompt.message, { signal });
		case "select":
			return ui?.select?.(prompt.message, [...(prompt.choices ?? [])], { signal });
		case "editor":
			return ui?.editor?.(prompt.message, prompt.initial, { signal });
		default:
			return undefined;
	}
}
