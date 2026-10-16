import assert from "node:assert/strict";
import { test, vi } from "vitest";
import planMode from "../examples/extensions/plan-mode/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { StorageUnavailableError } from "../src/core/storage/session/errors.ts";
import { normalizeBuildSystemPromptOptions } from "../src/core/system-prompt.ts";
import { assistantMsg, createTestExtensionsResult } from "./utilities.ts";

for (const action of ["progress", "completion"] as const) {
	test(`plan-mode ${action} remains retryable when persistence fails`, async () => {
		const failure = new StorageUnavailableError({ adapter: "test", location: "plan" }, new Error("save failed"));
		const append = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
		const send = vi.fn();
		const status = vi.fn();
		const loaded = await createTestExtensionsResult([
			(pi) => planMode({ ...pi, appendEntry: append, sendMessage: send, setActiveTools() {} }),
		]);
		const extension = loaded.extensions[0];
		const ctx = {
			sessionManager: {
				getEntries: () => [
					{
						type: "custom",
						customType: "plan-mode",
						data: {
							enabled: false,
							executing: true,
							todos: [{ step: 1, text: "Ship", completed: action === "completion" }],
						},
					},
				],
			},
			ui: {
				setStatus: status,
				setWidget() {},
				theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
			},
		} as ExtensionContext;
		await extension.handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, ctx);
		status.mockClear();
		const handler = extension.handlers.get(action === "progress" ? "turn_end" : "agent_end")![0];
		const event =
			action === "progress"
				? { type: "turn_end", turnIndex: 0, message: assistantMsg("[DONE:1]"), toolResults: [] }
				: { type: "agent_end", messages: [] };
		await assert.rejects(handler(event, ctx), (error: Error) => error === failure);
		assert.equal(status.mock.calls.length, 0, "failed saves do not publish progress");
		assert.equal(send.mock.calls.length, 0, "failed saves do not announce completion");
		const instructions = (await extension.handlers.get("before_agent_start")![0](
			{
				type: "before_agent_start",
				messageType: "user",
				prompt: "continue",
				systemPrompt: "",
				systemPromptOptions: normalizeBuildSystemPromptOptions({}),
			},
			ctx,
		)) as { message?: { content: string } };
		assert.ok(instructions.message, "execution remains active after a failed save");
		if (action === "progress") assert.match(instructions.message.content, /1\. Ship/);
		await handler(event, ctx);
		assert.equal(append.mock.calls.length, 2);
		if (action === "completion") assert.equal(send.mock.calls.length, 1);
		else assert.equal(status.mock.calls.length, 1);
	});
}
