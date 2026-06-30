import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPrintMode } from "../src/modes/print-mode.ts";

function assistantErrorMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage: "provider failure",
		timestamp: Date.now(),
	};
}

function createRuntimeHost(message: AssistantMessage) {
	const extensionRunner = {
		hasHandlers: (eventType: string) => eventType === "session_shutdown",
		emit: vi.fn(async () => {}),
	};
	const session = {
		sessionManager: { getHeader: () => undefined },
		agent: { waitForIdle: async () => {} },
		state: { messages: [message] },
		extensionRunner,
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
		getToolDefinition: vi.fn(() => undefined),
		prompt: vi.fn(async () => {}),
		reload: vi.fn(async () => {}),
	};
	return {
		session,
		newSession: vi.fn(async () => undefined),
		fork: vi.fn(async () => ({ selectedText: "" })),
		switchSession: vi.fn(async () => undefined),
		dispose: vi.fn(async () => {
			await extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		}),
		setRebindSession: vi.fn(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runPrintMode json errors", () => {
	it("returns non-zero without writing stderr when the final assistant turn fails", async () => {
		const runtimeHost = createRuntimeHost(assistantErrorMessage());
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const exitCode = await runPrintMode(runtimeHost as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "json",
		});

		expect(exitCode).toBe(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(runtimeHost.session.extensionRunner.emit).toHaveBeenCalledWith({
			type: "session_shutdown",
			reason: "quit",
		});
	});
});
