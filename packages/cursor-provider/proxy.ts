import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolveCursorRequestModelId, type CursorModel } from "./model-mapping.ts";
export type CursorProxyBridgeChunk =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; id: string; index: number; name: string; arguments: string }
	| { type: "tool_call_done"; id: string; index: number }
	| { type: "done"; finishReason?: "stop" | "tool_calls" };

export interface CursorProxyBridgeContext {
	accessToken: string;
	signal?: AbortSignal;
}

export interface CursorProxyBridge {
	chatCompletions(request: Record<string, unknown>, context: CursorProxyBridgeContext): AsyncIterable<CursorProxyBridgeChunk>;
}

export interface CursorProxyDependencies {
	accessToken: () => string | undefined;
	proxySecret: () => string;
	bridge: CursorProxyBridge;
	models?: () => CursorModel[];
}

export interface CursorProxyHandle {
	baseUrl: string;
	close(): void;
}

function json(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		status: init?.status ?? 200,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
}

function errorResponse(status: number, message: string): Response {
	return json({ error: { message, type: "cursor_provider_error" } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCursorNativeTools(payload: Record<string, unknown>): boolean {
	const tools = payload.tools;
	if (!Array.isArray(tools)) return false;
	return tools.some((tool) => {
		const record = isRecord(tool) ? tool : undefined;
		const fn = isRecord(record?.function) ? record.function : undefined;
		const name = typeof fn?.name === "string" ? fn.name : "";
		return name.startsWith("cursor.") || name.startsWith("cursor_") || name === "shell" || name === "filesystem";
	});
}

function sseLine(data: unknown): string {
	return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function openAiChunk(model: string, choices: Record<string, unknown>[]): Record<string, unknown> {
	return {
		id: `chatcmpl-cursor-${crypto.randomUUID()}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices,
	};
}

function openAiTextChunk(model: string, text: string): Record<string, unknown> {
	return openAiChunk(model, [{ index: 0, delta: { content: text }, finish_reason: null }]);
}

function openAiThinkingChunk(model: string, text: string): Record<string, unknown> {
	return openAiChunk(model, [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }]);
}

function openAiToolCallChunk(model: string, chunk: Extract<CursorProxyBridgeChunk, { type: "tool_call" }>): Record<string, unknown> {
	return openAiChunk(model, [
		{
			index: 0,
			delta: {
				tool_calls: [
					{
						index: chunk.index,
						id: chunk.id,
						type: "function",
						function: { name: chunk.name, arguments: chunk.arguments },
					},
				],
			},
			finish_reason: null,
		},
	]);
}

function openAiDoneChunk(model: string, finishReason: "stop" | "tool_calls" = "stop"): Record<string, unknown> {
	return openAiChunk(model, [{ index: 0, delta: {}, finish_reason: finishReason }]);
}

function hasValidProxyAuthorization(request: Request, deps: CursorProxyDependencies): boolean {
	const authorization = request.headers.get("authorization") ?? "";
	return authorization === `Bearer ${deps.proxySecret()}`;
}

function modelsResponse(models: CursorModel[]): Response {
	return json({ object: "list", data: models.map((model) => ({ id: model.id, object: "model" })) });
}

async function streamChatCompletions(payload: Record<string, unknown>, deps: CursorProxyDependencies): Promise<Response> {
	const accessToken = deps.accessToken();
	if (!accessToken) return errorResponse(401, "Cursor credentials are not available. Run /login cursor.");
	if (hasCursorNativeTools(payload)) {
		return errorResponse(400, "Cursor-native tools are not allowed; Atomic remains the tool authority.");
	}

	const requestedModel = typeof payload.model === "string" ? payload.model : "cursor";
	const model = resolveCursorRequestModelId(deps.models?.() ?? [], requestedModel, payload.reasoning_effort);
	const bridgePayload = model === requestedModel ? payload : { ...payload, model };
	const abortController = new AbortController();
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const encoder = new TextEncoder();
			const enqueueSse = (data: unknown) => controller.enqueue(encoder.encode(sseLine(data)));
			let finishReason: "stop" | "tool_calls" = "stop";
			try {
				for await (const chunk of deps.bridge.chatCompletions(bridgePayload, {
					accessToken,
					signal: abortController.signal,
				})) {
					switch (chunk.type) {
						case "text":
							enqueueSse(openAiTextChunk(model, chunk.text));
							break;
						case "thinking":
							enqueueSse(openAiThinkingChunk(model, chunk.text));
							break;
						case "tool_call":
							finishReason = "tool_calls";
							enqueueSse(openAiToolCallChunk(model, chunk));
							break;
						case "done":
							if (chunk.finishReason) finishReason = chunk.finishReason;
							break;
						case "tool_call_done":
							break;
					}
				}
				enqueueSse(openAiDoneChunk(model, finishReason));
				controller.enqueue(encoder.encode(sseLine("[DONE]")));
				controller.close();
			} catch (error) {
				enqueueSse({
					error: { message: error instanceof Error ? error.message : String(error), type: "cursor_bridge_error" },
				});
				controller.close();
			}
		},
		cancel() {
			abortController.abort();
		},
	});

	return new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		},
	});
}

export async function handleCursorProxyRequest(request: Request, deps: CursorProxyDependencies): Promise<Response> {
	const url = new URL(request.url);
	if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
		return errorResponse(403, "Cursor provider proxy only accepts localhost requests.");
	}

	if (!hasValidProxyAuthorization(request, deps)) {
		return errorResponse(401, "Cursor provider proxy unauthorized.");
	}

	if (request.method === "GET" && url.pathname === "/v1/models") {
		return modelsResponse(deps.models?.() ?? []);
	}

	if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
		return errorResponse(404, "Cursor provider proxy route not found.");
	}

	let payload: unknown;
	try {
		payload = await request.json();
	} catch {
		return errorResponse(400, "Expected JSON request body.");
	}
	if (!isRecord(payload)) return errorResponse(400, "Expected JSON object request body.");
	return streamChatCompletions(payload, deps);
}

function incomingHeadersToFetchHeaders(incoming: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(incoming.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(key, entry);
		} else {
			headers.set(key, value);
		}
	}
	return headers;
}

async function readIncomingBody(incoming: IncomingMessage): Promise<Uint8Array | undefined> {
	if (incoming.method === "GET" || incoming.method === "HEAD") return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of incoming) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

function serverPort(server: Server): number {
	const address = server.address();
	if (address && typeof address === "object") return address.port;
	throw new Error("Cursor provider proxy did not bind to a TCP port.");
}

async function writeFetchResponse(outgoing: ServerResponse, response: Response): Promise<void> {
	outgoing.statusCode = response.status;
	outgoing.statusMessage = response.statusText;
	response.headers.forEach((value, key) => outgoing.setHeader(key, value));

	if (!response.body) {
		outgoing.end();
		return;
	}

	const reader = response.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!outgoing.write(value)) await new Promise((resolve) => outgoing.once("drain", resolve));
		}
		outgoing.end();
	} catch (error) {
		outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
	} finally {
		reader.releaseLock();
	}
}

async function dispatchNodeRequestToFetchHandler(incoming: IncomingMessage, outgoing: ServerResponse, deps: CursorProxyDependencies, server: Server): Promise<void> {
	try {
		const port = serverPort(server);
		const host = incoming.headers.host && !Array.isArray(incoming.headers.host) ? incoming.headers.host : `127.0.0.1:${port}`;
		const url = new URL(incoming.url ?? "/", `http://${host}`);
		const body = await readIncomingBody(incoming);
		const request = new Request(url.toString(), {
			method: incoming.method,
			headers: incomingHeadersToFetchHeaders(incoming),
			body,
		});
		await writeFetchResponse(outgoing, await handleCursorProxyRequest(request, deps));
	} catch {
		if (!outgoing.headersSent) {
			outgoing.statusCode = 500;
			outgoing.setHeader("content-type", "application/json");
		}
		outgoing.end(JSON.stringify({ error: { message: "Cursor provider proxy adapter error.", type: "cursor_provider_error" } }));
	}
}

function listenOnLoopback(server: Server, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}

export async function startCursorProxy(deps: CursorProxyDependencies): Promise<CursorProxyHandle> {
	const requestedPort = Number(process.env.ATOMIC_CURSOR_PROVIDER_PORT ?? 0);
	const server = createServer((incoming, outgoing) => {
		void dispatchNodeRequestToFetchHandler(incoming, outgoing, deps, server);
	});
	await listenOnLoopback(server, Number.isFinite(requestedPort) ? requestedPort : 0);
	return {
		baseUrl: `http://127.0.0.1:${serverPort(server)}/v1`,
		close: () => server.close(),
	};
}
