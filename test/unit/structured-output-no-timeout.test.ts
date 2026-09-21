import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { inferStructuredOutput } from "../../packages/coding-agent/src/core/structured-output/index.js";
import {
	decisionMessage,
	decisionModel,
	decisionRequest,
	jevResponse,
	messageStream,
} from "../helpers/structured-output.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

for (const kind of ["chat", "typesafe", "openrouter"] as const) {
	test(`${kind} structured output can finish after 30 seconds without a decision timeout`, async () => {
		vi.useFakeTimers();
		vi.stubEnv("TYPESAFE_API_KEY", "synthetic-key");
		vi.stubEnv("OPENROUTER_API_KEY", "synthetic-key");
		const late = Promise.withResolvers<Response>();
		const transport = vi.fn(() => late.promise);
		vi.stubGlobal("fetch", transport);
		const request = decisionRequest();
		const chat = Promise.withResolvers<ReturnType<typeof decisionMessage>>();
		const dispatch = vi.fn<typeof request.modelRegistry.streamSimple>(() => {
			const stream = messageStream(decisionMessage());
			stream.result = () => chat.promise;
			return stream;
		});
		const pending = inferStructuredOutput({
			...request,
			modelRegistry: { ...request.modelRegistry, streamSimple: dispatch },
			model:
				kind === "chat"
					? { kind: "chat", fullId: "decision-test/chat", model: decisionModel }
					: {
							kind: "jev",
							fullId: kind === "typesafe" ? "typesafe-ai/jev-latest" : "openrouter/~typesafe/jev-latest",
						},
		});
		const outcome = pending.then(
			(value) => value,
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(120_000);
		late.resolve(Response.json(jevResponse()));
		chat.resolve(decisionMessage());
		const result = await outcome;
		assert.ok(!(result instanceof Error), String(result));
		assert.equal(result.value.route, "review");
		assert.equal(transport.mock.calls.length, kind === "chat" ? 0 : 1);
		assert.equal(dispatch.mock.calls.length, kind === "chat" ? 1 : 0);
		if (kind === "chat") assert.equal(dispatch.mock.calls[0][2]?.timeoutMs, undefined);
	});
}
