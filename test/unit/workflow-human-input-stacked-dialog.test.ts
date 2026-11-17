import assert from "node:assert/strict";
import { test } from "vitest";
import type { QuestionnaireResult } from "../../packages/coding-agent/src/index.js";
import type { PiUISurface } from "../../packages/workflows/src/extension/ui-surface.js";
import { bindWorkflowHumanInput } from "../../packages/workflows/src/extension/workflow-human-input.js";
import { buildStagePromptAdapter } from "../../packages/workflows/src/shared/stage-prompt.js";
import { adoptStageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { adoptStore } from "../../packages/workflows/src/shared/store-factory.js";

test.each(["dialog-first", "questionnaire-first"] as const)(
	"stacked stage dialog retains in-flight questionnaire presentation (%s) (#5354)",
	async (order) => {
		const params = {
			questions: [{ question: "Choose", header: "Choice", options: [{ label: "A" }, { label: "B" }] }],
		};
		const scope = {};
		const store = adoptStore(scope);
		const broker = adoptStageUiBroker(scope, false, store);
		store.recordRunStart({
			id: "run",
			name: "wf",
			inputs: {},
			status: "running",
			toolNodes: [],
			stages: [],
			startedAt: Date.now(),
		});
		store.recordStageStart("run", { id: "stage", name: "ask", status: "running", parentIds: [], toolEvents: [] });
		const replies: ReturnType<typeof Promise.withResolvers<QuestionnaireResult>>[] = [];
		const signals: AbortSignal[] = [];
		const confirmCalls: string[] = [];
		const ui = {
			confirm: async (title: string, message: string) => {
				confirmCalls.push(`${title}:${message}`);
				return true;
			},
			[Symbol.for("atomic-coding-agent/workflow-input@1")]: {
				active: () => true,
				available: () => true,
				bindingRevision: () => 0,
				subscribe: () => () => {},
				scope: () => ({
					ui: {
						confirm: async (title: string, message: string) => {
							confirmCalls.push(`${title}:${message}`);
							return true;
						},
					},
					questionnaire: (_params: typeof params, signal: AbortSignal) => {
						signals.push(signal);
						const reply = Promise.withResolvers<QuestionnaireResult>();
						replies.push(reply);
						return reply.promise;
					},
				}),
			},
		} as PiUISurface;
		const unbind = bindWorkflowHumanInput(store, { hasUI: false, hasHumanInput: true, ui }, broker);
		const answer: QuestionnaireResult = {
			cancelled: false,
			answers: [{ questionIndex: 0, question: "Choose", kind: "option", answer: "A" }],
		};
		const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
		try {
			broker.provideStagePrompt(
				"run",
				"stage",
				buildStagePromptAdapter("prompt", "ask_user_question", params, Date.now())!,
			);
			const pendingQuestion = broker.requestCustomUi<QuestionnaireResult>("run", "stage", () => ({
				render: () => [],
			}));
			void pendingQuestion.catch(() => {});
			await flush();
			assert.equal(replies.length, 1);
			assert.equal(signals[0]!.aborted, false);

			const pendingDialog = broker.requestDialog("run", "stage", {
				kind: "confirm",
				message: "Allow stacked confirmation?",
			});
			await flush();
			const dialogPrompt = store.run("run")?.stages[0]?.pendingPrompt;
			assert.equal(dialogPrompt?.source, "stage-dialog");
			assert.deepEqual(confirmCalls, []);
			assert.equal(signals[0]!.aborted, false);
			assert.equal(replies.length, 1);

			if (order === "dialog-first") {
				assert.equal(store.resolveStagePendingPrompt("run", "stage", dialogPrompt!.id, true), true);
				assert.equal(await pendingDialog, true);
				await flush();
				assert.equal(signals[0]!.aborted, false);
				assert.equal(replies.length, 1);
				replies[0]!.resolve(answer);
				assert.deepEqual(await pendingQuestion, answer);
			} else {
				assert.equal(signals[0]!.aborted, false);
				replies[0]!.resolve(answer);
				assert.deepEqual(await pendingQuestion, answer);
				assert.equal(replies.length, 1);
				assert.equal(store.resolveStagePendingPrompt("run", "stage", dialogPrompt!.id, true), true);
				assert.equal(await pendingDialog, true);
			}
			await flush();
			assert.equal(replies.length, 1);
			assert.deepEqual(confirmCalls, []);
		} finally {
			unbind();
			broker.cancelStagePrompt("run", "stage", new Error("cleanup"));
		}
	},
);
