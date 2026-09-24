import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
	generateStructuredOutput,
	type StructuredOutputRequest,
} from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	type choiceDecisionSchema,
	classifierResult,
	decisionClassifier,
	decisionMessage,
	decisionModel,
	messageStream,
	structuredOutputRequest,
} from "../helpers/structured-output.js";

afterEach(() => {
	vi.useRealTimers();
});

for (const kind of ["chat", "classifier"] as const) {
	test(`${kind} structured output can finish after 30 seconds without a decision timeout`, async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const lateChat = Promise.withResolvers<ReturnType<typeof decisionMessage>>();
		const lateClassifier = Promise.withResolvers<ReturnType<typeof classifierResult>>();
		const dispatch = vi.fn<StructuredOutputRequest<typeof choiceDecisionSchema>["modelRegistry"]["streamSimple"]>(
			() => {
				const stream = messageStream(decisionMessage({ route: "review" }));
				stream.result = () => lateChat.promise;
				return stream;
			},
		);
		const classify = vi.fn(async () => await lateClassifier.promise);
		const pending = generateStructuredOutput({
			...structuredOutputRequest(),
			currentModel: undefined,
			modelRegistry: {
				getAll: () => [decisionModel],
				streamSimple: dispatch,
				getClassifierModel: () => decisionClassifier,
				classify,
			},
			model: kind === "chat" ? "decision-test/chat" : "decision-test/classifier",
		});
		await vi.advanceTimersByTimeAsync(120_000);
		lateChat.resolve(decisionMessage({ route: "review" }));
		lateClassifier.resolve(classifierResult({ route: '"review"' }));
		const result = await pending;
		assert.equal(result.value.route, "review");
		assert.equal(classify.mock.calls.length, kind === "classifier" ? 1 : 0);
		assert.equal(dispatch.mock.calls.length, kind === "chat" ? 1 : 0);
		if (kind === "chat") assert.equal(dispatch.mock.calls[0][2]?.timeoutMs, undefined);
	});
}
