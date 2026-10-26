import type { StageInputAnswer } from "../shared/stage-prompt.js";
import { isTerminalStageStatus } from "../shared/store-internal.js";
import type { PendingPrompt, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { PooledStageQuestion } from "./stage-watch-types.js";

/** An answer the user gave a pooled stage's prompt that its attempt never received. */
type HeldAnswer =
	| {
			readonly kind: "prompt";
			readonly generation: number;
			readonly promptId: string;
			readonly identity: string;
			readonly response: WorkflowSerializableValue;
	  }
	| {
			readonly kind: "question";
			readonly generation: number;
			readonly promptId: string;
			readonly identity: string;
			readonly answer: StageInputAnswer;
	  };

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
 * stage. The replacement attempt asks the same prompt again; the held answer goes to that prompt
 * once, so the user is not asked twice. A replacement that asks something else, a stage that
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

	/** The held response for `prompt`, asked again by attempt `generation`; it is handed out once. */
	takePrompt(
		runId: string,
		stageId: string,
		prompt: PendingPrompt,
		generation: number,
	): { readonly response: WorkflowSerializableValue } | undefined {
		const key = JSON.stringify([runId, stageId]);
		const held = this.held.get(key);
		if (held === undefined || generation <= held.generation) return undefined;
		this.held.delete(key);
		return held.kind === "prompt" && held.identity === promptIdentity(prompt)
			? { response: held.response }
			: undefined;
	}

	/** The held answer for `question`, asked again by attempt `generation`; it is handed out once. */
	takeQuestion(
		runId: string,
		stageId: string,
		question: PooledStageQuestion,
		generation: number,
	): { readonly answer: StageInputAnswer } | undefined {
		const key = JSON.stringify([runId, stageId]);
		const held = this.held.get(key);
		if (held === undefined || generation <= held.generation) return undefined;
		this.held.delete(key);
		return held.kind === "question" && held.identity === questionIdentity(question)
			? { answer: held.answer }
			: undefined;
	}

	clear(): void {
		this.held.clear();
	}
}
