/**
 * Loopback `openai-completions` endpoint that keeps every agent of the view-latency benchmark streaming.
 *
 * The last user message of a request names the stream it belongs to:
 *
 * - `VL-STREAM <id>`: an endless agent loop. Each turn streams `deltasPerTurn` text deltas, one every
 *   `deltaIntervalMs`, then calls `read` on a small file; the tool result starts the next turn. Every delta carries a
 *   marker `ZQ<id><seq>` whose emit time is recorded, so a driver can time the moment the marker is painted.
 * - `VL-LAUNCH`: one turn that launches the benchmark's background load in parallel tool calls (background subagents
 *   that stream as `VL-STREAM u<k>`, and background shells), then a final answer once the tool results arrive.
 * - anything else: a one-line answer.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ModelServerOptions {
	readonly deltaIntervalMs: number;
	readonly deltasPerTurn: number;
	readonly subagents: number;
	readonly shells: number;
	readonly shellCommand: string;
	readonly subagentName: string;
	readonly readPath: string;
	readonly now: () => number;
}

export interface EmittedMarker {
	readonly stream: string;
	readonly atMs: number;
}

const FILLER = [
	"the stage keeps working through the queue",
	"reading the next file and checking its tests",
	"**bold step** with `inline code` and a [link](https://example.com)",
	"- a list item that wraps across the width of a narrow terminal pane",
	"comparing the transcript with the expected output",
	"> a quoted line from the tool result",
] as const;

export class ViewLatencyModelServer {
	readonly markers = new Map<string, EmittedMarker>();
	readonly requests = new Map<string, number>();
	private readonly server: Server;
	private readonly options: ModelServerOptions;
	private readonly open = new Set<ServerResponse>();
	private nextCallId = 0;

	constructor(options: ModelServerOptions) {
		this.options = options;
		this.server = createServer((request, response) => {
			void this.handle(request, response);
		});
	}

	async listen(): Promise<number> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
		return (this.server.address() as AddressInfo).port;
	}

	async close(): Promise<void> {
		for (const response of this.open) response.destroy();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		// Bodies carry the whole forked transcript; reading only its tail keeps this process off the measured path.
		const body = Buffer.concat(chunks).toString("utf8");
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		this.open.add(response);
		response.on("close", () => this.open.delete(response));
		const lastUser = body.lastIndexOf('"role":"user"');
		const nextMessage = lastUser < 0 ? -1 : body.indexOf('{"role":', lastUser);
		const prompt = lastUser < 0 ? "" : body.slice(lastUser, nextMessage < 0 ? undefined : nextMessage);
		const answered = nextMessage >= 0 && body.includes('"role":"tool"', nextMessage);
		const model = /"model":"([^"]+)"/.exec(body.slice(0, 512))?.[1] ?? "viewlat-model";
		const stream = /VL-STREAM (\w+)/.exec(prompt)?.[1];
		if (stream !== undefined) {
			this.requests.set(stream, (this.requests.get(stream) ?? 0) + 1);
			await this.streamTurn(response, model, stream);
			return;
		}
		if (prompt.includes("VL-LAUNCH")) {
			if (answered) this.answer(response, model, "Load launched.");
			else this.launchLoad(response, model);
			return;
		}
		this.answer(response, model, "ok");
	}

	private async streamTurn(response: ServerResponse, model: string, stream: string): Promise<void> {
		const { deltaIntervalMs, deltasPerTurn } = this.options;
		for (let index = 0; index < deltasPerTurn; index++) {
			if (response.destroyed) return;
			const seq = this.markers.size.toString(36).padStart(5, "0");
			const marker = `ZQ${stream}x${seq}`;
			const paragraph = index > 0 && index % 6 === 0 ? "\n\n" : " ";
			const text = `${paragraph}${marker} ${FILLER[index % FILLER.length]}`;
			this.markers.set(marker, { stream, atMs: this.options.now() });
			writeChunk(response, model, { content: text });
			await sleep(deltaIntervalMs);
		}
		if (response.destroyed) return;
		writeChunk(response, model, {
			tool_calls: [this.toolCall("read", { path: this.options.readPath })],
		});
		finish(response, model, "tool_calls");
	}

	private launchLoad(response: ServerResponse, model: string): void {
		const calls = [];
		if (this.options.subagents > 0) {
			calls.push(
				this.toolCall("subagent", {
					tasks: Array.from({ length: this.options.subagents }, (_, index) => ({
						agent: this.options.subagentName,
						task: `VL-STREAM u${index}`,
					})),
					wait: { kind: "background" },
				}),
			);
		}
		for (let index = 0; index < this.options.shells; index++) {
			calls.push(this.toolCall("bash", { command: this.options.shellCommand, wait: { kind: "background" } }));
		}
		writeChunk(response, model, { tool_calls: calls.map((call, index) => ({ ...call, index })) });
		finish(response, model, "tool_calls");
	}

	private answer(response: ServerResponse, model: string, text: string): void {
		writeChunk(response, model, { content: text });
		finish(response, model, "stop");
	}

	private toolCall(name: string, args: object) {
		return {
			index: 0,
			id: `call_vl_${++this.nextCallId}`,
			type: "function",
			function: { name, arguments: JSON.stringify(args) },
		};
	}
}

function writeChunk(response: ServerResponse, model: string, delta: object): void {
	response.write(
		`data: ${JSON.stringify({ id: "chatcmpl-vl", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
	);
}

function finish(response: ServerResponse, model: string, reason: "stop" | "tool_calls"): void {
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-vl",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: reason }],
			usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
		})}\n\n`,
	);
	response.write("data: [DONE]\n\n");
	response.end();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
