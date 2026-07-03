import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AgentSession safety-refusal retry", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-safety-refusal-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession(streamFn: () => MockAssistantStream) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn,
		});
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("retries intercepted canned safety refusals and bounds them by maxRetries", async () => {
		// github-copilot GPT models under heavy contexts can intercept a request and
		// return exactly "I'm sorry, but I cannot assist with that request." with zero
		// usage and a spurious stopReason "length". That canned refusal must be
		// re-requested (not accepted as a final answer), and it must NOT reset the
		// retry counter, so repeated refusals still honor maxRetries (issue #1608).
		let callCount = 0;
		createSession(() => {
			callCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callCount <= 2) {
					const msg = createAssistantMessage("I'm sorry, but I cannot assist with that request.", {
						stopReason: "length",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "length", message: msg });
					return;
				}
				const msg = createAssistantMessage("Recovered after canned refusals");
				stream.push({ type: "start", partial: msg });
				stream.push({ type: "done", reason: "stop", message: msg });
			});
			return stream;
		});

		const events: string[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") events.push(`start:${event.attempt}:${event.errorMessage}`);
			if (event.type === "auto_retry_end") events.push(`end:success=${event.success}`);
		});

		await session.prompt("Test");

		// Two canned refusals -> two retries -> third call succeeds.
		expect(callCount).toBe(3);
		expect(events).toEqual([
			"start:1:Provider returned a canned safety refusal",
			"start:2:Provider returned a canned safety refusal",
			"end:success=true",
		]);
		expect(session.isRetrying).toBe(false);
		// The refusal messages must not remain in agent state as accepted answers.
		const assistantTexts = session.agent.state.messages
			.filter((m) => m.role === "assistant")
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text);
		expect(assistantTexts).toEqual(["Recovered after canned refusals"]);
	});

	it("only detects tightly-guarded canned safety refusals", () => {
		createSession(() => new MockAssistantStream());
		const probe = session as unknown as {
			_isSafetyRefusal(message: AssistantMessage): boolean;
		};

		// Observed interception shape: canned text, zero usage, stopReason "length".
		const intercepted = createAssistantMessage("I'm sorry, but I cannot assist with that request.", {
			stopReason: "length",
		});
		expect(probe._isSafetyRefusal(intercepted)).toBe(true);

		// Variants of the canned phrasing with a "stop" finish are also intercepted.
		expect(probe._isSafetyRefusal(createAssistantMessage("Sorry, I can't help with that."))).toBe(true);
		expect(probe._isSafetyRefusal(createAssistantMessage("I cannot comply with this request."))).toBe(true);

		// A model-authored refusal bills output tokens and must never be retried.
		const billedRefusal = createAssistantMessage("I'm sorry, but I cannot assist with that request.", {
			stopReason: "stop",
			usage: {
				input: 100,
				output: 12,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 112,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		expect(probe._isSafetyRefusal(billedRefusal)).toBe(false);

		// Ordinary answers, longer prose, tool calls, and error stops never match.
		expect(probe._isSafetyRefusal(createAssistantMessage("The fix is committed on the branch."))).toBe(false);
		expect(
			probe._isSafetyRefusal(
				createAssistantMessage(
					"I cannot assist with that request because the sandbox denies network access; here is an alternative approach instead.",
					{ stopReason: "length" },
				),
			),
		).toBe(false);
		expect(
			probe._isSafetyRefusal(
				createAssistantMessage("I'm sorry, but I cannot assist with that request.", {
					stopReason: "toolUse",
					content: [
						{ type: "text", text: "I'm sorry, but I cannot assist with that request." },
						{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } },
					],
				}),
			),
		).toBe(false);
		expect(
			probe._isSafetyRefusal(
				createAssistantMessage("I'm sorry, but I cannot assist with that request.", {
					stopReason: "error",
					errorMessage: "boom",
				}),
			),
		).toBe(false);
	});
});
