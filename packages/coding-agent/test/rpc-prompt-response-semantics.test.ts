import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@bastani/pi-ai/compat";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { withNormalRpcEnvironment } from "./normal-rpc-environment.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

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
		model: "claude-sonnet-4-5",
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
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<Api>;
	unsupportedFallback?: boolean;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	let modelTurns = 0;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			modelTurns += 1;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}
	const modelRegistry = await createModelRegistry(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	const fallbackWarning =
		"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";
	const runtimeHost = {
		modelFallbackMessage: options.unsupportedFallback ? fallbackWarning : undefined,
		modelFallbackReason: options.unsupportedFallback ? "configured-provider-unsupported" : undefined,
		session,
		services: { agentDir: tempDir },
		newSession: vi.fn(async function (this: { modelFallbackMessage?: string; modelFallbackReason?: string }) {
			this.modelFallbackMessage = fallbackWarning;
			this.modelFallbackReason = "configured-provider-unsupported";
			return { cancelled: false };
		}),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		resolveModelFallback: vi.fn(function (this: { modelFallbackMessage?: string; modelFallbackReason?: string }) {
			this.modelFallbackMessage = undefined;
			this.modelFallbackReason = undefined;
		}),
		resolveModelFallbackAfterExplicitModelSelection: vi.fn(function (
			this: { modelFallbackMessage?: string; modelFallbackReason?: string },
			previous: Model<Api> | undefined,
			selected: Model<Api> | null | undefined,
		) {
			if (selected && (!previous || previous.provider !== selected.provider || previous.id !== selected.id)) {
				this.modelFallbackMessage = undefined;
				this.modelFallbackReason = undefined;
			}
		}),
	} as unknown as AgentSessionRuntime;

	Object.defineProperty(runtimeHost, "modelTurns", { get: () => modelTurns });
	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<Api>;
	unsupportedFallback?: boolean;
}): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
	runtimeHost: AgentSessionRuntime;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	withNormalRpcEnvironment(() => {
		void runRpcMode(runtimeHost);
	});
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup, runtimeHost };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("blocks unsupported prompts but stays live for set_model recovery", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("missing recovery model");
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			model,
			unsupportedFallback: true,
		});
		const warning =
			"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";

		try {
			lineHandler(JSON.stringify({ id: "blocked", type: "prompt", message: "Do not send" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "blocked")).toEqual([
					expect.objectContaining({ success: false, error: warning }),
				]);
			});
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type !== "response")).toEqual([]);
			expect(rpcIo.outputLines.join("\n")).not.toContain("API key");

			lineHandler(JSON.stringify({ id: "catalog", type: "get_available_models" }));
			lineHandler(JSON.stringify({ id: "recover", type: "set_model", provider: model.provider, modelId: model.id }));
			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				expect(records.some((record) => record.id === "catalog" && record.success === true)).toBe(true);
				expect(records.some((record) => record.id === "recover" && record.success === true)).toBe(true);
			});

			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "after", type: "prompt", message: "Now run" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "after")).toEqual([
					expect.objectContaining({ success: true }),
				]);
			});

			lineHandler(JSON.stringify({ id: "replace", type: "new_session" }));
			await vi.waitFor(() => {
				expect(
					parseOutputLines(rpcIo.outputLines).some((record) => record.id === "replace" && record.success === true),
				).toBe(true);
			});
			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "blocked-again", type: "prompt", message: "blocked again" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "blocked-again")).toEqual([
					expect.objectContaining({ success: false, error: warning }),
				]);
			});
		} finally {
			await cleanup();
		}
	});

	it("clears the unsupported prompt lock only after a successful changed cycle", async () => {
		const initial = getModel("anthropic", "claude-sonnet-4-5");
		const selected = getModel("anthropic", "claude-haiku-4-5");
		if (!initial || !selected) throw new Error("missing cycle models");
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			model: initial,
			unsupportedFallback: true,
		});
		const lock = (): void => {
			runtimeHost.modelFallbackMessage =
				"Configured default model is unavailable or unsupported. Update defaultProvider/defaultModel or use /model.";
			runtimeHost.modelFallbackReason = "configured-provider-unsupported";
		};
		const cycle = vi.spyOn(runtimeHost.session, "cycleModel");

		try {
			cycle.mockImplementationOnce(async () => {
				runtimeHost.session.agent.state.model = selected;
				return { model: selected, thinkingLevel: "off", isScoped: false };
			});
			lineHandler(JSON.stringify({ id: "changed-cycle", type: "cycle_model" }));
			await vi.waitFor(() =>
				expect(
					parseOutputLines(rpcIo.outputLines).some(
						(record) => record.id === "changed-cycle" && record.success === true,
					),
				).toBe(true),
			);
			expect(runtimeHost.modelFallbackReason).toBeUndefined();
			lineHandler(JSON.stringify({ id: "after-cycle", type: "prompt", message: "run after cycle" }));
			await vi.waitFor(() =>
				expect(getPromptResponses(rpcIo.outputLines, "after-cycle")).toEqual([
					expect.objectContaining({ success: true }),
				]),
			);

			for (const [id, implementation] of [
				["null-cycle", async () => undefined],
				["same-cycle", async () => ({ model: { ...selected }, thinkingLevel: "high" as const, isScoped: false })],
				[
					"failed-cycle",
					async () => {
						throw new Error("cycle hook failed");
					},
				],
			] as const) {
				lock();
				cycle.mockImplementationOnce(implementation);
				lineHandler(JSON.stringify({ id, type: "cycle_model" }));
				await vi.waitFor(() =>
					expect(parseOutputLines(rpcIo.outputLines).some((record) => record.id === id)).toBe(true),
				);
				lineHandler(JSON.stringify({ id: `${id}-prompt`, type: "prompt", message: "must remain blocked" }));
				await vi.waitFor(() =>
					expect(getPromptResponses(rpcIo.outputLines, `${id}-prompt`)).toEqual([
						expect.objectContaining({ success: false }),
					]),
				);
			}
		} finally {
			await cleanup();
		}
	});

	it("resumes an accepted user tail once and makes completed replay a no-op", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const session = runtimeHost.session;
		session.agent.state.messages.push({
			role: "user",
			content: [{ type: "text", text: "accepted before disconnect" }],
			timestamp: Date.now(),
		});

		try {
			lineHandler(JSON.stringify({ id: "resume-1", type: "resume_unfinished_turn" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						id: "resume-1",
						command: "resume_unfinished_turn",
						success: true,
						data: { resumed: true, completed: false },
					}),
				);
			});
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_settled")).toBe(true);
			});
			expect((runtimeHost as AgentSessionRuntime & { modelTurns: number }).modelTurns).toBe(1);

			lineHandler(JSON.stringify({ id: "resume-2", type: "resume_unfinished_turn" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						id: "resume-2",
						data: { resumed: false, completed: true },
					}),
				);
			});
			expect((runtimeHost as AgentSessionRuntime & { modelTurns: number }).modelTurns).toBe(1);
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});
});
