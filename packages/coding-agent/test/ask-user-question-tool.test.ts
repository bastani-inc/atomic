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
