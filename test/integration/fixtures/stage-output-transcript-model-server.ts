/**
 * Stand-in OpenAI Responses endpoint for stage-output-transcript terminal evidence.
 *
 * Request 1 streams the stage's own distinctive deliverable, then stays open long
 * enough for the companion extension to admit a subagent-style notification while
 * the stage prompt is still running. The notification causes the runtime's trailing
 * acknowledgement turn, which request 2 answers with a distinctive ACK.
 *
 * Usage: bun stage-output-transcript-model-server.ts <state-dir> <nonce>
 * Writes <state-dir>/model-port when ready and <state-dir>/request-count as calls arrive.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export const STAGE_OUTPUT_TRANSCRIPT_PORT_FILE = "model-port";
export const STAGE_OUTPUT_TRANSCRIPT_REQUEST_COUNT_FILE = "request-count";

const HOLD_FIRST_RESPONSE_MS = 2_500;
const LIFETIME_MS = Number(process.env.STAGE_OUTPUT_TRANSCRIPT_MODEL_SERVER_TTL_MS ?? 5 * 60_000);

function sse(response: ServerResponse, event: unknown): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function completeResponse(response: ServerResponse, messageId: string, text: string, responseId: string): void {
	const message = {
		id: messageId,
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	sse(response, { type: "response.output_item.done", output_index: 0, item: message });
	sse(response, { type: "response.completed", response: { id: responseId, status: "completed", output: [message] } });
	response.end("data: [DONE]\n\n");
}

function openResponse(response: ServerResponse, messageId: string, text: string): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
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
}

function main(): void {
	const stateDir = process.argv[2];
	const nonce = process.argv[3];
	if (stateDir === undefined || stateDir.trim() === "" || nonce === undefined || nonce.trim() === "") {
		console.error("stage-output-transcript model server: pass <state-dir> and <nonce>");
		process.exit(1);
	}

	let requestCount = 0;
	const heldResponses = new Set<ServerResponse>();
	const deliverable = `REAL-DELIVERABLE-${nonce}`;
	const acknowledgement = `ACK-${nonce}`;
	const server = createServer((request, response) => {
		request.resume();
		requestCount += 1;
		writeFileSync(join(stateDir, STAGE_OUTPUT_TRANSCRIPT_REQUEST_COUNT_FILE), String(requestCount), "utf8");
		const messageId = `stage_output_transcript_${requestCount}`;
		if (requestCount === 1) {
			openResponse(response, messageId, deliverable);
			heldResponses.add(response);
			const finish = (): void => {
				heldResponses.delete(response);
				if (!response.writableEnded)
					completeResponse(response, messageId, deliverable, "stage_output_transcript_initial");
			};
			response.on("close", () => heldResponses.delete(response));
			setTimeout(finish, HOLD_FIRST_RESPONSE_MS).unref?.();
			return;
		}
		openResponse(response, messageId, acknowledgement);
		completeResponse(response, messageId, acknowledgement, `stage_output_transcript_followup_${requestCount}`);
	});

	mkdirSync(stateDir, { recursive: true });
	server.listen(0, "127.0.0.1", () => {
		const address = server.address() as AddressInfo;
		writeFileSync(join(stateDir, STAGE_OUTPUT_TRANSCRIPT_PORT_FILE), String(address.port), "utf8");
	});

	const shutdown = (): void => {
		for (const response of heldResponses) response.destroy();
		server.close(() => process.exit(0));
		process.exit(0);
	};
	setTimeout(shutdown, LIFETIME_MS).unref?.();
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main();
