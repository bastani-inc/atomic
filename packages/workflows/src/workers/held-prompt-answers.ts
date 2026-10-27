import type { StageInputAnswer } from "../shared/stage-prompt.js";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { PendingPrompt, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { PooledStageQuestion } from "./stage-watch-types.js";

/** What became of a prompt: the user's response, or the error its root UI failed with. */
export type HeldPromptOutcome = { readonly response: WorkflowSerializableValue } | { readonly error: string };

/** What became of a brokered question: the user's answer, or the error its form host failed with. */
export type HeldQuestionOutcome = { readonly answer: StageInputAnswer } | { readonly error: string };

/** An answer the user gave a pooled stage's prompt, or its UI's failure, that its attempt never received. */
type HeldAnswer =
	| ({
			readonly kind: "prompt";
			readonly generation: number;
			readonly promptId: string;
			readonly identity: string;
	  } & HeldPromptOutcome)
	| ({
			readonly kind: "question";
			readonly generation: number;
			readonly promptId: string;
			readonly identity: string;
	  } & HeldQuestionOutcome);

/** What the user was asked by a `ctx.ui` prompt, whatever attempt asked it. */
export function promptIdentity(prompt: PendingPrompt): string {
	return JSON.stringify([prompt.kind, prompt.message, prompt.choices ?? null, prompt.initial ?? null]);
}

/** What the user was asked by a brokered question: its tool call and its exact parameters. */
export function questionIdentity(question: PooledStageQuestion): string {
	return JSON.stringify([question.promptId, question.kind, question.params]);
}

/**
 * Answers to prompts of pooled stages that reached an attempt after it died (#4022), by run and
 * stage, and failures of the root UI that showed them, refused the same way. The replacement attempt
 * asks the same prompt again; the held answer or failure goes to that prompt once, so the user is
 * not asked twice and a failed prompt is not shown again. A replacement that asks something else, a stage that
 * ends, and an attempt that is still live and moved on discard it: a held answer only ever goes
 * to the same question on a later attempt.
 */
export class HeldPromptAnswers {
	private readonly held = new Map<string, HeldAnswer & { readonly runId: string }>();

	hold(runId: string, stageId: string, answer: HeldAnswer): void {
		this.held.set(JSON.stringify([runId, stageId]), { ...answer, runId });
	}

	/** Discards a held answer the stage's latest publication, by attempt `generation`, shows is no longer wanted. */
	settle(runId: string, stage: StageSnapshot, generation: number): void {
		const key = JSON.stringify([runId, stage.id]);
		const held = this.held.get(key);
		if (held === undefined) return;
		if (isTerminalStageStatus(stage.status)) {
			this.held.delete(key);
			return;
		}
		// The attempt that refused it is live and no longer asks it: it was answered there after all.
		if (generation === held.generation) {
			if (stage.pendingPrompt?.id !== held.promptId && stage.inputRequest?.id !== held.promptId)
				this.held.delete(key);
			return;
		}
		if (generation < held.generation) return;
		// A later attempt asks something else first: show that, never answer it with this.
		const asksOther =
			held.kind === "prompt"
				? stage.inputRequest !== undefined ||
					(stage.pendingPrompt !== undefined && promptIdentity(stage.pendingPrompt) !== held.identity)
				: stage.pendingPrompt !== undefined ||
					(stage.inputRequest !== undefined && stage.inputRequest.id !== held.promptId);
		if (asksOther) this.held.delete(key);
	}

	/**
	 * Discards the held answers of `runId` whose stage a later attempt's publication no longer has
	 * while it asks something else: a replacement that asks a different question at the same point
	 * publishes it as a new prompt stage, and the question the held answer was for is gone.
	 */
	settleRun(runId: string, stages: readonly StageSnapshot[], generation: number): void {
		const asking = stages.some((stage) => stage.pendingPrompt !== undefined || stage.inputRequest !== undefined);
		if (!asking) return;
		const present = new Set(stages.map((stage) => JSON.stringify([runId, stage.id])));
		for (const [key, held] of this.held)
			if (held.runId === runId && generation > held.generation && !present.has(key)) this.held.delete(key);
	}

	/**
	 * Whether a publication of attempt `generation` must not route the stage's prompt again: an
	 * outcome is held for a later attempt's prompt, and this attempt's view of it is out of date.
	 */
	awaitsLaterAttempt(runId: string, stageId: string, generation: number): boolean {
		const held = this.held.get(JSON.stringify([runId, stageId]));
		return held !== undefined && generation <= held.generation;
	}

	/** The held outcome for `prompt`, asked again by attempt `generation`; it is handed out once. */
	takePrompt(
		runId: string,
		stageId: string,
		prompt: PendingPrompt,
		generation: number,
	): HeldPromptOutcome | undefined {
		const key = JSON.stringify([runId, stageId]);
		const held = this.held.get(key);
		if (held === undefined || generation <= held.generation) return undefined;
		this.held.delete(key);
		if (held.kind !== "prompt" || held.identity !== promptIdentity(prompt)) return undefined;
		return "error" in held ? { error: held.error } : { response: held.response };
	}

	/** The held outcome for `question`, asked again by attempt `generation`; it is handed out once. */
	takeQuestion(
		runId: string,
		stageId: string,
		question: PooledStageQuestion,
		generation: number,
	): HeldQuestionOutcome | undefined {
		const key = JSON.stringify([runId, stageId]);
		const held = this.held.get(key);
		if (held === undefined || generation <= held.generation) return undefined;
		this.held.delete(key);
		if (held.kind !== "question" || held.identity !== questionIdentity(question)) return undefined;
		return "error" in held ? { error: held.error } : { answer: held.answer };
	}

	clear(): void {
		this.held.clear();
	}
}
