import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@bastani/pi-ai";
import { stream as streamOpenAICompletions } from "@bastani/pi-ai/api/openai-completions";
import { describe, it } from "vitest";
import type { AgentSession, AgentSessionAdapter, InternalStageContext } from "./stage-runner-helpers.js";
import { assert, createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

const STAGE_STREAM_TERMINAL_TIMEOUT_MS = 5_000;
const context: Context = { messages: [{ role: "user", content: "complete the task", timestamp: 1 }] };

function modelFor(baseUrl: string, candidate: string): Model<"openai-completions"> {
	const slash = candidate.lastIndexOf("/");
	const provider = slash === -1 ? "repro" : candidate.slice(0, slash);
	const id = slash === -1 ? candidate : candidate.slice(slash + 1);
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat: { supportsFinishReason: true, supportsUsageInStreaming: true },
	};
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function modelCandidate(value: AgentSession["model"] | string | undefined): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "repro/primary";
	return `${value.provider}/${value.id}`;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`stage did not settle within ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

async function startStreamServer(allowFallback: boolean): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	let requestCount = 0;
	const server = http.createServer((_request, response) => {
		requestCount += 1;
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		if (requestCount === 1 || !allowFallback) {
			// Emit one real provider event, then leave the body open. The adapter's
			// stream deadline must settle this request before HTTP idle timeout.
			response.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-stalled",
					object: "chat.completion.chunk",
					created: 1,
					model: "repro-model",
					choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
				})}\n\n`,
			);
			return;
		}

		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-fallback",
				object: "chat.completion.chunk",
				created: 1,
				model: "repro-fallback",
				choices: [{ index: 0, delta: { role: "assistant", content: "fallback answer" }, finish_reason: null }],
			})}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-fallback",
				object: "chat.completion.chunk",
				created: 1,
				model: "repro-fallback",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 2 },
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: async () => {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function makeStreamAdapter(baseUrl: string, configuredDeadline: number): AgentSessionAdapter {
	return {
		async create(options) {
			const candidate = modelCandidate(options.model as AgentSession["model"] | string | undefined);
			const model = modelFor(baseUrl, candidate);
			const messages: AgentSession["messages"] = [];
			const { session } = makeMockSession({
				model,
				messages,
				async prompt() {
					const events = streamOpenAICompletions(model, context, {
						apiKey: "test-key",
						maxRetries: 0,
						streamDeadlineMs: configuredDeadline,
					});
					let terminal: AssistantMessageEvent | undefined;
					for await (const event of events) {
						if (event.type === "done" || event.type === "error") terminal = event;
					}
					if (terminal?.type === "error") {
						messages.push(terminal.error);
						throw new Error(terminal.error.errorMessage ?? "provider stream failed");
					}
					if (terminal?.type !== "done") throw new Error("provider stream ended without a terminal event");
					messages.push(terminal.message);
					return assistantText(terminal.message);
				},
				getLastAssistantText() {
					const last = messages[messages.length - 1];
					return last?.role === "assistant" ? assistantText(last) : undefined;
				},
			});
			return session;
		},
	};
}

describe("provider stream to workflow stage terminal state (#2553)", () => {
	it("settles the stalled primary stream, falls back, and returns a terminal success", async () => {
		const server = await startStreamServer(true);
		try {
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession: makeStreamAdapter(server.baseUrl, 25) },
					stageOptions: { model: "repro/primary", fallbackModels: ["repro/fallback"] },
				}),
			) as InternalStageContext;

			const result = await settleWithin(ctx.prompt("complete"), STAGE_STREAM_TERMINAL_TIMEOUT_MS);

			assert.equal(result, "fallback answer");
			assert.deepEqual(ctx.__modelFallbackMeta().attemptedModels, ["repro/primary", "repro/fallback"]);
			assert.deepEqual(
				ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => attempt.success),
				[false, true],
			);
			await ctx.__dispose();
		} finally {
			await server.close();
		}
	});

	it("settles terminal failure when every candidate stream stalls", async () => {
		const server = await startStreamServer(false);
		try {
			const ctx = createStageContext(
				makeOpts({
					adapters: { agentSession: makeStreamAdapter(server.baseUrl, 25) },
					stageOptions: { model: "repro/primary", fallbackModels: ["repro/fallback"] },
				}),
			) as InternalStageContext;

			await assert.rejects(
				settleWithin(ctx.prompt("complete"), STAGE_STREAM_TERMINAL_TIMEOUT_MS),
				/stream deadline exceeded/i,
			);
			assert.deepEqual(ctx.__modelFallbackMeta().attemptedModels, ["repro/primary", "repro/fallback"]);
			await ctx.__dispose();
		} finally {
			await server.close();
		}
	});
});
