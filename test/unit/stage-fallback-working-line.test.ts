import { stripVTControlCharacters } from "node:util";
import type { AgentSessionEvent } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import {
	type AgentSession,
	type AgentSessionAdapter,
	assert,
	createStageContext,
	type InternalStageContext,
	makeMockSession,
	makeOpts,
} from "./stage-runner-helpers.js";

const PRIMARY = "anthropic/primary";
const FALLBACK = "openai/fallback";

let now = 0;
beforeEach(() => {
	initTheme("dark");
	now = 1_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
	vi.restoreAllMocks();
});

function modelOf(options: { model?: unknown }): string {
	const model = options.model as string | { provider?: string; id?: string } | undefined;
	return typeof model === "string" ? model : `${String(model?.provider)}/${model?.id}`;
}

/**
 * A stage whose primary model answers its request with `404 model not found` after `primaryMs`, and whose fallback
 * model answers after `fallbackMs`. `fallbackUnavailable` fails the fallback's first session before any request.
 */
function stageWithFallback(options: { primaryMs: number; fallbackMs: number; fallbackUnavailable?: boolean }) {
	let fallbackSessions = 0;
	const agentSession: AgentSessionAdapter = {
		async create(createOptions) {
			const model = modelOf(createOptions);
			if (model === FALLBACK && (fallbackSessions++ === 0 && options.fallbackUnavailable) === true)
				throw new Error("Unknown model: openai/fallback is unavailable");
			const messages: AgentSession["messages"] = [];
			const { session, emit } = makeMockSession({
				messages,
				async prompt() {
					emit({ type: "agent_start" });
					emit({ type: "turn_start" });
					if (model === PRIMARY) {
						now += options.primaryMs;
						messages.push({
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "404 model not found",
							timestamp: now,
						} as unknown as AgentSession["messages"][number]);
					} else {
						now += options.fallbackMs;
						messages.push({
							role: "assistant",
							content: [{ type: "text", text: "Fixed the picker." }],
							stopReason: "stop",
							usage: {
								input: 100,
								output: 200,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 300,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							timestamp: now,
						} as unknown as AgentSession["messages"][number]);
					}
					emit({ type: "agent_end", messages: [] });
				},
				getLastAssistantText() {
					return model === FALLBACK ? "Fixed the picker." : undefined;
				},
			});
			return session;
		},
	};
	const ctx = createStageContext(
		makeOpts({ adapters: { agentSession }, stageOptions: { model: PRIMARY, fallbackModels: [FALLBACK] } }),
	) as InternalStageContext;
	// The chat host a stage chat draws, fed by the stage's own subscription, as the stage chat feeds it.
	const chat = new ChatSessionHost({ style: themedChatHostStyle(), editorTheme: getEditorTheme() });
	const unsubscribe = ctx.subscribe((event) => chat.applyAgentEvent(event as AgentSessionEvent));
	return {
		ctx,
		status: () =>
			chat
				.renderWorkingStatus(100)
				.map((line) => stripVTControlCharacters(line).trimEnd())
				.filter((line) => line.length > 0),
		async dispose() {
			unsubscribe();
			chat.dispose();
			await ctx.__dispose();
		},
	};
}

describe("a stage chat's working line across the stage's own model fallback (#5535)", () => {
	test("the turn on the fallback model counts from the turn's start (#5535)", async () => {
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 200 });
		try {
			assert.equal(await stage.ctx.prompt("Fix the picker"), "Fixed the picker.");
			const status = stage.status();
			assert.ok(
				status.some((line) => / for 6s/.test(line)),
				`the finished turn counts from the primary's request: ${status.join(" | ")}`,
			);
		} finally {
			await stage.dispose();
		}
	});

	test("a switch that never reaches its request ends the turn's count, and the next prompt counts on its own (#5535)", async () => {
		const stage = stageWithFallback({ primaryMs: 6_400, fallbackMs: 2_000, fallbackUnavailable: true });
		try {
			await assert.rejects(stage.ctx.prompt("Fix the picker"));
			const ended = stage.status();
			assert.ok(
				ended.some((line) => / for 6s/.test(line)) && !ended.some((line) => line.includes("switching model")),
				`the turn ends where its switch failed: ${ended.join(" | ")}`,
			);
			now = 60_000;
			assert.equal(await stage.ctx.prompt("Try again"), "Fixed the picker.");
			const next = stage.status();
			assert.ok(
				next.some((line) => / for 2s/.test(line)),
				`the next prompt counts from its own start: ${next.join(" | ")}`,
			);
		} finally {
			await stage.dispose();
		}
	});
});
