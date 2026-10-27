/**
 * The forms a stage's questions show are the same whether the stage runs in process or on a local
 * worker (#4022): the root builds a pooled stage's form from the question the worker reports, with
 * the same helper an in-process stage uses. Each kind is rendered and answered through both paths.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionParams } from "@bastani/atomic";
import { beforeAll, test } from "vitest";
import { createAllToolDefinitions } from "../../packages/coding-agent/src/core/tools/index.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { buildExitGatedUiContext } from "../../packages/workflows/src/engine/primitives/ui.js";
import type { PiCustomOverlayFactory, PiCustomOverlayOptions } from "../../packages/workflows/src/extension/wiring.js";
import {
	askReadinessViaStageBroker,
	interpretReadinessResult,
	makePrompt,
	READINESS_GATE_QUESTION_PARAMS,
} from "../../packages/workflows/src/runs/foreground/executor-hil.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { askStagePromptUi, presentStageQuestion } from "../../packages/workflows/src/shared/stage-question-form.js";
import {
	mountStageCustomUi,
	type StageCustomUiRequest,
	StageUiBroker,
} from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { WorkflowSerializableValue, WorkflowUIAdapter } from "../../packages/workflows/src/shared/types.js";
import { makeFakeKeybindings } from "../support/fake-keybindings.js";
import { makeTestTui } from "../support/fake-tui.js";

beforeAll(() => {
	initTheme("dark", false);
});

const RUN = "run";
const STAGE = "stage";
const DOWN = "\x1b[B";
const ENTER = "\r";

const QUESTION: QuestionParams = {
	questions: [
		{
			question: "Ship the release?",
			header: "Ship",
			multiSelect: false,
			options: [
				{ label: "yes", description: "Ship it now", preview: "release-preview-marker" },
				{ label: "no", description: "Hold the release", preview: "hold-preview-marker" },
			],
		},
	],
};

const FREE_TEXT_QUESTION: QuestionParams = {
	questions: [
		{
			question: "Which branch?",
			header: "Branch",
			multiSelect: false,
			options: [
				{ label: "main", description: "The main line" },
				{ label: "release", description: "The release line" },
			],
		},
	],
};

/**
 * Shows a form through `present` on a broker, renders it the way the stage chat mounts it, presses
 * `keys`, and returns what the form showed along the way and what the path returned.
 */
async function answerThrough<T>(
	present: (broker: StageUiBroker) => Promise<T>,
	keys: readonly string[],
): Promise<{ readonly shown: readonly string[]; readonly answered: T }> {
	const broker = new StageUiBroker(createStore());
	const shown = Promise.withResolvers<readonly string[]>();
	broker.registerHost(RUN, STAGE, {
		showCustomUi: (request: StageCustomUiRequest) => {
			void mountStageCustomUi(request, makeTestTui(40), theme, makeFakeKeybindings(), broker).then(
				({ component }) => {
					// What the form shows when it opens and after each key, up to the key that answers it.
					const frames = [...component.render(100)];
					for (const [index, key] of keys.entries()) {
						if (index === keys.length - 1) shown.resolve(frames);
						component.handleInput?.(key);
						if (index < keys.length - 1) frames.push("--", ...component.render(100));
					}
				},
				shown.reject,
			);
		},
	});
	const answered = present(broker);
	return { shown: await shown.promise, answered: await answered };
}

