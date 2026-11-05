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

test("plan-mode completes every step when the final message says the plan is done (pi #7950)", async () => {
	const append = vi.fn().mockResolvedValue(undefined);
	const send = vi.fn();
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
						todos: [
							{ step: 1, text: "Ship", completed: true },
							{ step: 2, text: "Announce", completed: false },
						],
					},
				},
			],
		},
		ui: {
			setStatus() {},
			setWidget() {},
			theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text },
		},
	} as ExtensionContext;
	await extension.handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, ctx);

	await extension.handlers.get("agent_end")![0](
		{ type: "agent_end", messages: [assistantMsg("All steps complete.")] },
		ctx,
	);

	assert.equal(send.mock.calls.length, 1);
	const [message, options] = send.mock.calls[0]!;
	assert.equal(message.customType, "plan-complete");
	assert.match(message.content, /~~Ship~~\n~~Announce~~/);
	assert.deepEqual(options, { deliverAs: "nextTurn" });
});

interface TodoState {
	step: number;
	text: string;
	completed: boolean;
}

async function startExecution(todos: TodoState[]) {
	const append = vi.fn().mockResolvedValue(undefined);
	const send = vi.fn();
	const widget = vi.fn();
	const loaded = await createTestExtensionsResult([
		(pi) => planMode({ ...pi, appendEntry: append, sendMessage: send, setActiveTools() {} }),
	]);
	const extension = loaded.extensions[0];
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ type: "custom", customType: "plan-mode", data: { enabled: false, executing: true, todos } },
			],
		},
		ui: {
			setStatus() {},
			setWidget: widget,
			theme: {
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				strikethrough: (text: string) => `~${text}~`,
			},
		},
	} as ExtensionContext;
	await extension.handlers.get("session_start")![0]({ type: "session_start", reason: "startup" }, ctx);
	return { extension, ctx, append, send, widget };
}

test("plan-mode keeps unfinished steps after a negated summary and clears them after confirmation (#4361)", async () => {
	const { extension, ctx, append, send } = await startExecution([{ step: 1, text: "Ship", completed: false }]);
	const finish = extension.handlers.get("agent_end")![0];
	await finish({ type: "agent_end", messages: [assistantMsg("Not all steps complete")] }, ctx);
	assert.equal(append.mock.calls.length, 0);
	assert.equal(send.mock.calls.length, 0);
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
	assert.ok(instructions.message);
	assert.match(instructions.message.content, /1\. Ship/);
	await finish({ type: "agent_end", messages: [assistantMsg("All steps are complete")] }, ctx);
	assert.equal(send.mock.calls.length, 1);
	assert.equal(send.mock.calls[0][0].customType, "plan-complete");
	assert.equal(append.mock.calls.length, 1);
});

function messageWithContent(content: Array<Record<string, unknown>>) {
	return { ...assistantMsg(""), content };
}

function lastWidgetLines(widget: ReturnType<typeof vi.fn>): string[] {
	const calls = widget.mock.calls.filter(([key]) => key === "plan-todos");
	return calls[calls.length - 1]![1] as string[];
}

test("plan-mode widget truncates only steps longer than 60 characters and styles completed steps", async () => {
	const sixty = "a".repeat(60);
	const sixtyOne = "b".repeat(61);
	const { widget } = await startExecution([
		{ step: 1, text: "Short", completed: false },
		{ step: 2, text: sixty, completed: false },
		{ step: 3, text: sixtyOne, completed: false },
		{ step: 4, text: "Done one", completed: true },
		{ step: 5, text: sixtyOne, completed: true },
	]);

	assert.deepEqual(lastWidgetLines(widget), [
		"<muted>☐ </muted>Short",
		`<muted>☐ </muted>${sixty}`,
		`<muted>☐ </muted>${"b".repeat(57)}...`,
		"<success>☑ </success><muted>~Done one~</muted>",
		`<success>☑ </success><muted>~${"b".repeat(57)}...~</muted>`,
	]);
});

test("plan-mode turn_end marks steps from thinking and prose across tool-call blocks", async () => {
	const { extension, ctx, append } = await startExecution([
		{ step: 1, text: "Ship", completed: false },
		{ step: 2, text: "Announce", completed: false },
		{ step: 3, text: "Celebrate", completed: false },
	]);
	const message = messageWithContent([
		{ type: "thinking", thinking: "[DONE:1]" },
		{ type: "text", text: "Step 2" },
		{ type: "toolCall", id: "call-1", name: "read", arguments: {} },
		{ type: "text", text: "done" },
	]);

	await extension.handlers.get("turn_end")![0]({ type: "turn_end", turnIndex: 0, message, toolResults: [] }, ctx);

	assert.equal(append.mock.calls.length, 1);
	const [customType, data] = append.mock.calls[0]!;
	assert.equal(customType, "plan-mode");
	assert.deepEqual(
		(data as { todos: TodoState[] }).todos.map((t) => t.completed),
		[true, true, false],
	);
});

test("plan-mode turn_end marks steps from visible text markers", async () => {
	const { extension, ctx, append, widget } = await startExecution([
		{ step: 1, text: "Ship", completed: false },
		{ step: 2, text: "Announce", completed: false },
	]);

	await extension.handlers.get("turn_end")![0](
		{ type: "turn_end", turnIndex: 0, message: assistantMsg("[DONE:2]"), toolResults: [] },
		ctx,
	);

	const [, data] = append.mock.calls[0]!;
	assert.deepEqual(
		(data as { todos: TodoState[] }).todos.map((t) => t.completed),
		[false, true],
	);
	assert.deepEqual(lastWidgetLines(widget), [
		"<muted>☐ </muted>Ship",
		"<success>☑ </success><muted>~Announce~</muted>",
	]);
});

test("plan-mode agent_end only completes the plan from the last assistant message", async () => {
	const { extension, ctx, send, append } = await startExecution([{ step: 1, text: "Ship", completed: false }]);
	const agentEnd = extension.handlers.get("agent_end")![0];

	await agentEnd(
		{ type: "agent_end", messages: [assistantMsg("All steps complete."), assistantMsg("Anything else?")] },
		ctx,
	);
	assert.equal(send.mock.calls.length, 0);
	assert.equal(append.mock.calls.length, 0);

	await agentEnd(
		{ type: "agent_end", messages: [assistantMsg("Working on it."), assistantMsg("All steps complete.")] },
		ctx,
	);
	assert.equal(send.mock.calls.length, 1);
	assert.match(send.mock.calls[0]![0].content, /~~Ship~~/);
});

test("plan-mode agent_end keeps executing when steps remain and the model does not claim completion", async () => {
	const { extension, ctx, send, append } = await startExecution([
		{ step: 1, text: "Ship", completed: true },
		{ step: 2, text: "Announce", completed: false },
	]);
	const agentEnd = extension.handlers.get("agent_end")![0];

	await agentEnd({ type: "agent_end", messages: [] }, ctx);
	await agentEnd({ type: "agent_end", messages: [assistantMsg("Still working on step 2.")] }, ctx);

	assert.equal(send.mock.calls.length, 0);
	assert.equal(append.mock.calls.length, 0);
});
