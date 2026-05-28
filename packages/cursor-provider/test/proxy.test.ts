import { spawnSync } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { handleCursorProxyRequest, startCursorProxy } from "../proxy.ts";

const NODE_BINARY = process.env.FNM_MULTISHELL_PATH
	? `${process.env.FNM_MULTISHELL_PATH}/bin/node`
	: spawnSync("bash", ["-lc", "command -v node"], { encoding: "utf8" }).stdout.trim() || "node";

async function readSseData(response: Response): Promise<string[]> {
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice("data: ".length));
}

describe("Cursor OpenAI-compatible proxy", () => {
	it("imports under Node without a Bun global", () => {
		const script = `
			if (process.release.name !== 'node') throw new Error('Expected Node, got ' + process.release.name);
			if ('Bun' in globalThis) throw new Error('Node smoke unexpectedly has a Bun global');
			const { createJiti } = await import('jiti');
			const jiti = createJiti(process.cwd() + '/node-smoke.mjs', { interopDefault: false });
			await jiti.import('./packages/cursor-provider/debug.ts');
			await jiti.import('./packages/cursor-provider/proxy.ts');
			await jiti.import('./packages/cursor-provider/index.ts');
		`;
		const result = spawnSync(NODE_BINARY, ["--input-type=module", "--eval", script], {
			cwd: process.cwd(),
			encoding: "utf8",
			env: { ...process.env, ATOMIC_CURSOR_PROVIDER_PORT: "0" },
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("starts a Node-compatible loopback server and honors ATOMIC_CURSOR_PROVIDER_PORT", async () => {
		const previousPort = process.env.ATOMIC_CURSOR_PROVIDER_PORT;
		process.env.ATOMIC_CURSOR_PROVIDER_PORT = "0";
		const handle = await startCursorProxy({
			accessToken: () => "access-token",
			proxySecret: () => "proxy-secret",
			models: () => [{ id: "gpt-5", name: "GPT 5", reasoning: true, contextWindow: 100, maxTokens: 10 }],
			bridge: { async *chatCompletions() {} },
		});
		try {
			expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
			const response = await fetch(`${handle.baseUrl}/models`, { headers: { authorization: "Bearer proxy-secret" } });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ object: "list", data: [{ id: "gpt-5", object: "model" }] });
		} finally {
			handle.close();
			if (previousPort === undefined) delete process.env.ATOMIC_CURSOR_PROVIDER_PORT;
			else process.env.ATOMIC_CURSOR_PROVIDER_PORT = previousPort;
		}
	});

	it("routes chat completions to an injected bridge and streams OpenAI-style SSE chunks", async () => {
		const response = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
				headers: { authorization: "Bearer proxy-secret" },
			}),
			{
				accessToken: () => "access-token",
				proxySecret: () => "proxy-secret",
				bridge: {
					async *chatCompletions(request, context) {
						expect(context.accessToken).toBe("access-token");
						expect(request.model).toBe("gpt-5");
						yield { type: "text", text: "hello" };
						yield { type: "text", text: " world" };
					},
				},
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const chunks = await readSseData(response);
		expect(chunks.at(-1)).toBe("[DONE]");
		expect(chunks.slice(0, -2).map((chunk) => JSON.parse(chunk).choices[0].delta.content)).toEqual([
			"hello",
			" world",
		]);
		expect(JSON.parse(chunks.at(-2)!).choices[0].finish_reason).toBe("stop");
	});

	it("maps Cursor thinking chunks to OpenAI reasoning_content without answer content", async () => {
		const response = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "think" }] }),
				headers: { authorization: "Bearer proxy-secret" },
			}),
			{
				accessToken: () => "access-token",
				proxySecret: () => "proxy-secret",
				bridge: {
					async *chatCompletions() {
						yield { type: "thinking", text: "working it out" };
						yield { type: "text", text: "final answer" };
					},
				},
			},
		);

		const chunks = await readSseData(response);
		const thinkingDelta = JSON.parse(chunks[0]!).choices[0].delta;
		const textDelta = JSON.parse(chunks[1]!).choices[0].delta;
		expect(thinkingDelta).toEqual({ reasoning_content: "working it out" });
		expect(thinkingDelta.content).toBeUndefined();
		expect(textDelta).toEqual({ content: "final answer" });
		expect(JSON.parse(chunks.at(-2)!).choices[0].finish_reason).toBe("stop");
		expect(chunks.at(-1)).toBe("[DONE]");
	});

	it("maps Cursor tool-call chunks to OpenAI delta.tool_calls with distinct indexes and tool_calls finish", async () => {
		const response = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", stream: true, messages: [{ role: "user", content: "read" }] }),
				headers: { authorization: "Bearer proxy-secret" },
			}),
			{
				accessToken: () => "access-token",
				proxySecret: () => "proxy-secret",
				bridge: {
					async *chatCompletions() {
						yield { type: "tool_call", id: "call_1", index: 0, name: "read", arguments: '{"path":"README.md"}' };
						yield { type: "tool_call", id: "call_2", index: 1, name: "grep", arguments: '{"pattern":"TODO"}' };
						yield { type: "done", finishReason: "tool_calls" };
					},
				},
			},
		);

		const chunks = await readSseData(response);
		const firstToolChunk = JSON.parse(chunks[0]!);
		const secondToolChunk = JSON.parse(chunks[1]!);
		expect(firstToolChunk.choices[0].delta.tool_calls).toEqual([
			{
				index: 0,
				id: "call_1",
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
			},
		]);
		expect(secondToolChunk.choices[0].delta.tool_calls).toEqual([
			{
				index: 1,
				id: "call_2",
				type: "function",
				function: { name: "grep", arguments: '{"pattern":"TODO"}' },
			},
		]);
		expect(JSON.parse(chunks[2]!).choices[0].finish_reason).toBe("tool_calls");
		expect(chunks.at(-1)).toBe("[DONE]");
	});

	it("requires proxy authorization before exposing /v1/models", async () => {
		let modelCalls = 0;
		let accessTokenCalls = 0;
		let bridgeCalls = 0;
		const deps = {
			accessToken: () => {
				accessTokenCalls++;
				return "token";
			},
			proxySecret: () => "proxy-secret",
			models: () => {
				modelCalls++;
				return [{ id: "gpt-5", name: "GPT 5", reasoning: true, contextWindow: 100, maxTokens: 10 }];
			},
			bridge: {
				async *chatCompletions() {
					bridgeCalls++;
				},
			},
		};

		const missing = await handleCursorProxyRequest(new Request("http://127.0.0.1:9999/v1/models"), deps);
		const wrong = await handleCursorProxyRequest(new Request("http://127.0.0.1:9999/v1/models", { headers: { authorization: "Bearer wrong" } }), deps);

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(modelCalls).toBe(0);
		expect(accessTokenCalls).toBe(0);
		expect(bridgeCalls).toBe(0);
	});

	it("exposes an authorized /v1/models diagnostic route", async () => {
		const response = await handleCursorProxyRequest(new Request("http://127.0.0.1:9999/v1/models", { headers: { authorization: "Bearer proxy-secret" } }), {
			accessToken: () => "token",
			proxySecret: () => "proxy-secret",
			models: () => [
				{ id: "gpt-5", name: "GPT 5", reasoning: true, contextWindow: 100, maxTokens: 10 },
				{ id: "composer-1", name: "Composer 1", reasoning: false, contextWindow: 50, maxTokens: 5 },
			],
			bridge: { async *chatCompletions() {} },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ object: "list", data: [{ id: "gpt-5", object: "model" }, { id: "composer-1", object: "model" }] });
	});

	it("rejects missing or invalid proxy authorization before credentials or bridge calls", async () => {
		let accessTokenCalls = 0;
		let bridgeCalls = 0;
		const deps = {
			accessToken: () => {
				accessTokenCalls++;
				return "access-token";
			},
			proxySecret: () => "proxy-secret",
			bridge: {
				async *chatCompletions() {
					bridgeCalls++;
				},
			},
		};

		const missing = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", messages: [] }),
			}),
			deps,
		);
		const wrong = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", messages: [] }),
				headers: { authorization: "Bearer wrong" },
			}),
			deps,
		);

		expect(missing.status).toBe(401);
		expect(wrong.status).toBe(401);
		expect(accessTokenCalls).toBe(0);
		expect(bridgeCalls).toBe(0);
	});

	it("passes resolved Cursor reasoning variant model ids to the bridge", async () => {
		let bridgedModel: unknown;
		const response = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", reasoning_effort: "high", messages: [] }),
				headers: { authorization: "Bearer proxy-secret" },
			}),
			{
				accessToken: () => "access-token",
				proxySecret: () => "proxy-secret",
				models: () => [
					{
						id: "gpt-5",
						name: "GPT 5",
						reasoning: true,
						contextWindow: 100,
						maxTokens: 10,
						rawVariants: [
							{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
							{ id: "gpt-5-high-fast", name: "GPT 5 High Fast", reasoning: true, contextWindow: 100, maxTokens: 10 },
						],
					},
				],
				bridge: {
					async *chatCompletions(request) {
						bridgedModel = request.model;
						yield { type: "done", finishReason: "stop" };
					},
				},
			},
		);

		expect(response.status).toBe(200);
		await response.text();
		expect(bridgedModel).toBe("gpt-5-high-fast");
	});

	it("passes raw variants for deduped models when reasoning effort is absent or unavailable", async () => {
		const bridgedModels: unknown[] = [];
		const deps = {
			accessToken: () => "access-token",
			proxySecret: () => "proxy-secret",
			models: () => [
				{
					id: "gpt-5",
					name: "GPT 5",
					reasoning: true,
					contextWindow: 100,
					maxTokens: 10,
					rawVariants: [
						{ id: "gpt-5-low", name: "GPT 5 Low", reasoning: true, contextWindow: 100, maxTokens: 10 },
						{ id: "gpt-5-high-fast", name: "GPT 5 High Fast", reasoning: true, contextWindow: 100, maxTokens: 10 },
					],
				},
			],
			bridge: {
				async *chatCompletions(request: Record<string, unknown>) {
					bridgedModels.push(request.model);
					yield { type: "done" as const, finishReason: "stop" as const };
				},
			},
		};

		const absent = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", messages: [] }),
				headers: { authorization: "Bearer proxy-secret" },
			}),
			deps,
		);
		const unavailable = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "gpt-5", reasoning_effort: "medium", messages: [] }),
				headers: { authorization: "Bearer proxy-secret" },
			}),
			deps,
		);

		expect(absent.status).toBe(200);
		expect(unavailable.status).toBe(200);
		await absent.text();
		await unavailable.text();
		expect(bridgedModels).toEqual(["gpt-5-low", "gpt-5-low"]);
	});

	it("rejects Cursor-native tool attempts so Atomic remains the tool authority", async () => {
		const response = await handleCursorProxyRequest(
			new Request("http://127.0.0.1:9999/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({
					model: "gpt-5",
					messages: [{ role: "user", content: "hi" }],
					tools: [{ type: "function", function: { name: "cursor.shell", parameters: {} } }],
				}),
				headers: { authorization: "Bearer proxy-secret" },
			}),
			{ accessToken: () => "token", proxySecret: () => "proxy-secret", bridge: { async *chatCompletions() {} } },
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("Cursor-native tools") } });
	});
});
