import { describe, expect, it } from "vitest";
import { createAskUserQuestionToolDefinition } from "../src/core/tools/ask-user-question/index.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";

const QUESTION_PARAMS = {
	questions: [
		{
			question: "Continue?",
			header: "Continue",
			options: [
				{ label: "Yes", description: "Continue now." },
				{ label: "No", description: "Stop here." },
			],
		},
	],
};

async function waitFor(condition: () => boolean, timeoutMs = 200): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("ask_user_question tool", () => {
	it("passes the tool abort signal to its custom UI", async () => {
		const tool = createAskUserQuestionToolDefinition();
		const controller = new AbortController();
		const abortReason = new Error("interrupting stale question");
		let capturedSignal: AbortSignal | undefined;

		const ui = {
			setWorkingVisible: () => {},
			custom: <T>(_factory: Parameters<ExtensionUIContext["custom"]>[0], options?: { signal?: AbortSignal }) => {
				capturedSignal = options?.signal;
				if (capturedSignal === undefined) {
					return Promise.resolve({ answers: [], cancelled: true } as T);
				}
				return new Promise<T>((_resolve, reject) => {
					capturedSignal?.addEventListener(
						"abort",
						() => reject(capturedSignal?.reason ?? new Error("aborted")),
						{ once: true },
					);
				});
			},
		} as Pick<ExtensionUIContext, "custom" | "setWorkingVisible">;

		const execution = tool.execute(
			"ask-1",
			QUESTION_PARAMS,
			controller.signal,
			() => undefined,
			{ hasUI: true, ui } as Parameters<typeof tool.execute>[4],
		);

		await waitFor(() => capturedSignal !== undefined);
		expect(capturedSignal).toBe(controller.signal);

		controller.abort(abortReason);
		await expect(execution).rejects.toBe(abortReason);
	});

	it("suspends the working loader while the dialog is open and restores it afterward", async () => {
		const tool = createAskUserQuestionToolDefinition();
		const events: string[] = [];

		const ui = {
			setWorkingVisible: (visible: boolean) => {
				events.push(visible ? "working:on" : "working:off");
			},
			custom: <T>() => {
				events.push("custom");
				return Promise.resolve({ answers: [], cancelled: true } as T);
			},
		} as Pick<ExtensionUIContext, "custom" | "setWorkingVisible">;

		await tool.execute(
			"ask-loader",
			QUESTION_PARAMS,
			new AbortController().signal,
			() => undefined,
			{ hasUI: true, ui } as Parameters<typeof tool.execute>[4],
		);

		// Loader is hidden before the dialog mounts and restored once it closes.
		expect(events).toEqual(["working:off", "custom", "working:on"]);
	});

	it("restores the working loader even when the dialog rejects", async () => {
		const tool = createAskUserQuestionToolDefinition();
		const events: string[] = [];
		const failure = new Error("dialog blew up");

		const ui = {
			setWorkingVisible: (visible: boolean) => {
				events.push(visible ? "working:on" : "working:off");
			},
			custom: <T>() => Promise.reject<T>(failure),
		} as Pick<ExtensionUIContext, "custom" | "setWorkingVisible">;

		await expect(
			tool.execute(
				"ask-loader-reject",
				QUESTION_PARAMS,
				new AbortController().signal,
				() => undefined,
				{ hasUI: true, ui } as Parameters<typeof tool.execute>[4],
			),
		).rejects.toBe(failure);

		// The `finally` restores the loader even on the failure/abort path.
		expect(events).toEqual(["working:off", "working:on"]);
	});

	it("works when the host UI context does not implement setWorkingVisible", async () => {
		// Some hosts (e.g. the workflow stage-UI broker) pass a minimal context that only
		// implements `custom`. The loader control must degrade to a no-op, not throw.
		const tool = createAskUserQuestionToolDefinition();
		let customCalled = false;

		const ui = {
			custom: <T>() => {
				customCalled = true;
				return Promise.resolve({ answers: [], cancelled: true } as T);
			},
		} as Pick<ExtensionUIContext, "custom">;

		const result = await tool.execute(
			"ask-no-loader",
			QUESTION_PARAMS,
			new AbortController().signal,
			() => undefined,
			{ hasUI: true, ui } as Parameters<typeof tool.execute>[4],
		);

		expect(customCalled).toBe(true);
		expect(result).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// buildQuestionnaireResponse — chat sentinel behavior (#1264)
// ---------------------------------------------------------------------------

import {
	buildQuestionnaireResponse,
	ENVELOPE_SUFFIX,
} from "../src/core/tools/ask-user-question/tool/response-envelope.ts";
import type { QuestionnaireResult, QuestionParams } from "../src/core/tools/ask-user-question/tool/types.ts";

const BASE_PARAMS: QuestionParams = {
	questions: [
		{
			question: "Continue?",
			header: "Continue",
			options: [
				{ label: "Yes", description: "Continue now." },
				{ label: "No", description: "Stop here." },
			],
		},
	],
};

describe("buildQuestionnaireResponse — chat answer", () => {
	const chatResult: QuestionnaireResult = {
		answers: [{ questionIndex: 0, question: "Continue?", kind: "chat", answer: "Chat about this" }],
		cancelled: false,
	};

	it("returns terminate: true for a chat answer", () => {
		const res = buildQuestionnaireResponse(chatResult, BASE_PARAMS);
		expect((res as { terminate?: boolean }).terminate).toBe(true);
	});

	it("does not include ENVELOPE_SUFFIX in the content for a chat answer", () => {
		const res = buildQuestionnaireResponse(chatResult, BASE_PARAMS);
		const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).not.toContain(ENVELOPE_SUFFIX);
	});

	it("includes stop/wait directive in the chat answer content", () => {
		const res = buildQuestionnaireResponse(chatResult, BASE_PARAMS);
		const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text.toLowerCase()).toContain("stop");
		expect(text.toLowerCase()).toContain("wait");
	});

	it("preserves result details for chat answer", () => {
		const res = buildQuestionnaireResponse(chatResult, BASE_PARAMS);
		expect(res.details).toEqual(chatResult);
	});

	it("terminates even when a raw chat answer does not match a current question index", () => {
		const unmatchedChatResult: QuestionnaireResult = {
			answers: [{ questionIndex: 99, question: "Continue?", kind: "chat", answer: "Chat about this" }],
			cancelled: false,
		};
		const res = buildQuestionnaireResponse(unmatchedChatResult, BASE_PARAMS);
		expect((res as { terminate?: boolean }).terminate).toBe(true);
		expect(res.details).toEqual(unmatchedChatResult);
	});
});

describe("buildQuestionnaireResponse — non-chat answers do not terminate", () => {
	const optionResult: QuestionnaireResult = {
		answers: [{ questionIndex: 0, question: "Continue?", kind: "option", answer: "Yes" }],
		cancelled: false,
	};
	const customResult: QuestionnaireResult = {
		answers: [{ questionIndex: 0, question: "Continue?", kind: "custom", answer: "maybe" }],
		cancelled: false,
	};
	const cancelledResult: QuestionnaireResult = { answers: [], cancelled: true };

	it("option answer has no terminate field", () => {
		const res = buildQuestionnaireResponse(optionResult, BASE_PARAMS);
		expect((res as { terminate?: boolean }).terminate).toBeUndefined();
	});

	it("custom answer has no terminate field", () => {
		const res = buildQuestionnaireResponse(customResult, BASE_PARAMS);
		expect((res as { terminate?: boolean }).terminate).toBeUndefined();
	});

	it("cancelled result has no terminate field", () => {
		const res = buildQuestionnaireResponse(cancelledResult, BASE_PARAMS);
		expect((res as { terminate?: boolean }).terminate).toBeUndefined();
	});

	it("option answer still includes ENVELOPE_SUFFIX", () => {
		const res = buildQuestionnaireResponse(optionResult, BASE_PARAMS);
		const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
		expect(text).toContain(ENVELOPE_SUFFIX);
	});
});