function resultText(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }) {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** An in-process stage's ask_user_question: its session's own tool, rendering through the stage's broker. */
async function inProcessQuestion(broker: StageUiBroker, params: QuestionParams): Promise<string> {
	const tool = createAllToolDefinitions(mkdtempSync(join(tmpdir(), "question-parity-"))).ask_user_question;
	assert.ok(tool.execute !== undefined);
	const context = {
		hasUI: true,
		ui: {
			custom: <T>(factory: PiCustomOverlayFactory<T>, options?: PiCustomOverlayOptions): Promise<T> =>
				broker.requestCustomUi(RUN, STAGE, factory, options),
		},
	};
	return resultText(await tool.execute("call", params, AbortSignal.timeout(30_000), undefined, context as never));
}

/** A pooled stage's ask_user_question, as the root shows the form the worker reports. */
async function pooledQuestion(broker: StageUiBroker, params: QuestionParams): Promise<string> {
	const result = await presentStageQuestion({
		broker,
		runId: RUN,
		stageId: STAGE,
		promptId: "call",
		kind: "ask_user_question",
		params,
		signal: AbortSignal.timeout(30_000),
	}).result;
	assert.ok(result !== undefined);
	return resultText(result);
}

for (const [name, params, keys] of [
	["an option with a preview", QUESTION, [DOWN, ENTER]],
	["the first option of a question without previews", FREE_TEXT_QUESTION, [ENTER]],
	["a typed answer", FREE_TEXT_QUESTION, [DOWN, DOWN, ..."hotfix", ENTER]],
	["chatting about it", FREE_TEXT_QUESTION, [DOWN, DOWN, DOWN, ..."why", ENTER]],
] as const)
	test(`#4022: ask_user_question shows the same form and returns the same result in process and on a local worker: ${name}`, async () => {
		const inProcess = await answerThrough((broker) => inProcessQuestion(broker, params), keys);
		const pooled = await answerThrough((broker) => pooledQuestion(broker, params), keys);
		assert.deepEqual(pooled.shown, inProcess.shown);
		assert.equal(pooled.answered, inProcess.answered);
		assert.ok(inProcess.answered.length > 0, "the tool returned its result text");
	});

for (const [name, keys] of [
	["moving on", [ENTER]],
	["choosing to chat", [DOWN, DOWN, DOWN, ENTER]],
	["typing a reply", [DOWN, DOWN, ..."not yet", ENTER]],
] as const)
	test(`#4022: the readiness gate shows the same form and decides the same in process and on a local worker: ${name}`, async () => {
		const inProcess = await answerThrough(
			(broker) => askReadinessViaStageBroker(RUN, STAGE, AbortSignal.timeout(30_000), broker),
			keys,
		);
		const pooled = await answerThrough(async (broker) => {
			const result = await presentStageQuestion({
				broker,
				runId: RUN,
				stageId: STAGE,
				promptId: "gate",
				kind: "readiness_gate",
				params: READINESS_GATE_QUESTION_PARAMS as QuestionParams,
				signal: AbortSignal.timeout(30_000),
			}).result;
			assert.ok(result !== undefined);
			return interpretReadinessResult(result);
		}, keys);
		assert.deepEqual(pooled.shown, inProcess.shown);
		assert.deepEqual(pooled.answered, inProcess.answered);
		assert.match(inProcess.shown.join("\n"), /Chat about this/);
	});

/** A `ui` that records each call and answers it by kind. */
function recordingUi(calls: (readonly [string, ...WorkflowSerializableValue[]])[]): WorkflowUIAdapter {
	return {
		async input(prompt) {
			calls.push(["input", prompt]);
			return "typed";
		},
		async confirm(message) {
			calls.push(["confirm", message]);
			return true;
		},
		async select(message, options) {
			calls.push(["select", message, [...options]]);
			return options[1] ?? options[0]!;
		},
		async editor(initial) {
			calls.push(["editor", initial ?? null]);
			return `${initial ?? ""} edited`;
		},
		async custom() {
			throw new Error("not used");
		},
	};
}

test("#4022: an SDK ui is asked each ctx.ui prompt kind the same way in process and on a local worker", async () => {
	const cases = [
		{ kind: "input", message: "Which branch?" },
		{ kind: "confirm", message: "Ship it?" },
		{ kind: "select", message: "Which remote?", choices: ["origin", "upstream"] },
		{ kind: "editor", message: "", initial: "draft notes" },
	] as const;
	for (const descriptor of cases) {
		const inProcessCalls: (readonly [string, ...WorkflowSerializableValue[]])[] = [];
		const ctx = buildExitGatedUiContext({
			opts: { ui: recordingUi(inProcessCalls) } as RunOpts,
			baseFromPromptNodes: () => assert.fail("prompt nodes are not used with an SDK ui"),
			throwIfWorkflowExitSelected: () => {},
		});
		const inProcess =
			descriptor.kind === "input"
				? await ctx.input(descriptor.message)
				: descriptor.kind === "confirm"
					? await ctx.confirm(descriptor.message)
					: descriptor.kind === "select"
						? await ctx.select(descriptor.message, descriptor.choices)
						: await ctx.editor(descriptor.initial);
		const pooledCalls: (readonly [string, ...WorkflowSerializableValue[]])[] = [];
		// The prompt a worker's ctx.ui call publishes, which the root asks the SDK ui.
		const pooled = await askStagePromptUi(recordingUi(pooledCalls), makePrompt(descriptor));
		assert.deepEqual(pooledCalls, inProcessCalls, descriptor.kind);
		assert.deepEqual(pooled, inProcess, descriptor.kind);
	}
});
