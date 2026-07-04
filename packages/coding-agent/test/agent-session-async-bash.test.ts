import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { EventStream, getModel, type AssistantMessage, type AssistantMessageEvent, type TextContent } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AsyncJobManager } from "../src/core/async/job-manager.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
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

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_500): Promise<void> {
	const start = Date.now();
	while (!(await predicate())) {
		if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function messageText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is TextContent => typeof part === "object" && part !== null && part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createSession(tempDir: string, onTurn: (userTexts: string[], stream: MockAssistantStream) => void): AgentSession {
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		convertToLlm,
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: (_model, context) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => onTurn(context.messages.filter((message) => message.role === "user").map(messageText), stream));
			return stream;
		},
	});
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, tempDir),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("AgentSession async bash auto-delivery", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-async-bash-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		AsyncJobManager.instance()?.dispose();
		AsyncJobManager.resetForTests();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("starts an idle follow-up turn from actual async bash completion", async () => {
		const turns: string[][] = [];
		session = createSession(tempDir, (userTexts, stream) => {
			turns.push(userTexts);
			stream.push({ type: "start", partial: createAssistantMessage("") });
			stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
		});
		const bash = session.getToolDefinition("bash");
		expect(bash).toBeDefined();
		await bash?.execute("bash-idle", { command: "printf idle-async", async: true });
		await waitFor(() => turns.some((turn) => turn.some((text) => text.includes("idle-async"))));
	});

	it("queues actual async bash completion as a follow-up while streaming and drains it after the turn", async () => {
		let finishFirstTurn: (() => void) | undefined;
		const turns: string[][] = [];
		session = createSession(tempDir, (userTexts, stream) => {
			turns.push(userTexts);
			stream.push({ type: "start", partial: createAssistantMessage("") });
			if (userTexts.some((text) => text.includes("streaming-async"))) {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("follow-up") });
				return;
			}
			finishFirstTurn = () => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("first") });
		});
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session?.isStreaming === true);
		const bash = session.getToolDefinition("bash");
		expect(bash).toBeDefined();
		await bash?.execute("bash-streaming", { command: "printf streaming-async", async: true });
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(turns.some((turn) => turn.some((text) => text.includes("streaming-async")))).toBe(false);
		finishFirstTurn?.();
		await firstPrompt;
		await waitFor(() => turns.some((turn) => turn.some((text) => text.includes("streaming-async"))));
	});

	it("suppresses a streaming-staged async result when polling acknowledges it before the follow-up drains", async () => {
		let finishFirstTurn: (() => void) | undefined;
		const turns: string[][] = [];
		session = createSession(tempDir, (userTexts, stream) => {
			turns.push(userTexts);
			stream.push({ type: "start", partial: createAssistantMessage("") });
			finishFirstTurn = () => stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
		});
		const firstPrompt = session.prompt("First message");
		await waitFor(() => session?.isStreaming === true);
		const bash = session.getToolDefinition("bash");
		expect(bash).toBeDefined();
		const started = await bash?.execute("bash-streaming-stale", { command: "printf stale-async", async: true });
		const jobId = started?.details?.async?.jobId;
		expect(jobId).toBeDefined();
		await waitFor(() => AsyncJobManager.instance()?.deliveryState().delivering === true);
		await waitFor(async () => {
			const polled = await bash?.execute("bash-poll-stale", { command: `__atomic_bash_job ${jobId}` });
			return polled?.content.some((item) => item.type === "text" && item.text.includes("stale-async")) === true;
		});
		finishFirstTurn?.();
		await firstPrompt;
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(turns.some((turn) => turn.some((text) => text.includes("stale-async")))).toBe(false);
	});
});
