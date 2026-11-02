import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

/** The planner's own time limit in these tests; real defaults are minutes. */
const PLANNING_TIME_LIMIT_MS = 300;
/** Generous bound for the whole turn; without a planning limit it never settles. */
const TURN_SETTLE_BOUND_MS = 15_000;
const CONTEXT_WINDOW = 100_000;
const RESERVE_TOKENS = 4_000;
const PLANNER_SYSTEM_MARKER = "You manage the working context of a coding assistant";

type PlannerBehavior = "trickles thinking forever" | "stalls after message_start";

interface ProviderRequest {
	kind: "planner" | "main";
	clientClosedEarly: boolean;
}

function sse(response: ServerResponse, event: string, data: object): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function messageStart(response: ServerResponse, inputTokens: number): void {
	sse(response, "message_start", {
		type: "message_start",
		message: {
			id: `msg_${Math.random().toString(36).slice(2)}`,
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: inputTokens, output_tokens: 1 },
		},
	});
}

function finishMessage(response: ServerResponse, stopReason: "tool_use" | "end_turn"): void {
	sse(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: 12 },
	});
	sse(response, "message_stop", { type: "message_stop" });
	response.end();
}

/**
 * Anthropic-compatible streaming provider. The first chat request calls a tool whose result
 * pushes the context over the compaction threshold; the compaction planner's request never
 * completes; every later chat request answers with text.
 */
async function startProvider(planner: PlannerBehavior) {
	const requests: ProviderRequest[] = [];
	const timers = new Set<ReturnType<typeof setInterval>>();
	let mainRequests = 0;
	const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const parsed = JSON.parse(body) as { system?: unknown };
		const record: ProviderRequest = {
			kind: JSON.stringify(parsed.system ?? "").includes(PLANNER_SYSTEM_MARKER) ? "planner" : "main",
			clientClosedEarly: false,
		};
		requests.push(record);
		response.on("close", () => {
			if (!response.writableEnded) record.clientClosedEarly = true;
		});
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		if (record.kind === "planner") {
			messageStart(response, CONTEXT_WINDOW / 2);
			if (planner === "trickles thinking forever") {
				sse(response, "content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "" },
				});
				const timer = setInterval(() => {
					sse(response, "content_block_delta", {
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "still ranking lines... " },
					});
				}, 20);
				timers.add(timer);
				response.on("close", () => {
					clearInterval(timer);
					timers.delete(timer);
				});
			}
			// Either way the body stays open: no content, no message_stop.
			return;
		}
		mainRequests += 1;
		// Just under the compaction threshold, so the tool result is what crosses it.
		messageStart(response, CONTEXT_WINDOW - RESERVE_TOKENS - 1_000);
		if (mainRequests === 1) {
			sse(response, "content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_large", name: "large_result", input: {} },
			});
			sse(response, "content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: "{}" },
			});
			sse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
			finishMessage(response, "tool_use");
			return;
		}
		sse(response, "content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		sse(response, "content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "finished after compaction" },
		});
		sse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
		finishMessage(response, "end_turn");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		close: async () => {
			for (const timer of timers) clearInterval(timer);
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function seededSessionManager(cwd: string): Promise<SessionManager> {
	const manager = SessionManager.inMemory(cwd);
	const now = Date.now() - 60_000;
	for (let turn = 0; turn < 12; turn++) {
		await manager.appendMessage({
			role: "user",
			content: `task ${turn}\nline a\nline b\nline c`,
			timestamp: now + turn * 2,
		});
		await manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `answer ${turn}\nline d\nline e\nline f` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 400 + turn * 10,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 420 + turn * 10,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now + turn * 2 + 1,
		});
	}
	return manager;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<"settled" | "pending"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(
				() => "settled" as const,
				() => "settled" as const,
			),
			new Promise<"pending">((resolve) => {
				timer = setTimeout(() => resolve("pending"), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sessionAgainst(baseUrl: string): Promise<AgentSession> {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-planning-time-limit-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const model = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		baseUrl,
		contextWindow: CONTEXT_WINDOW,
		maxTokens: 4_096,
	};
	const modelRuntime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test-key" } }),
		modelsPath: null,
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		thinkingLevel: "high",
		modelRuntime,
		sessionManager: await seededSessionManager(cwd),
		settingsManager: SettingsManager.inMemory({
			cacheWarming: "off",
			compaction: {
				enabled: true,
				reserveTokens: RESERVE_TOKENS,
				preserve_recent: 2,
				planningTimeoutMs: PLANNING_TIME_LIMIT_MS,
			},
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 },
		}),
		resourceLoader: createTestResourceLoader(),
		noTools: "builtin",
		customTools: [
			{
				name: "large_result",
				label: "Large result",
				description: "Returns a large result",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [{ type: "text" as const, text: "tool output line\n".repeat(300) }],
					details: {},
				}),
			},
		],
	});
	cleanups.push(async () => {
		await session.abort();
		session.dispose();
	});
	return session;
}

for (const planner of ["trickles thinking forever", "stalls after message_start"] as const) {
	test(`a turn continues when the post-tool compaction planner ${planner} (#4198)`, async () => {
		const provider = await startProvider(planner);
		cleanups.push(provider.close);
		const session = await sessionAgainst(provider.baseUrl);

		const turn = session.prompt("run the large tool");
		assert.equal(
			await settleWithin(turn, TURN_SETTLE_BOUND_MS),
			"settled",
			`the turn must not wait on a compaction planner past the planning time limit (provider requests: ${provider.requests.map((request) => request.kind).join(", ")})`,
		);
		await turn;

		assert.deepEqual(
			provider.requests.map((request) => request.kind),
			["main", "planner", "main"],
		);
		assert.equal(provider.requests[1]?.clientClosedEarly, true, "the timed-out planner request is cancelled");
		const boundary = session.sessionManager.getBranch().find((entry) => entry.type === "compaction");
		const details = boundary?.details as { rung?: string; freshReason?: string } | undefined;
		assert.equal(details?.rung, "fresh");
		assert.equal(details?.freshReason, `Compaction planning timed out after ${PLANNING_TIME_LIMIT_MS} ms`);
		assert.equal(session.getLastAssistantText(), "finished after compaction");
	});
}
