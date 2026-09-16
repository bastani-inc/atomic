import assert from "node:assert/strict";
import { test } from "vitest";
import { createAskUserQuestionToolDefinition } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import type {
	QuestionnaireResult,
	QuestionParams,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import { getThemeByName, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { mountStageCustomUi, StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const DOWN = "\x1b[B";
const ENTER = "\r";
const LEFT = "\x1b[D";
const ESC = "\x1b";
const firstQuestion = {
	question: "Choose first?",
	header: "First",
	options: [
		{ label: "Alpha", description: "A" },
		{ label: "Beta", description: "B" },
	],
};
const secondQuestion = {
	question: "Choose second?",
	header: "Second",
	options: [
		{ label: "Gamma", description: "G" },
		{ label: "Delta", description: "D" },
	],
};

const cases: {
	name: string;
	first?: QuestionParams["questions"][number];
	before: string[];
	after: string[];
	answer: string | string[];
	notes?: string;
	cancelled?: boolean;
}[] = [
	{ name: "selected answer and current tab", before: [DOWN, ENTER], after: [ENTER, ENTER], answer: "Beta" },
	{
		name: "partial multiselect",
		first: { ...firstQuestion, multiSelect: true },
		before: [" ", DOWN, " "],
		after: [DOWN, ENTER, ENTER, ENTER],
		answer: ["Alpha", "Beta"],
	},
	{
		name: "inline text and caret",
		before: [DOWN, DOWN, "abc", LEFT, "X"],
		after: ["Y", ENTER, ENTER, ENTER],
		answer: "abXYc",
	},
	{
		name: "notes and caret",
		first: {
			...firstQuestion,
			options: [{ ...firstQuestion.options[0]!, preview: "# Alpha" }, firstQuestion.options[1]!],
		},
		before: ["n", "abc", LEFT, "X"],
		after: ["Y", ENTER, ENTER, ENTER, ENTER],
		answer: "Alpha",
		notes: "abXYc",
	},
	{ name: "cancelled selected draft", before: [DOWN, ENTER], after: [ESC], answer: "Beta", cancelled: true },
];

// PR #2700: connecting to a waiting workflow must not discard questionnaire drafts.
for (const scenario of cases) {
	test(`brokered questionnaire retains ${scenario.name} across detach and reattach`, async () => {
		initTheme("dark");
		const store = createStore();
		const runId = "54b0a130-c167-4574-a063-ae9a47819f81";
		store.recordRunStart({ id: runId, name: "draft", inputs: {}, status: "running", stages: [], startedAt: 1 });
		store.recordStageStart(runId, { id: "stage", name: "stage", status: "running", parentIds: [], toolEvents: [] });
		const broker = new StageUiBroker(store);
		const theme = getThemeByName("dark")!;
		let nextMount = Promise.withResolvers<Awaited<ReturnType<typeof mountStageCustomUi>>>();
		let generation = 0;
		const completedHosts: number[] = [];
		const attach = () => {
			const host = ++generation;
			let active = true;
			const unregister = broker.registerHost(runId, "stage", {
				showCustomUi(request) {
					// Every attachment has a fresh host; a draft must not retain the old host callback.
					const tui = { terminal: { columns: 100, rows: 40 }, requestRender() {} } as Parameters<
						typeof mountStageCustomUi
					>[1];
					const keybindings = {} as Parameters<typeof mountStageCustomUi>[3];
					void mountStageCustomUi(
						request,
						tui,
						theme,
						keybindings,
						broker,
						() => completedHosts.push(host),
						() => active,
					).then(nextMount.resolve, nextMount.reject);
				},
			});
			return () => {
				active = false;
				unregister();
			};
		};
		let detach = attach();
		const tool = createAskUserQuestionToolDefinition();
		const params = { questions: [scenario.first ?? firstQuestion, secondQuestion] };
		const custom = (
			factory: Parameters<StageUiBroker["requestCustomUi"]>[2],
			options?: Parameters<StageUiBroker["requestCustomUi"]>[3],
		) => broker.requestCustomUi(runId, "stage", factory, options);
		const context = {
			hasUI: true,
			// The structural fixture host supplies the questionnaire's TUI capabilities.
			ui: { custom: custom as unknown as Parameters<typeof tool.execute>[4]["ui"]["custom"] },
		} as Parameters<typeof tool.execute>[4];
		let settled = false;
		let execution = tool.execute("draft", params, undefined, undefined, context).then((result) => {
			settled = true;
			return result;
		});
		let mounted = await nextMount.promise;
		try {
			const initial = mounted.component.render(100);
			for (const input of scenario.before) mounted.component.handleInput?.(input);
			const drafted = mounted.component.render(100);
			assert.notDeepEqual(drafted, initial);
			assert.equal(settled, false);
			mounted.component.dispose?.();
			detach();
			nextMount = Promise.withResolvers();
			detach = attach();
			mounted = await nextMount.promise;
			assert.deepEqual(mounted.component.render(100), drafted);
			assert.equal(settled, false, "reattaching is not submission");
			for (const input of scenario.after) mounted.component.handleInput?.(input);
			assert.deepEqual(completedHosts, [2], "only the reattached host may resolve the request");
			const details = (await execution).details as QuestionnaireResult;
			assert.equal(details.cancelled, scenario.cancelled ?? false);
			if (Array.isArray(scenario.answer)) {
				assert.equal(details.answers[0]?.answer, null);
				assert.deepEqual(details.answers[0]?.selected, scenario.answer);
			} else {
				assert.equal(details.answers[0]?.answer, scenario.answer);
			}
			if (scenario.notes) assert.equal(details.answers[0]?.notes, scenario.notes);
			if (!scenario.cancelled) assert.equal(details.answers[1]?.answer, "Gamma");
			mounted.component.dispose?.();

			// A new invocation of the same tool starts unanswered, even with identical parameters.
			nextMount = Promise.withResolvers();
			settled = false;
			execution = tool.execute("fresh", params, undefined, undefined, context).then((result) => {
				settled = true;
				return result;
			});
			mounted = await nextMount.promise;
			assert.deepEqual(mounted.component.render(100), initial);
			mounted.component.handleInput?.(ESC);
			assert.deepEqual((await execution).details, { answers: [], cancelled: true });
			assert.deepEqual(completedHosts, [2, 2]);
		} finally {
			if (!settled) broker.resolve(mounted.request, { answers: [], cancelled: true });
			await execution;
			mounted.component.dispose?.();
			detach();
		}
	});
}
