import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, AgentSessionEventListener, ExtensionBindings } from "../src/core/agent-session.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { createStructuredOutputTool } from "../src/core/tools/structured-output.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode, type PrintModeOptions } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeMessage = AssistantMessage | CustomMessage | ToolResultMessage;

const MISSING_INPUT_ERROR = "WorkflowHeadlessCommandError: missing input";
const RUN_MISSING_ERROR = "WorkflowHeadlessCommandError: run missing";

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: FakeMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn<(bindings: ExtensionBindings) => Promise<void>>>;
	subscribe: ReturnType<typeof vi.fn<(listener: AgentSessionEventListener) => () => void>>;
	emitEvent: (event: AgentSessionEvent) => void;
	getToolDefinition: ReturnType<typeof vi.fn<(name: string) => { structuredOutput?: true } | undefined>>;
	prompt: ReturnType<typeof vi.fn<(text: string, options?: { images?: ImageContent[] }) => Promise<void>>>;
	reload: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

type FakeRuntimeHost = {
	session: FakeSession;
	newSession: ReturnType<typeof vi.fn>;
	fork: ReturnType<typeof vi.fn>;
	switchSession: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	setRebindSession: ReturnType<typeof vi.fn>;
};

function createAssistantMessage(options?: {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: options?.text ? [{ type: "text", text: options.text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options?.stopReason ?? "stop",
		errorMessage: options?.errorMessage,
		timestamp: Date.now(),
	};
}

function createCustomMessage(options?: {
	content?: CustomMessage["content"];
	display?: boolean;
}): CustomMessage {
	return {
		role: "custom",
		customType: "test:custom",
		content: options?.content ?? "custom done",
		display: options?.display ?? true,
		timestamp: Date.now(),
	};
}

function createToolResultMessage(options: {
	toolCallId: string;
	toolName: string;
	text?: string;
	content?: ToolResultMessage["content"];
	details?: unknown;
	isError?: boolean;
}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		content: options.content ?? (options.text === undefined ? [] : [{ type: "text", text: options.text }]),
		...(options.details === undefined ? {} : { details: options.details }),
		isError: options.isError ?? false,
		timestamp: Date.now(),
	};
}

function createRuntimeHost(
	initialMessage: FakeMessage,
	options: { structuredOutputTools?: readonly string[] } = {},
): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [initialMessage] };
	const structuredOutputTools = new Set(options.structuredOutputTools ?? []);
	const eventListeners: AgentSessionEventListener[] = [];

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async (_bindings: ExtensionBindings) => {}),
		subscribe: vi.fn((listener: AgentSessionEventListener) => {
			eventListeners.push(listener);
			return () => {
				const index = eventListeners.indexOf(listener);
				if (index !== -1) eventListeners.splice(index, 1);
			};
		}),
		emitEvent: (event: AgentSessionEvent) => {
			for (const listener of [...eventListeners]) listener(event);
		},
		getToolDefinition: vi.fn((name: string) => (
			structuredOutputTools.has(name) ? { structuredOutput: true } : undefined
		)),
		prompt: vi.fn(async (_text: string, _options?: { images?: ImageContent[] }) => {}),
		reload: vi.fn(async () => {}),
	};

	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

function captureStdout(): string[] {
	const stdoutChunks: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation(
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			stdoutChunks.push(String(chunk));
			if (typeof encodingOrCallback === "function") {
				encodingOrCallback();
			} else {
				callback?.();
			}
			return true;
		},
	);
	return stdoutChunks;
}

async function runPrintModeWithFakeHost(runtimeHost: FakeRuntimeHost, options: PrintModeOptions): Promise<number> {
	return runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], options);
}

function emitWorkflowCommandError(bindings: ExtensionBindings | undefined, error: string): void {
	bindings?.onError?.({
		extensionPath: "command:workflow",
		event: "command",
		error,
	});
}

function emitLifecycleExtensionError(bindings: ExtensionBindings | undefined, error: string): void {
	bindings?.onError?.({
		extensionPath: "test-extension",
		event: "session_start",
		error,
	});
}

