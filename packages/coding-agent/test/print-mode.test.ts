import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionBindings } from "../src/core/agent-session.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import type { SessionShutdownEvent } from "../src/index.ts";
import { runPrintMode, type PrintModeOptions } from "../src/modes/print-mode.ts";

type EmitEvent = SessionShutdownEvent;

type FakeExtensionRunner = {
	hasHandlers: (eventType: string) => boolean;
	emit: ReturnType<typeof vi.fn<(event: EmitEvent) => Promise<void>>>;
};

type FakeMessage = AssistantMessage | CustomMessage;

const MISSING_INPUT_ERROR = "WorkflowHeadlessCommandError: missing input";
const RUN_MISSING_ERROR = "WorkflowHeadlessCommandError: run missing";

type FakeSession = {
	sessionManager: { getHeader: () => object | undefined };
	agent: { waitForIdle: () => Promise<void> };
	state: { messages: FakeMessage[] };
	extensionRunner: FakeExtensionRunner;
	bindExtensions: ReturnType<typeof vi.fn<(bindings: ExtensionBindings) => Promise<void>>>;
	subscribe: ReturnType<typeof vi.fn<() => () => void>>;
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

function createRuntimeHost(initialMessage: FakeMessage): FakeRuntimeHost {
	const extensionRunner: FakeExtensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};

	const state = { messages: [initialMessage] };

	const session: FakeSession = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state,
		extensionRunner,
		bindExtensions: vi.fn(async (_bindings: ExtensionBindings) => {}),
		subscribe: vi.fn(() => () => {}),
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

	it("prints final displayable custom message content in text mode", async () => {
		const runtimeHost = createRuntimeHost(createCustomMessage({ content: "workflow completed\nresult: ok" }));
		const stdoutChunks = captureStdout();

		const exitCode = await runPrintModeWithFakeHost(runtimeHost, {
			mode: "text",
		});

		expect(exitCode).toBe(0);
		expect(stdoutChunks.join("")).toBe("workflow completed\nresult: ok\n");
		expect(runtimeHost.session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
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

	it("returns non-zero on extension command errors and still emits session_shutdown", async () => {
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
		expect(stdoutChunks.join("")).not.toContain("done");
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

	it("suppresses final custom output after extension command errors", async () => {
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
		expect(stdoutChunks.join("")).not.toContain("stale workflow result");
		expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
	});
});
