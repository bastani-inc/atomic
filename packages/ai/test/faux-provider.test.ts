import { afterEach, describe, expect, it } from "vitest";
import {
	complete,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
	stream,
	Type,
} from "../src/compat.ts";
import type { AssistantMessage, AssistantMessageEvent, Context } from "../src/types.ts";

async function collectEvents(streamResult: ReturnType<typeof stream>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of streamResult) {
		events.push(event);
	}
	return events;
}

/**
 * Builds a faux response whose content includes a public `fallback` boundary marker.
 * `fauxAssistantMessage` only accepts streamable blocks, and `FauxResponseStep` accepts a
 * whole `AssistantMessage`, so a hand-built content array is the minimal path to a fallback
 * block without adding unrequested production surface.
 */
function fauxMessageWithContent(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return { ...fauxAssistantMessage(""), content, stopReason };
}

const fallbackBlock = { type: "fallback", fromModel: "faux-declines", toModel: "faux-continues" } as const;

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

describe("faux provider", () => {
	it("registers a custom provider and estimates usage", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("hello world")]);

		const context: Context = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "hi there", timestamp: Date.now() }],
		};

		const response = await complete(registration.getModel(), context);
		expect(response.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(response.usage.input).toBeGreaterThan(0);
		expect(response.usage.output).toBeGreaterThan(0);
		expect(response.usage.totalTokens).toBe(response.usage.input + response.usage.output);
		expect(registration.state.callCount).toBe(1);
	});

	it("supports helper blocks for text, thinking, and tool calls", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage([fauxThinking("think"), fauxToolCall("echo", { text: "hi" }), fauxText("done")], {
				stopReason: "toolUse",
			}),
		]);

		const response = await complete(registration.getModel(), {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});

		expect(response.content).toEqual([
			{ type: "thinking", thinking: "think" },
			{ type: "toolCall", id: expect.any(String), name: "echo", arguments: { text: "hi" } },
			{ type: "text", text: "done" },
		]);
		expect(response.stopReason).toBe("toolUse");
	});

	it("supports multiple models with per-model reasoning and model-aware factories", async () => {
		const registration = registerFauxProvider({
			models: [
				{ id: "faux-fast", name: "Faux Fast", reasoning: false },
				{ id: "faux-thinker", name: "Faux Thinker", reasoning: true },
			],
		});
		registrations.push(registration);
		registration.setResponses([
			(_context, _options, _state, model) => fauxAssistantMessage(`${model.id}:${String(model.reasoning)}`),
			(_context, _options, _state, model) => fauxAssistantMessage(`${model.id}:${String(model.reasoning)}`),
		]);

		expect(registration.models.map((model) => model.id)).toEqual(["faux-fast", "faux-thinker"]);
		expect(registration.getModel()).toBe(registration.models[0]);
		expect(registration.getModel("faux-fast")?.reasoning).toBe(false);
		expect(registration.getModel("faux-thinker")?.reasoning).toBe(true);

		const fast = await complete(registration.getModel("faux-fast")!, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});
		const thinker = await complete(registration.getModel("faux-thinker")!, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});

		expect(fast.content).toEqual([{ type: "text", text: "faux-fast:false" }]);
		expect(thinker.content).toEqual([{ type: "text", text: "faux-thinker:true" }]);
	});

	it("rewrites api, provider, and model on returned messages", async () => {
		const registration = registerFauxProvider({
			api: "faux:test",
			provider: "faux-provider",
			models: [{ id: "faux-model" }],
		});
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("hello")]);

		const response = await complete(registration.getModel(), {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});

		expect(response.api).toBe("faux:test");
		expect(response.provider).toBe("faux-provider");
		expect(response.model).toBe("faux-model");
	});

	it("consumes queued responses in order and errors when exhausted", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		const first = await complete(registration.getModel(), context);
		const second = await complete(registration.getModel(), context);
		const exhausted = await complete(registration.getModel(), context);

		expect(first.content).toEqual([{ type: "text", text: "first" }]);
		expect(second.content).toEqual([{ type: "text", text: "second" }]);
		expect(exhausted.stopReason).toBe("error");
		expect(exhausted.errorMessage).toBe("No more faux responses queued");
		expect(registration.getPendingResponseCount()).toBe(0);
		expect(registration.state.callCount).toBe(3);
	});

	it("can replace and append queued responses", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("first")]);

		const context: Context = {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		};

		expect((await complete(registration.getModel(), context)).content).toEqual([{ type: "text", text: "first" }]);
		expect(registration.getPendingResponseCount()).toBe(0);

		registration.setResponses([fauxAssistantMessage("second")]);
		expect(registration.getPendingResponseCount()).toBe(1);
		expect((await complete(registration.getModel(), context)).content).toEqual([{ type: "text", text: "second" }]);

		registration.appendResponses([fauxAssistantMessage("third"), fauxAssistantMessage("fourth")]);
		expect(registration.getPendingResponseCount()).toBe(2);
		expect((await complete(registration.getModel(), context)).content).toEqual([{ type: "text", text: "third" }]);
		expect((await complete(registration.getModel(), context)).content).toEqual([{ type: "text", text: "fourth" }]);
		expect(registration.getPendingResponseCount()).toBe(0);
	});

	it("supports async response factories", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			async (context, _options, state) => fauxAssistantMessage(`${context.messages.length}:${state.callCount}`),
		]);

		const response = await complete(registration.getModel(), {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		});

		expect(response.content).toEqual([{ type: "text", text: "1:1" }]);
	});

	it("emits an error when a response factory throws", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			() => {
				throw new Error("boom");
			},
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type === "error") {
			expect(events[0].error.stopReason).toBe("error");
			expect(events[0].error.errorMessage).toBe("boom");
		}
	});

	it("rejects a queued response without a terminal stop reason", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("partial", { stopReason: "pending" })]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.some((event) => event.type === "done")).toBe(false);
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type === "error") {
			expect(terminal.error.stopReason).toBe("error");
			expect(terminal.error.errorMessage).toBe("Faux response ended without a stop reason");
		}
	});

	it("estimates prompt and output tokens from serialized context", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("done")]);

		const tool = {
			name: "echo",
			description: "Echo back text",
			parameters: Type.Object({ text: Type.String() }),
		};
		const context: Context = {
			systemPrompt: "sys",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "image", mimeType: "image/png", data: "abcd" },
					],
					timestamp: 1,
				},
				fauxAssistantMessage("prior"),
				{
					role: "toolResult",
					toolCallId: "tool-1",
					toolName: "echo",
					content: [{ type: "text", text: "tool out" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: [tool],
		};

		const response = await complete(registration.getModel(), context);
		const promptText = [
			"system:sys",
			"user:hello\n[image:image/png:4]",
			"assistant:prior",
			"toolResult:echo\ntool out",
			`tools:${JSON.stringify([tool])}`,
		].join("\n\n");
		const expectedPromptTokens = Math.ceil(promptText.length / 4);
		const expectedOutputTokens = Math.ceil("done".length / 4);

		expect(response.usage.input).toBe(expectedPromptTokens);
		expect(response.usage.output).toBe(expectedOutputTokens);
		expect(response.usage.cacheRead).toBe(0);
		expect(response.usage.cacheWrite).toBe(0);
		expect(response.usage.totalTokens).toBe(expectedPromptTokens + expectedOutputTokens);
	});

	it("does not share cache across sessions or requests without sessionId", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const first = await complete(registration.getModel(), context, {
			sessionId: "session-1",
			cacheRetention: "short",
		});
		expect(first.usage.cacheWrite).toBeGreaterThan(0);
		context.messages.push(first);
		context.messages.push({ role: "user", content: "follow up", timestamp: Date.now() + 1 });

		const second = await complete(registration.getModel(), context, {
			sessionId: "session-2",
			cacheRetention: "short",
		});
		expect(second.usage.cacheRead).toBe(0);
		expect(second.usage.cacheWrite).toBeGreaterThan(0);

		const third = await complete(registration.getModel(), context);
		expect(third.usage.cacheRead).toBe(0);
		expect(third.usage.cacheWrite).toBe(0);
	});

	it("simulates prompt caching per sessionId", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const context: Context = {
			systemPrompt: "Be concise.",
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const first = await complete(registration.getModel(), context, {
			sessionId: "session-1",
			cacheRetention: "short",
		});
		expect(first.usage.cacheRead).toBe(0);
		expect(first.usage.cacheWrite).toBeGreaterThan(0);

		context.messages.push(first);
		context.messages.push({ role: "user", content: "follow up", timestamp: Date.now() + 1 });

		const second = await complete(registration.getModel(), context, {
			sessionId: "session-1",
			cacheRetention: "short",
		});
		expect(second.usage.cacheRead).toBeGreaterThan(0);
		expect(second.usage.input + second.usage.cacheRead).toBeGreaterThan(second.usage.input);
	});

	it("does not simulate caching when cacheRetention is none", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		await complete(registration.getModel(), context, { sessionId: "session-1", cacheRetention: "none" });
		context.messages.push(fauxAssistantMessage("first"));
		context.messages.push({ role: "user", content: "follow up", timestamp: Date.now() + 1 });
		const second = await complete(registration.getModel(), context, {
			sessionId: "session-1",
			cacheRetention: "none",
		});
		expect(second.usage.cacheRead).toBe(0);
		expect(second.usage.cacheWrite).toBe(0);
	});

	it("streams thinking, text, and partial tool call deltas", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("thinking text"),
					fauxText("answer text"),
					fauxToolCall("echo", { text: "hi", count: 12 }, { id: "tool-1" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const events: string[] = [];
		const toolCallDeltas: string[] = [];
		const s = stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
		for await (const event of s) {
			events.push(event.type);
			if (event.type === "toolcall_delta") {
				toolCallDeltas.push(event.delta);
			}
		}

		expect(events).toContain("thinking_start");
		expect(events).toContain("thinking_delta");
		expect(events).toContain("text_start");
		expect(events).toContain("text_delta");
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_delta");
		expect(events).toContain("toolcall_end");
		expect(toolCallDeltas.length).toBeGreaterThan(1);
		expect(JSON.parse(toolCallDeltas.join(""))).toEqual({ text: "hi", count: 12 });
	});

	it("streams an exact event order for fixed-size chunks", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 1, max: 1 } });
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage([fauxThinking("go"), fauxText("ok"), fauxToolCall("echo", {}, { id: "tool-1" })], {
				stopReason: "toolUse",
			}),
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events[0]).toMatchObject({ type: "start", partial: { stopReason: "pending" } });
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
	});

	it("streams multiple tool calls in one message", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { text: "one" }, { id: "tool-1" }),
					fauxToolCall("echo", { text: "two" }, { id: "tool-2" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
	});

	it("streams an explicit assistant error message as a terminal error", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 2, max: 2 } });
		registrations.push(registration);
		registration.setResponses([
			{
				...fauxAssistantMessage("partial"),
				stopReason: "error",
				errorMessage: "upstream failed",
			},
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
		const terminal = events[events.length - 1];
		expect(terminal.type).toBe("error");
		if (terminal.type === "error") {
			expect(terminal.reason).toBe("error");
			expect(terminal.error.stopReason).toBe("error");
			expect(terminal.error.errorMessage).toBe("upstream failed");
		}
	});

	it("streams an explicit assistant aborted message as a terminal error", async () => {
		const registration = registerFauxProvider({ tokenSize: { min: 2, max: 2 } });
		registrations.push(registration);
		registration.setResponses([
			{
				...fauxAssistantMessage("partial"),
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			},
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "error"]);
		const terminal = events[events.length - 1];
		expect(terminal.type).toBe("error");
		if (terminal.type === "error") {
			expect(terminal.reason).toBe("aborted");
			expect(terminal.error.stopReason).toBe("aborted");
			expect(terminal.error.errorMessage).toBe("Request was aborted");
		}
	});

	it("supports aborting before the first chunk", async () => {
		const registration = registerFauxProvider({ tokensPerSecond: 50, tokenSize: { min: 3, max: 3 } });
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz")]);

		const controller = new AbortController();
		controller.abort();
		const events = await collectEvents(
			stream(
				registration.getModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ signal: controller.signal },
			),
		);

		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("error");
		if (events[0].type === "error") {
			expect(events[0].reason).toBe("aborted");
			expect(events[0].error.stopReason).toBe("aborted");
		}
	});

	it("supports aborting mid-text stream when paced", async () => {
		const registration = registerFauxProvider({ tokensPerSecond: 100, tokenSize: { min: 3, max: 3 } });
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("abcdefghijklmnopqrstuvwxyz")]);

		const controller = new AbortController();
		const events: string[] = [];
		let textDeltaCount = 0;
		const s = stream(
			registration.getModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ signal: controller.signal },
		);
		for await (const event of s) {
			events.push(event.type);
			if (event.type === "text_delta") {
				textDeltaCount++;
				controller.abort();
			}
		}

		expect(textDeltaCount).toBe(1);
		expect(events).toContain("text_start");
		expect(events).toContain("text_delta");
		expect(events).toContain("error");
		expect(events).not.toContain("text_end");
	});

	it("supports aborting mid-thinking stream when paced", async () => {
		const registration = registerFauxProvider({ tokensPerSecond: 100, tokenSize: { min: 3, max: 3 } });
		registrations.push(registration);
		registration.setResponses([
			{
				...fauxAssistantMessage("ignored"),
				content: [{ type: "thinking", thinking: "abcdefghijklmnopqrstuvwxyz" }],
			},
		]);

		const controller = new AbortController();
		const events: string[] = [];
		let thinkingDeltaCount = 0;
		const s = stream(
			registration.getModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ signal: controller.signal },
		);
		for await (const event of s) {
			events.push(event.type);
			if (event.type === "thinking_delta") {
				thinkingDeltaCount++;
				controller.abort();
			}
		}

		expect(thinkingDeltaCount).toBe(1);
		expect(events).toContain("thinking_start");
		expect(events).toContain("thinking_delta");
		expect(events).toContain("error");
		expect(events).not.toContain("thinking_end");
	});

	it("supports aborting mid-toolcall stream when paced", async () => {
		const registration = registerFauxProvider({ tokensPerSecond: 100, tokenSize: { min: 3, max: 3 } });
		registrations.push(registration);
		registration.setResponses([
			{
				...fauxAssistantMessage("done"),
				content: [
					{
						type: "toolCall",
						id: "tool-1",
						name: "echo",
						arguments: { text: "abcdefghijklmnopqrstuvwxyz", count: 123456789 },
					},
				],
				stopReason: "toolUse",
			},
		]);

		const controller = new AbortController();
		const events: string[] = [];
		let toolCallDeltaCount = 0;
		const s = stream(
			registration.getModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ signal: controller.signal },
		);
		for await (const event of s) {
			events.push(event.type);
			if (event.type === "toolcall_delta") {
				toolCallDeltaCount++;
				controller.abort();
			}
		}

		expect(toolCallDeltaCount).toBe(1);
		expect(events).toContain("toolcall_start");
		expect(events).toContain("toolcall_delta");
		expect(events).toContain("error");
		expect(events).not.toContain("toolcall_end");
	});

	it("keeps content indices aligned when a fallback block sits between two text blocks", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxMessageWithContent([{ type: "text", text: "before" }, fallbackBlock, { type: "text", text: "after" }]),
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		// The stream must complete rather than dying on `partial.content[index]` being undefined.
		expect(events.map((event) => event.type)).not.toContain("error");
		expect(events.at(-1)?.type).toBe("done");

		// The fallback occupies source index 1, so the second text block stays at index 2.
		const textStarts = events.filter((event) => event.type === "text_start");
		expect(textStarts.map((event) => event.contentIndex)).toEqual([0, 2]);

		// Every event's contentIndex must address its own block inside `partial.content`.
		for (const event of events) {
			if (!("contentIndex" in event)) continue;
			const addressed = event.partial.content[event.contentIndex];
			expect(addressed).toBeDefined();
			expect(addressed.type).toBe(event.type.startsWith("text") ? "text" : addressed.type);
		}

		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.content).toEqual([
			{ type: "text", text: "before" },
			fallbackBlock,
			{ type: "text", text: "after" },
		]);
	});

	it("keeps tool-call indices aligned after a fallback block", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([
			fauxMessageWithContent(
				[
					{ type: "thinking", thinking: "weighing" },
					fallbackBlock,
					{ type: "toolCall", id: "call-1", name: "echo", arguments: { text: "hi" } },
					{ type: "text", text: "done" },
				],
				"toolUse",
			),
		]);

		const events = await collectEvents(
			stream(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		);

		expect(events.map((event) => event.type)).not.toContain("error");
		expect(events.at(-1)?.type).toBe("done");

		// `coding-agent/src/modes/json-event.ts` throws when `partial.content[contentIndex]`
		// is not the tool call the event announces, so assert that exact relationship here.
		const toolCallStart = events.find((event) => event.type === "toolcall_start");
		if (toolCallStart?.type !== "toolcall_start") throw new Error("expected a toolcall_start event");
		expect(toolCallStart.contentIndex).toBe(2);
		expect(toolCallStart.partial.content[toolCallStart.contentIndex]?.type).toBe("toolCall");

		const textStart = events.find((event) => event.type === "text_start");
		if (textStart?.type !== "text_start") throw new Error("expected a text_start event");
		expect(textStart.contentIndex).toBe(3);

		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.content.map((block) => block.type)).toEqual(["thinking", "fallback", "toolCall", "text"]);
	});

	it("unregisters the provider", async () => {
		const registration = registerFauxProvider();
		registration.setResponses([fauxAssistantMessage("hello")]);
		registration.unregister();

		await expect(
			complete(registration.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		).rejects.toThrow(`No API provider registered for api: ${registration.api}`);
	});
});