describe("runPrintMode", () => {
	it("emits session_shutdown in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc" }];

		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "Say done",
			initialImages: images,
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("Say done", { images });
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("emits session_shutdown in json mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;

		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "json",
			messages: ["hello"],
		});

		expect(exitCode).toBe(0);
		expect(session.prompt).toHaveBeenCalledWith("hello");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("issue #1156: prints final displayable workflow custom message content in text mode", async () => {
		const runtimeHost = createRuntimeHost(createCustomMessage({ content: "workflow completed\nresult: ok" }));
		const stdoutChunks = captureStdout();

		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toBe("workflow completed\nresult: ok\n");
		expect(runtimeHost.session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});

	it("prints trailing terminating structured_output tool-result content in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "stale" }), {
			structuredOutputTools: ["structured_output"],
		});
		const { session } = runtimeHost;
		const stdoutChunks = captureStdout();
		const finalJson = "{\n  \"ok\": true\n}";
		const structuredOutputTool = createStructuredOutputTool({
			schema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
		});
		const result = await structuredOutputTool.execute(
			"structured-call-1",
			{ ok: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: finalJson }]);
		expect(result.details).toEqual({ ok: true });

		session.prompt.mockImplementation(async () => {
			session.emitEvent({
				type: "tool_execution_end",
				toolCallId: "structured-call-1",
				toolName: "structured_output",
				result,
				isError: false,
			});
			session.state.messages.push(createToolResultMessage({
				toolCallId: "structured-call-1",
				toolName: "structured_output",
				content: result.content,
				details: result.details,
			}));
		});

		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "Return JSON with structured_output",
		});

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toBe(`${finalJson}\n`);
		expect(stdoutChunks.join("")).not.toContain("stale");
	});

	it("prints trailing terminating custom-named structured output tool-result content in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "stale" }), {
			structuredOutputTools: ["final_decision"],
		});
		const { session } = runtimeHost;
		const stdoutChunks = captureStdout();
		const finalJson = "{\n  \"approved\": true\n}";
		const structuredOutputTool = createStructuredOutputTool({
			name: "final_decision",
			schema: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
		});
		const result = await structuredOutputTool.execute(
			"custom-structured-call-1",
			{ approved: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: finalJson }]);
		expect(result.details).toEqual({ approved: true });

		session.prompt.mockImplementation(async () => {
			session.emitEvent({
				type: "tool_execution_end",
				toolCallId: "custom-structured-call-1",
				toolName: "final_decision",
				result,
				isError: false,
			});
			session.state.messages.push(createToolResultMessage({
				toolCallId: "custom-structured-call-1",
				toolName: "final_decision",
				content: result.content,
				details: result.details,
			}));
		});

		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "Return JSON with final_decision",
		});

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toBe(`${finalJson}\n`);
		expect(stdoutChunks.join("")).not.toContain("stale");
	});

	it("does not print trailing structured_output tool results without observed termination", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "stale" }), {
			structuredOutputTools: ["structured_output"],
		});
		const { session } = runtimeHost;
		const stdoutChunks = captureStdout();
		session.prompt.mockImplementation(async () => {
			session.emitEvent({
				type: "tool_execution_end",
				toolCallId: "structured-call-2",
				toolName: "structured_output",
				result: {
					content: [{ type: "text", text: "not final" }],
					details: { ok: false },
					terminate: false,
				},
				isError: false,
			});
			session.state.messages.push(createToolResultMessage({
				toolCallId: "structured-call-2",
				toolName: "structured_output",
				text: "not final",
			}));
		});
		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "Return JSON with structured_output",
		});
		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toBe("");
	});
	it("does not print terminating tool results from unrelated tools in text mode", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "stale" }));
		const { session } = runtimeHost;
		const stdoutChunks = captureStdout();
		session.prompt.mockImplementation(async () => {
			session.emitEvent({
				type: "tool_execution_end",
				toolCallId: "ask-call-1",
				toolName: "ask_user_question",
				result: {
					content: [{ type: "text", text: "unrelated final" }],
					details: {},
					terminate: true,
				},
				isError: false,
			});
			session.state.messages.push(createToolResultMessage({
				toolCallId: "ask-call-1",
				toolName: "ask_user_question",
				text: "unrelated final",
			}));
		});
		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "Ask a question",
		});
		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toBe("");
	});
	it("emits session_shutdown and returns non-zero on assistant error", async () => {
		const runtimeHost = createRuntimeHost(
			createAssistantMessage({ stopReason: "error", errorMessage: "provider failure" }),
		);
		const { session } = runtimeHost;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith("provider failure");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
	it("issue #1156: command-originated extension errors exit non-zero and suppress stale assistant output", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		let bindings: ExtensionBindings | undefined;
		session.bindExtensions.mockImplementation(async (nextBindings: ExtensionBindings) => {
			bindings = nextBindings;
		});
		session.prompt.mockImplementation(async () => {
			emitWorkflowCommandError(bindings, MISSING_INPUT_ERROR);
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const stdoutChunks = captureStdout();
		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "/workflow approval-required",
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(`Extension error (command:workflow): ${MISSING_INPUT_ERROR}`);
		expect(stdoutChunks.join("")).toBe("");
		expect(session.extensionRunner.emit).toHaveBeenCalledTimes(1);
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
	it("keeps zero exit code and final output for non-command extension errors", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "done" }));
		const { session } = runtimeHost;
		let bindings: ExtensionBindings | undefined;
		session.bindExtensions.mockImplementation(async (nextBindings: ExtensionBindings) => {
			bindings = nextBindings;
		});
		session.prompt.mockImplementation(async () => {
			emitLifecycleExtensionError(bindings, "transient extension failure");
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const stdoutChunks = captureStdout();
		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "hello",
		});
		expect(exitCode).toBe(0);
		expect(errorSpy).toHaveBeenCalledWith("Extension error (test-extension): transient extension failure");
		expect(stdoutChunks.join("")).toBe("done\n");
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
	it("prints later successful custom output after earlier command errors while keeping non-zero exit", async () => {
		const runtimeHost = createRuntimeHost(createAssistantMessage({ text: "stale answer" }));
		const { session } = runtimeHost;
		let bindings: ExtensionBindings | undefined;
		session.bindExtensions.mockImplementation(async (nextBindings: ExtensionBindings) => {
			bindings = nextBindings;
		});
		session.prompt.mockImplementation(async (text: string) => {
			if (text === "/workflow approval-required") {
				emitWorkflowCommandError(bindings, MISSING_INPUT_ERROR);
				return;
			}
			session.state.messages.push(createCustomMessage({ content: "later workflow completed" }));
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const stdoutChunks = captureStdout();
		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "/workflow approval-required",
			messages: ["write a normal answer"],
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(`Extension error (command:workflow): ${MISSING_INPUT_ERROR}`);
		expect(stdoutChunks.join("")).toBe("later workflow completed\n");
		expect(stdoutChunks.join("")).not.toContain("stale answer");
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
	it("issue #1156: command-originated extension errors suppress stale custom output", async () => {
		const runtimeHost = createRuntimeHost(createCustomMessage({ content: "stale workflow result" }));
		const { session } = runtimeHost;
		let bindings: ExtensionBindings | undefined;
		session.bindExtensions.mockImplementation(async (nextBindings: ExtensionBindings) => {
			bindings = nextBindings;
		});
		session.prompt.mockImplementation(async () => {
			emitWorkflowCommandError(bindings, RUN_MISSING_ERROR);
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const stdoutChunks = captureStdout();
		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
			initialMessage: "/workflow status definitely-missing",
		});
		expect(exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalledWith(`Extension error (command:workflow): ${RUN_MISSING_ERROR}`);
		expect(stdoutChunks.join("")).toBe("");
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
