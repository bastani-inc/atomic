import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { sleep } from "./runtime.js";

export interface ChatMessage {
	readonly role: string;
	readonly content?: string | readonly { readonly type: string; readonly text?: string }[] | null;
}

export interface ChatRequest {
	readonly messages: readonly ChatMessage[];
	readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
}

export interface ScriptedToolCall {
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface ScriptedReply {
	readonly text: string;
	readonly chunks: number;
	readonly chunkDelayMs: number;
	readonly toolCalls?: readonly ScriptedToolCall[];
}

export interface ScriptedChatServer {
	readonly baseUrl: string;
	readonly completed: string[];
	streaming(): number;
	close(): Promise<void>;
}

export function messageText(message: ChatMessage | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	return (content ?? []).map((part) => part.text ?? "").join("");
}

async function readBody(request: IncomingMessage): Promise<string> {
	const parts: Buffer[] = [];
	for await (const part of request) parts.push(part as Buffer);
	return Buffer.concat(parts).toString("utf8");
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	const body = {
		id: "scripted",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

async function stream(response: ServerResponse, reply: ScriptedReply): Promise<void> {
	response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	response.write(chunk({ role: "assistant", content: "" }));
	const size = Math.ceil(reply.text.length / Math.max(1, reply.chunks));
	for (let at = 0; at < reply.text.length; at += size) {
		await sleep(reply.chunkDelayMs);
		if (response.destroyed) return;
		response.write(chunk({ content: reply.text.slice(at, at + size) }));
	}
	const calls = reply.toolCalls ?? [];
	calls.forEach((call, index) => {
		response.write(
			chunk({
				tool_calls: [
					{
						index,
						id: `call_${index}_${Date.now()}`,
						type: "function",
						function: { name: call.name, arguments: JSON.stringify(call.arguments) },
					},
				],
			}),
		);
	});
	response.write(chunk({}, calls.length > 0 ? "tool_calls" : "stop"));
	const usage = { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 };
	response.write(
		`data: ${JSON.stringify({ id: "scripted", object: "chat.completion.chunk", choices: [], usage })}\n\n`,
	);
	response.end("data: [DONE]\n\n");
}

export async function startScriptedChatServer(
	script: (request: ChatRequest) => ScriptedReply & { readonly label: string },
): Promise<ScriptedChatServer> {
	const completed: string[] = [];
	let streaming = 0;
	const server = createServer((request, response) => {
		streaming++;
		void (async () => {
			const parsed = JSON.parse(await readBody(request)) as ChatRequest;
			const reply = script(parsed);
			await stream(response, reply);
			completed.push(reply.label);
		})()
			.catch(() => {
				if (!response.headersSent) response.writeHead(500);
				response.end();
			})
			.finally(() => {
				streaming--;
			});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		completed,
		streaming: () => streaming,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
