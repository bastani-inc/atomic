/**
 * Session builder for the compaction rung-ladder integration matrix.
 *
 * Kept out of `*.test.ts` so `bun test test/integration` does not treat it as a suite.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { AgentSession, type AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";

export const SESSION_MODEL = getModel("anthropic", "claude-sonnet-4-5")!;
export const FALLBACK_MODEL = getModel("openai", "gpt-5.1")!;

export interface ScriptedTurn {
	text?: string;
	stopReason?: AssistantMessage["stopReason"];
	errorMessage?: string;
	reasoningTokens?: number;
}

export interface PlannerCall {
	provider: string;
	id: string;
	reasoning: ThinkingLevel | undefined;
	regionLines: number;
	/** `Target lines to keep` as stated in the planner prompt. */
	keepTarget: number | undefined;
}

/** Answer each planner request from a per-provider script; the last entry repeats. */
export function plannerScript(script: Record<string, ScriptedTurn[]>): { streamFn: StreamFn; calls: PlannerCall[] } {
	const calls: PlannerCall[] = [];
	const cursors = new Map<string, number>();
	const streamFn = ((
		model: Model<Api>,
		context: { messages: Array<{ content: Array<{ text?: string }> }> },
		options?: { reasoning?: ThinkingLevel },
	) => {
		const prompt = context.messages[0]?.content?.[0]?.text ?? "";
		const numbered = prompt.match(/^\d+→/gm)?.length ?? 0;
		const keepTarget = prompt.match(/^Target lines to keep: (\d+)$/m)?.[1];
		calls.push({
			provider: model.provider,
			id: model.id,
			reasoning: options?.reasoning,
			regionLines: numbered,
			keepTarget: keepTarget === undefined ? undefined : Number(keepTarget),
		});
		const entries = script[model.provider] ?? script.default ?? [{ text: "1,10\n" }];
		const index = Math.min(cursors.get(model.provider) ?? 0, entries.length - 1);
		cursors.set(model.provider, index + 1);
		const turn = entries[index];
		return {
			result: async (): Promise<AssistantMessage> =>
				({
					role: "assistant",
					content: turn.text === undefined ? [] : [{ type: "text", text: turn.text }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: turn.reasoningTokens ?? 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						...(turn.reasoningTokens === undefined ? {} : { reasoning: turn.reasoningTokens }),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: turn.stopReason ?? (turn.errorMessage ? "error" : "stop"),
					...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
					timestamp: Date.now(),
				}) as AssistantMessage,
		};
	}) as unknown as StreamFn;
	return { streamFn, calls };
}

export interface RungSession {
	session: AgentSession;
	agent: Agent;
	manager: SessionManager;
	events: AgentSessionEvent[];
	continueCalls: () => number;
	dispose: () => void;
}

export interface RungSessionOptions {
	streamFn: StreamFn;
	fallbackModels?: string[];
	thinkingLevel?: ThinkingLevel;
	contextWindow?: number;
	reserveTokens?: number;
	turns?: number;
	authenticateFallback?: boolean;
	/** Reported usage on each seeded assistant turn; drives the context estimate. */
	usageTokens?: number;
	/** Persist the session in this directory so diagnostic sidecars can be written. */
	sessionDir?: string;
}

function assistantTurn(text: string, timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: totalTokens,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as AssistantMessage;
}

export async function createRungSession(options: RungSessionOptions): Promise<RungSession> {
	const model =
		options.contextWindow === undefined
			? SESSION_MODEL
			: ({ ...SESSION_MODEL, contextWindow: options.contextWindow } as Model<Api>);
	const manager =
		options.sessionDir === undefined
			? SessionManager.inMemory()
			: SessionManager.create(options.sessionDir, options.sessionDir);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "test",
			tools: [],
			thinkingLevel: options.thinkingLevel ?? "high",
		},
		streamFn: options.streamFn,
	});
	let continued = 0;
	const realContinue = agent.continue.bind(agent);
	agent.continue = ((...args: Parameters<typeof realContinue>) => {
		continued += 1;
		return realContinue(...args);
	}) as typeof agent.continue;

	const authStorage = AuthStorage.inMemory({
		anthropic: { type: "api_key", key: "anthropic-key" },
		...(options.authenticateFallback === false ? {} : { openai: { type: "api_key" as const, key: "openai-key" } }),
	});
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	settingsManager.applyOverrides({
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		compaction: {
			enabled: true,
			compression_ratio: 0.5,
			preserve_recent: 2,
			...(options.reserveTokens === undefined ? {} : { reserveTokens: options.reserveTokens }),
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settingsManager,
		cwd: process.cwd(),
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
		fallbackModels: options.fallbackModels ?? [],
	});

	const now = Date.now();
	const usageTokens = options.usageTokens ?? 2;
	for (let turn = 0; turn < (options.turns ?? 8); turn++) {
		manager.appendMessage({ role: "user", content: `task ${turn}\nline a\nline b`, timestamp: now + turn * 2 });
		manager.appendMessage(assistantTurn(`answer ${turn}\nline c\nline d`, now + turn * 2 + 1, usageTokens));
	}
	agent.state.messages = manager.buildSessionContext().messages;

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));

	return {
		session,
		agent,
		manager,
		events,
		continueCalls: () => continued,
		dispose: () => session.dispose(),
	};
}

export function currentMessages(built: RungSession): AgentMessage[] {
	return built.agent.state.messages;
}
