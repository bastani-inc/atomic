/**
 * Stand-in model endpoint for the ask_user_question load scenario (#4333).
 *
 * `scripts/e2e/ask-user-question-load-evidence.sh` points the real CLI at this server. It routes each turn by the
 * newest item of the request's input, so one endpoint can serve the main chat, its subagents and every stage of
 * the pooled workflow:
 *
 * - the main chat's prompt (`AQ-LOAD-MAIN`) is answered with a real `subagent` call that starts streaming
 *   subagents in the background;
 * - that call's result is answered with a real `ask_user_question` call: four questions, two with previews, one
 *   multi-select and one plain;
 * - a prompt carrying `AQ-LOAD-STREAM` (each subagent's task and each pooled stage's prompt) streams text for
 *   `AQ_LOAD_STREAM_SECONDS` for a pooled stage and `AQ_LOAD_SUBAGENT_STREAM_SECONDS` for a subagent, which is the
 *   background load the dialog has to stay responsive under (a short stage keeps pooled children finishing and new
 *   ones starting while the subagents keep streaming);
 * - anything else gets a short completed message.
 *
 * Usage: bun ask-user-question-load-model-server.ts <state-dir>
 * Writes `<state-dir>/model-port` once listening on 127.0.0.1, and counts streaming turns in
 * `<state-dir>/streams-started`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { benchmarkQuestionnaire } from "../../../scripts/perf/ask-user-question-load/fixture.ts";

export const LOAD_MAIN_MARKER = "AQ-LOAD-MAIN";
export const LOAD_STREAM_MARKER = "AQ-LOAD-STREAM";
export const LOAD_MODEL_ID = "aqload-model";
export const LOAD_PROVIDER = "aqload";

const SUBAGENT_CALL_ID = "call_aq_load_subagents";
const SUBAGENTS = Number(process.env.AQ_LOAD_SUBAGENTS ?? 4);
const STREAM_SECONDS = Number(process.env.AQ_LOAD_STREAM_SECONDS ?? 300);
const SUBAGENT_STREAM_SECONDS = Number(process.env.AQ_LOAD_SUBAGENT_STREAM_SECONDS ?? 300);
const STREAM_DELTA_MS = 40;
const LIFETIME_MS = (Math.max(STREAM_SECONDS, SUBAGENT_STREAM_SECONDS) + 600) * 1000;

type OutputItem =
	| {
			readonly id: string;
			readonly call_id: string;
			readonly name: string;
			readonly arguments: string;
			readonly type: "function_call";
			readonly status: "in_progress" | "completed";
	  }
	| {
			readonly id: string;
			readonly type: "message";
			readonly role: "assistant";
			readonly status: "in_progress" | "completed";
			readonly content: readonly { readonly type: "output_text"; readonly text: string; readonly annotations: [] }[];
	  };

function sse(response: ServerResponse, event: object): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function open(response: ServerResponse): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
}

function complete(response: ServerResponse, responseId: string, output: readonly OutputItem[]): void {
	for (const [index, item] of output.entries())
		sse(response, { type: "response.output_item.done", output_index: index, item });
	sse(response, { type: "response.completed", response: { id: responseId, status: "completed", output } });
	response.end("data: [DONE]\n\n");
}

function toolCall(response: ServerResponse, callId: string, name: string, args: object): void {
	const call = { id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args) };
	open(response);
	sse(response, {
		type: "response.output_item.added",
		output_index: 0,
		item: { ...call, type: "function_call", status: "in_progress", arguments: "" },
	});
	sse(response, {
		type: "response.function_call_arguments.delta",
		output_index: 0,
		item_id: call.id,
		delta: call.arguments,
	});
	sse(response, {
		type: "response.function_call_arguments.done",
		output_index: 0,
		item_id: call.id,
		arguments: call.arguments,
	});
	complete(response, `resp_${callId}`, [{ ...call, type: "function_call", status: "completed" }]);
}

function message(id: string, text: string, status: "in_progress" | "completed"): OutputItem {
	return {
		id,
		type: "message",
		role: "assistant",
		status,
		content: status === "completed" ? [{ type: "output_text", text, annotations: [] }] : [],
	};
}

function textTurn(response: ServerResponse, turn: number): void {
	const id = `msg_aq_load_${turn}`;
	const text = "aq-load acknowledged";
	open(response);
	sse(response, { type: "response.output_item.added", output_index: 0, item: message(id, "", "in_progress") });
	sse(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: id, delta: text });
	complete(response, `resp_aq_load_${turn}`, [message(id, text, "completed")]);
}

/** Streams numbered status lines until the deadline or until the client goes away. */
function streamTurn(response: ServerResponse, turn: number, seconds: number): void {
	const id = `msg_aq_stream_${turn}`;
	open(response);
	sse(response, { type: "response.output_item.added", output_index: 0, item: message(id, "", "in_progress") });
	const deadline = Date.now() + seconds * 1000;
	let text = "";
	let line = 0;
	const timer = setInterval(() => {
		if (Date.now() >= deadline) {
			clearInterval(timer);
			complete(response, `resp_aq_stream_${turn}`, [message(id, text, "completed")]);
			return;
		}
		const delta = `stream ${turn} line ${line++}: reading files, running checks and reasoning about the change.\n`;
		text += delta;
		sse(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: id, delta });
	}, STREAM_DELTA_MS);
	response.on("close", () => clearInterval(timer));
}

/** The newest input item of an `openai-responses` request, serialized for marker matching. */
function newestInput(body: string): string {
	const parsed = JSON.parse(body) as { input?: readonly object[] };
	return JSON.stringify(parsed.input?.at(-1) ?? {});
}

function main(): void {
	const stateDir = process.argv[2];
	if (stateDir === undefined || stateDir.trim() === "") {
		console.error("aq-load model server: pass a writable state directory as the first argument");
		process.exit(1);
	}
	mkdirSync(stateDir, { recursive: true });
	let turn = 0;
	let streams = 0;
	let launchedSubagents = false;
	let asked = false;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			turn += 1;
			const newest = newestInput(Buffer.concat(chunks).toString("utf8"));
			if (!launchedSubagents && newest.includes(LOAD_MAIN_MARKER)) {
				launchedSubagents = true;
				toolCall(response, SUBAGENT_CALL_ID, "subagent", {
					tasks: Array.from({ length: SUBAGENTS }, (_, index) => ({
						agent: "worker",
						task: `${LOAD_STREAM_MARKER} subagent ${index}: stream a long status report`,
						model: `${LOAD_PROVIDER}/${LOAD_MODEL_ID}`,
					})),
					context: "fresh",
					wait: { kind: "background" },
				});
				return;
			}
			if (!asked && newest.includes(SUBAGENT_CALL_ID)) {
				asked = true;
				toolCall(response, "call_aq_load_question", "ask_user_question", benchmarkQuestionnaire());
				return;
			}
			if (newest.includes(LOAD_STREAM_MARKER)) {
				streams += 1;
				writeFileSync(join(stateDir, "streams-started"), String(streams), "utf8");
				streamTurn(
					response,
					turn,
					newest.includes(`${LOAD_STREAM_MARKER} subagent`) ? SUBAGENT_STREAM_SECONDS : STREAM_SECONDS,
				);
				return;
			}
			textTurn(response, turn);
		});
	});
	server.listen(0, "127.0.0.1", () => {
		writeFileSync(join(stateDir, "model-port"), String((server.address() as AddressInfo).port), "utf8");
	});
	const shutdown = (): void => {
		server.close(() => process.exit(0));
		process.exit(0);
	};
	setTimeout(shutdown, LIFETIME_MS).unref?.();
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main();
