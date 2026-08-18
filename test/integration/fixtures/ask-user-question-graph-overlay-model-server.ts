/**
 * Stand-in model endpoint for the graph-viewer `ask_user_question` overlay
 * scenario.
 *
 * The bug under test only exists once a *real* `ask_user_question` call reaches
 * a workflow stage: the tool always mounts with `{ overlay: true }`, and the
 * graph host used to reject that mode, failing the stage instead of painting
 * the questionnaire. So the stand-in does not describe a question — it answers
 * the stage's first turn with an actual `openai-responses` function call to
 * `ask_user_question`, and the real CLI runs the real tool.
 *
 * The endpoint is shared with the session's main chat, so the question is
 * routed by content rather than by call order: only a turn carrying the
 * fixture stage's prompt marker is answered with the tool call. Every other
 * turn — the main chat's, and any continuation after an answer — gets a short
 * completed message, so the questionnaire can only ever come from the stage.
 *
 * The stage then blocks inside the tool waiting for a human answer, so the
 * scenario leaves exactly one turn unfinished.
 *
 * Usage: bun ask-user-question-graph-overlay-model-server.ts <state-dir>
 * Writes `<state-dir>/model-port` once listening; that file is the readiness
 * signal, so a driver never has to guess a port or sleep for startup.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** Filename the driver reads to learn the port. */
export const GRAPH_OVERLAY_PORT_FILE = "model-port";

/**
 * The question text. It is the distinctive string the evidence run greps for
 * in the pane, so it must survive rendering verbatim: no wrapping, no ellipsis.
 */
export const GRAPH_OVERLAY_QUESTION = "GRAPH-OVERLAY-QUESTION";

/** The two options the questionnaire offers. */
export const GRAPH_OVERLAY_OPTIONS = ["Alpha", "Beta"] as const;

/**
 * Marker carried by the fixture workflow's stage prompt. Its presence in a
 * request body is what identifies the stage's turn.
 */
export const GRAPH_OVERLAY_STAGE_MARKER = "GRAPH-OVERLAY-STAGE-PROMPT";

/** Filename holding the number of turns served so far. */
export const GRAPH_OVERLAY_REQUEST_COUNT_FILE = "request-count";

/**
 * Self-destruct deadline. The evidence script deliberately leaves this process
 * running when it returns — the stage is still blocked on the question the
 * caller is about to capture — so the process bounds its own lifetime instead
 * of outliving the scenario.
 */
const LIFETIME_MS = Number(process.env.GRAPH_OVERLAY_MODEL_SERVER_TTL_MS ?? 15 * 60_000);

const QUESTION_ARGUMENTS = JSON.stringify({
	questions: [
		{
			question: GRAPH_OVERLAY_QUESTION,
			header: "Overlay",
			options: [
				{ label: GRAPH_OVERLAY_OPTIONS[0], description: "Take the first branch." },
				{ label: GRAPH_OVERLAY_OPTIONS[1], description: "Take the second branch." },
			],
		},
	],
});

function sse(response: ServerResponse, event: unknown): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function openStream(response: ServerResponse): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
}

function completeResponse(response: ServerResponse, responseId: string, output: readonly unknown[]): void {
	for (const [outputIndex, item] of output.entries()) {
		sse(response, { type: "response.output_item.done", output_index: outputIndex, item });
	}
	sse(response, { type: "response.completed", response: { id: responseId, status: "completed", output } });
	response.end("data: [DONE]\n\n");
}

function askUserQuestionTurn(response: ServerResponse): void {
	const call = {
		id: "fc_graph_overlay_question",
		call_id: "call_graph_overlay_question",
		name: "ask_user_question",
		arguments: QUESTION_ARGUMENTS,
	};
	openStream(response);
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
	completeResponse(response, "graph_overlay_question", [{ ...call, type: "function_call", status: "completed" }]);
}

function textTurn(response: ServerResponse, requestCount: number): void {
	const messageId = `msg_graph_overlay_${requestCount}`;
	const text = "graph-overlay stage acknowledged the answer";
	openStream(response);
	sse(response, {
		type: "response.output_item.added",
		output_index: 0,
		item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] },
	});
	sse(response, {
		type: "response.output_text.delta",
		output_index: 0,
		content_index: 0,
		item_id: messageId,
		delta: text,
	});
	completeResponse(response, `graph_overlay_followup_${requestCount}`, [
		{
			id: messageId,
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	]);
}

function main(): void {
	const stateDir = process.argv[2];
	if (stateDir === undefined || stateDir.trim() === "") {
		console.error("graph-overlay model server: pass a writable state directory as the first argument");
		process.exit(1);
	}
	let requestCount = 0;
	let asked = false;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			requestCount += 1;
			const body = Buffer.concat(chunks).toString("utf8");
			writeFileSync(join(stateDir, GRAPH_OVERLAY_REQUEST_COUNT_FILE), String(requestCount), "utf8");
			// Only the workflow stage gets the question. The main chat shares this
			// endpoint, and answering *its* turn with a questionnaire would paint
			// the same text in the wrong surface — the one place the evidence must
			// not accept it from.
			if (!asked && body.includes(GRAPH_OVERLAY_STAGE_MARKER)) {
				asked = true;
				askUserQuestionTurn(response);
				return;
			}
			textTurn(response, requestCount);
		});
	});
	server.listen(0, "127.0.0.1", () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, GRAPH_OVERLAY_PORT_FILE), String((server.address() as AddressInfo).port), "utf8");
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
