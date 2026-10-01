import assert from "node:assert/strict";
import { test } from "vitest";
import type { QuestionnaireResult } from "../../packages/coding-agent/src/index.js";
import type { PiUISurface } from "../../packages/workflows/src/extension/ui-surface.js";
import { bindWorkflowHumanInput } from "../../packages/workflows/src/extension/workflow-human-input.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { adoptStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";

// #3111: adopting a sibling owner must not redirect an existing questionnaire subscription.
test.each(["answer", "withdraw", "pause", "pause-queued"])("owners retain questions on %s (#3391)", async (mode) => {
	const params = {
		questions: [{ question: "Choose", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
	};
	const createOwner = () => {
		const scope = {};
		const store = adoptStore(scope);
		const broker = adoptStageUiBroker(scope);
		store.recordRunStart({
			id: "run",
			name: "wf",
			inputs: {},
			status: "running",
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart("run", { id: "stage", name: "ask", status: "running", parentIds: [], toolEvents: [] });
		const replies: ReturnType<typeof Promise.withResolvers<QuestionnaireResult>>[] = [];
		const signals: AbortSignal[] = [];
		const listeners = new Set<() => void>();
		let active = true;
		const ui = {
			[Symbol.for("atomic-coding-agent/workflow-input@1")]: {
				active: () => active,
				available: () => active,
				bindingRevision: () => 0,
				subscribe: (listener: () => void) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				scope: () => ({
					ui: {},
					questionnaire: (_params: typeof params, signal: AbortSignal) => {
						signals.push(signal);
						const reply = Promise.withResolvers<QuestionnaireResult>();
						replies.push(reply);
						return reply.promise;
					},
				}),
			},
		} as PiUISurface;
		const unbind = bindWorkflowHumanInput(store, { hasUI: false, hasHumanInput: true, ui });
		const ask = () => {
			broker.provideStagePrompt(
				"run",
				"stage",
				buildStagePromptAdapter("prompt", "ask_user_question", params, Date.now())!,
			);
			const pending = broker.requestCustomUi<QuestionnaireResult>("run", "stage", () => ({ render: () => [] }));
			void pending.catch(() => {});
			return pending;
		};
		return {
			broker,
			replies,
			signals,
			unbind,
			ask,
			pause: () => store.recordRunPaused("run"),
			resume: () => store.recordRunResumed("run"),
			withdraw: () => {
				active = false;
				for (const listener of listeners) listener();
			},
		};
	};
	const a = createOwner();
	const b = createOwner();
	const answer = (label: string): QuestionnaireResult => ({
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Choose", kind: "option", answer: label }],
	});
	try {
		const pendingA = a.ask();
		const pendingB = b.ask();
		if (mode === "pause-queued") a.pause();
		await Promise.resolve();
		if (mode === "pause-queued") {
			assert.equal(a.replies.length, 0, "a queued questionnaire must not open after pause");
			assert.ok(a.broker.peekStageQuestionnaire("run", "stage"));
			a.resume();
			await Promise.resolve();
		}
		assert.equal(a.replies.length, 1);
		assert.equal(b.replies.length, 1);
		if (mode === "withdraw") a.withdraw();
		if (mode === "pause") a.pause();
		assert.equal(a.signals[0]!.aborted, mode === "withdraw");
		assert.equal(b.signals[0]!.aborted, false);
		a.replies[0]!.resolve(answer("A"));
		b.replies[0]!.resolve(answer("B"));
		assert.deepEqual(await pendingB, answer("B"));
		if (mode === "withdraw") {
			assert.ok(a.broker.peekStageQuestionnaire("run", "stage"));
			assert.equal(a.broker.answerStagePrompt("run", "stage", { raw: answer("A") }), true);
		}
		assert.deepEqual(await pendingA, answer("A"));
	} finally {
		a.unbind();
		b.unbind();
		a.broker.cancelStagePrompt("run", "stage", new Error("cleanup"));
		b.broker.cancelStagePrompt("run", "stage", new Error("cleanup"));
	}
});
