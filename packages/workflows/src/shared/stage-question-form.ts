/**
 * stage-question-form — the one place a brokered stage question's form is built (#4022).
 *
 * A stage's `ask_user_question` and the readiness gate after its turn show a form through the
 * {@link StageUiBroker}. An in-process stage and a stage on a local worker (whose form the root
 * shows) both build it here from the question's kind and parameters: the tool options of that
 * kind (the readiness gate offers "Chat about this" as an option instead of inline typing), the
 * headless-answer adapter `workflow answer` uses, and the tool run that renders the form and
 * returns its result text (with the chosen option's preview). The two paths cannot drift.
 */
import { createAskUserQuestionToolDefinition, type QuestionnaireResult, type QuestionParams } from "@bastani/atomic";
import type { PiCustomOverlayFactory, PiCustomOverlayOptions } from "../extension/wiring.js";
import { POOLED_CUSTOM_PROMPT_UNAVAILABLE } from "../workers/pooled-prompt-limits.js";
import { buildStagePromptAdapter } from "./stage-prompt.js";
import type { StageUiBroker } from "./stage-ui-broker.js";
import type { PendingPrompt, StageInputKind } from "./store-types.js";
import type { WorkflowSerializableValue, WorkflowUIAdapter } from "./types.js";

type QuestionTool = ReturnType<typeof createAskUserQuestionToolDefinition>;
type QuestionToolExecute = NonNullable<QuestionTool["execute"]>;
/** What the question tool returns: its result text and details, as the agent receives them. */
export type StageQuestionResult = Awaited<ReturnType<QuestionToolExecute>>;

/** The `ask_user_question` tool options of a brokered question kind. */
export function stageQuestionToolOptions(
	kind: StageInputKind,
): Parameters<typeof createAskUserQuestionToolDefinition>[0] {
	// The readiness gate offers "Chat about this" as an option; a question allows inline typing.
	return kind === "readiness_gate" ? { chatAsOption: true } : undefined;
}

const tools = new Map<StageInputKind, QuestionTool>();

/** The question tool that renders a kind's form; the in-process session's own tool for `ask_user_question`. */
export function stageQuestionTool(kind: StageInputKind): QuestionTool {
	let tool = tools.get(kind);
	if (tool === undefined) {
		tool = createAskUserQuestionToolDefinition(stageQuestionToolOptions(kind));
		tools.set(kind, tool);
	}
	return tool;
}

/** Surfaces a question on its stage for headless answers (`workflow answer`); false when its parameters hold none. */
export function provideStageQuestion(
	broker: StageUiBroker,
	runId: string,
	stageId: string,
	promptId: string,
	kind: StageInputKind,
	params: QuestionParams,
): boolean {
	const adapter = buildStagePromptAdapter(promptId, kind, params, Date.now());
	if (adapter === undefined) return false;
	broker.provideStagePrompt(runId, stageId, adapter);
	return true;
}

/**
 * Shows a brokered question's form on its stage. `result` is the tool's run, which settles with its
 * result (undefined when the tool cannot run); `answered` reads the form's raw answer once the user
 * gave one. The form's promise reaches the tool as the broker returns it, so presenting a question
 * here adds no step between the answer and the tool. The caller clears the stage's prompt when it is
 * done with it.
 */
export function presentStageQuestion(input: {
	readonly broker: StageUiBroker;
	readonly runId: string;
	readonly stageId: string;
	readonly promptId: string;
	readonly kind: StageInputKind;
	readonly params: QuestionParams;
	readonly signal: AbortSignal;
}): {
	readonly result: Promise<StageQuestionResult | undefined>;
	readonly answered: () => { readonly value: QuestionnaireResult } | undefined;
} {
	const { broker, runId, stageId, promptId, kind, params, signal } = input;
	let answered: { readonly value: QuestionnaireResult } | undefined;
	const read = () => answered;
	try {
		provideStageQuestion(broker, runId, stageId, promptId, kind, params);
		const execute = stageQuestionTool(kind).execute;
		if (execute === undefined) return { result: Promise.resolve(undefined), answered: read };
		// The tool renders through `ctx.ui.custom`; the stage's broker shows that form on the stage.
		const context = {
			hasUI: true,
			ui: {
				custom: <T>(factory: PiCustomOverlayFactory<T>, options?: PiCustomOverlayOptions): Promise<T> => {
					const value = broker.requestCustomUi(runId, stageId, factory, options, signal);
					value.then(
						(raw) => {
							answered = { value: raw as QuestionnaireResult };
						},
						() => {},
					);
					return value;
				},
			},
		};
		return { result: execute(promptId, params, signal, undefined, context as never), answered: read };
	} catch (error) {
		return { result: Promise.reject(error), answered: read };
	}
}

/**
 * Asks an SDK caller's `ui` a `ctx.ui` prompt that a stage on a local worker raised, with the same
 * call an in-process child's `ctx.ui` makes for it; a custom prompt cannot be shown outside its worker.
 */
export function askStagePromptUi(ui: WorkflowUIAdapter, prompt: PendingPrompt): Promise<WorkflowSerializableValue> {
	// A `ui` method that throws before it returns its promise fails the prompt like one that rejects.
	try {
		return askUi(ui, prompt);
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
}

function askUi(ui: WorkflowUIAdapter, prompt: PendingPrompt): Promise<WorkflowSerializableValue> {
	switch (prompt.kind) {
		case "input":
			return ui.input(prompt.message);
		case "confirm":
			return ui.confirm(prompt.message);
		case "select":
			return ui.select(prompt.message, prompt.choices ?? []);
		case "editor":
			return ui.editor(prompt.initial);
		default:
			return Promise.reject(new Error(POOLED_CUSTOM_PROMPT_UNAVAILABLE));
	}
}
