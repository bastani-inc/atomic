import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A reply the server streams for one request. A `hold` reply never finishes, as when the process dies mid-stream. */
export type ScriptedReply = { text: string } | { toolUse: { name: string; input: Record<string, unknown> } } | "hold";

/** One request body as the client serialized it. */
export interface RecordedRequest {
	body: string;
	json: AnthropicRequestBody;
}

export interface AnthropicRequestBody {
	model: string;
	system?: unknown[];
	tools?: unknown[];
	messages: Array<{ role: string; content: unknown }>;
	[key: string]: unknown;
}

/**
 * A local endpoint speaking the Anthropic Messages streaming protocol. It records every request body byte for byte
 * and answers with scripted replies, so a test can compare what a session sends before and after a resume.
 */
export class RecordingAnthropicServer {
	readonly requests: RecordedRequest[] = [];
	private readonly replies: ScriptedReply[] = [];
	private readonly held = new Set<ServerResponse>();

	private constructor(
		private readonly server: Server,
		readonly baseUrl: string,
	) {}

	static async start(): Promise<RecordingAnthropicServer> {
		let instance: RecordingAnthropicServer | undefined;
		const server = createServer((request, response) => {
			void instance?.handle(request, response);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		instance = new RecordingAnthropicServer(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		return instance;
	}

	/** Queue replies; once they run out, a request gets a text reply naming the last text it sent. */
	reply(...replies: ScriptedReply[]): void {
		this.replies.push(...replies);
	}

	/** Ends the streams held open by `hold` replies, as a process exit drops its connections. */
	dropHeld(): void {
		for (const response of this.held) response.destroy();
		this.held.clear();
	}

	async close(): Promise<void> {
		this.dropHeld();
		this.server.closeAllConnections();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST" || new URL(request.url ?? "/", this.baseUrl).pathname !== "/v1/messages") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const json = JSON.parse(body) as AnthropicRequestBody;
		this.requests.push({ body, json });
		const reply = this.replies.shift() ?? { text: `answer to ${lastText(json)}` };
		response.writeHead(200, { "content-type": "text/event-stream" });
		const send = (event: Record<string, unknown>) =>
			response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
		send({
			type: "message_start",
			message: {
				id: "msg_recorded",
				type: "message",
				role: "assistant",
				model: json.model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		});
		if (reply === "hold") {
			send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
			this.held.add(response);
			return;
		}
		if ("text" in reply) {
			send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } });
		} else {
			send({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: `toolu_${lastText(json).replace(/[^A-Za-z0-9]/g, "_")}`,
					name: reply.toolUse.name,
					input: {},
				},
			});
			send({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.toolUse.input) },
			});
		}
		send({ type: "content_block_stop", index: 0 });
		send({
			type: "message_delta",
			delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use" },
			usage: { output_tokens: 5 },
		});
		send({ type: "message_stop" });
		response.end();
	}
}

type Block = Record<string, unknown>;

/** The last text block a request sent, so a reply depends on the conversation and not on the order of requests. */
function lastText(request: AnthropicRequestBody): string {
	for (let index = request.messages.length - 1; index >= 0; index--) {
		const content = request.messages[index]!.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) continue;
		for (let block = content.length - 1; block >= 0; block--) {
			const candidate = content[block] as Block;
			if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
		}
	}
	return "";
}

function withoutMarker(block: unknown): unknown {
	if (typeof block !== "object" || block === null || Array.isArray(block)) return block;
	const { cache_control: _marker, ...rest } = block as Block;
	if (rest.type === "tool_result" && typeof rest.content === "string")
		return { ...rest, content: [{ type: "text", text: rest.content }] };
	return rest;
}

/**
 * A request without the cache markers Atomic moves to the newest input on every request, at the places the Messages
 * API takes them (system blocks, tool definitions, message content blocks), and with string message content as the
 * single text block it stands for. Everything else, tool schemas and arguments included, is kept byte for byte, so
 * comparing the JSON text of two normalized requests compares what the provider caches.
 */
export function withoutCacheMarkers(request: AnthropicRequestBody): AnthropicRequestBody {
	return {
		...request,
		...(Array.isArray(request.system) ? { system: request.system.map(withoutMarker) } : {}),
		...(Array.isArray(request.tools) ? { tools: request.tools.map(withoutMarker) } : {}),
		messages: request.messages.map((message) => ({
			...message,
			content:
				typeof message.content === "string"
					? [{ type: "text", text: message.content }]
					: Array.isArray(message.content)
						? message.content.map(withoutMarker)
						: message.content,
		})),
	};
}

/** Positions `[message, block]` of the content blocks that carry a cache marker. */
export function cacheMarkers(request: AnthropicRequestBody): Array<[number, number]> {
	const markers: Array<[number, number]> = [];
	request.messages.forEach((message, index) => {
		if (!Array.isArray(message.content)) return;
		message.content.forEach((block: { cache_control?: unknown }, blockIndex) => {
			if (block.cache_control) markers.push([index, blockIndex]);
		});
	});
	return markers;
}
