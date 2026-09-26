/**
 * A `custom` UI prompt can carry a title on `ui_prompt_start` / `ui_prompt_end`,
 * the way `select`/`confirm`/`input`/`editor` prompts already do, and the
 * questionnaire tool passes its first question as that title.
 *
 * Before this, every `ask_user_question` opened a prompt whose observers saw
 * `kind: "custom"` and nothing else, so a status reporter or notification could
 * say Atomic was waiting but never what it was waiting for.
 *
 * cross-ref: src/core/extensions/runner.ts (wrapUIPromptContext)
 *            src/core/tools/ask-user-question/ask-user-question.ts
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import type {
	UIPromptEndEvent,
	UIPromptStartEvent,
} from "../../packages/coding-agent/src/core/extensions/agent-events.js";
import {
	createExtensionRuntime,
	loadExtensionFromFactory,
} from "../../packages/coding-agent/src/core/extensions/loader.js";
import { ExtensionRunner } from "../../packages/coding-agent/src/core/extensions/runner.js";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/types.js";
import {
	createAskUserQuestionToolDefinition,
	QUESTIONNAIRE_PROMPT_TITLE_LIMIT,
	questionnairePromptTitle,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function promptObservingRunner() {
	const runtime = createExtensionRuntime();
	const events: Array<UIPromptStartEvent | UIPromptEndEvent> = [];
	const extension = await loadExtensionFromFactory(
		(pi) => {
			pi.on("ui_prompt_start", (event) => {
				events.push(event);
			});
			pi.on("ui_prompt_end", (event) => {
				events.push(event);
			});
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"prompt-title-observer",
	);
	const runner = new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never);
	let close = () => {};
	const rawUi = {
		...noOpUIContext,
		custom: (() =>
			new Promise<void>((resolve) => {
				close = resolve;
			})) as ExtensionUIContext["custom"],
	};
	runner.setUIContext(rawUi, "tui");
	return { runner, events, close: () => close() };
}

test("a custom prompt's title reaches ui_prompt_start and ui_prompt_end", async () => {
	const { runner, events, close } = await promptObservingRunner();
	try {
		const prompt = runner
			.getUIContext()
			.custom(() => ({ render: () => [], invalidate() {} }), { title: "Which environment should I use?" });
		await flush();
		assert.deepEqual(
			events.map((event) => [event.type, event.kind, event.title]),
			[["ui_prompt_start", "custom", "Which environment should I use?"]],
		);
		close();
		await prompt;
		await flush();
		assert.deepEqual(
			events.map((event) => [event.type, event.title]),
			[
				["ui_prompt_start", "Which environment should I use?"],
				["ui_prompt_end", "Which environment should I use?"],
			],
		);
	} finally {
		close();
		await flush();
		runner.invalidate();
	}
});

test("a custom prompt without a title still emits the span, with no title field", async () => {
	const { runner, events, close } = await promptObservingRunner();
	try {
		const prompt = runner.getUIContext().custom(() => ({ render: () => [], invalidate() {} }));
		await flush();
		assert.equal(events.length, 1);
		assert.equal(events[0]!.kind, "custom");
		assert.equal("title" in events[0]!, false);
		close();
		await prompt;
	} finally {
		close();
		await flush();
		runner.invalidate();
	}
});

test("the questionnaire tool passes its first question as the prompt title", async () => {
	const tool = createAskUserQuestionToolDefinition();
	let captured: { title?: string } | undefined;
	const ui = {
		setWorkingVisible: () => {},
		custom: <T>(_factory: Parameters<ExtensionUIContext["custom"]>[0], options?: { title?: string }) => {
			captured = options;
			return Promise.resolve({ answers: [], cancelled: true } as T);
		},
	} as Pick<ExtensionUIContext, "custom" | "setWorkingVisible">;
	await tool.execute(
		"ask-title",
		{
			questions: [
				{
					question: "Which environment should I use?",
					header: "Environment",
					options: [
						{ label: "Staging", description: "Safe to break." },
						{ label: "Production", description: "Real users." },
					],
				},
				{
					question: "Second question is not the title",
					header: "Second",
					options: [
						{ label: "A", description: "a" },
						{ label: "B", description: "b" },
					],
				},
			],
		},
		new AbortController().signal,
		() => undefined,
		{ hasUI: true, ui } as Parameters<typeof tool.execute>[4],
	);
	assert.equal(captured?.title, "Which environment should I use?");
});

test("a long first question is cut to the title limit with an ellipsis", () => {
	const long = "x".repeat(QUESTIONNAIRE_PROMPT_TITLE_LIMIT + 40);
	const title = questionnairePromptTitle([{ question: long }]);
	assert.equal(title?.length, QUESTIONNAIRE_PROMPT_TITLE_LIMIT);
	assert.ok(title?.endsWith("…"));
	assert.equal(questionnairePromptTitle([{ question: "  short  " }]), "short");
	assert.equal(questionnairePromptTitle([{ question: "   " }]), undefined);
	assert.equal(questionnairePromptTitle([]), undefined);
});
