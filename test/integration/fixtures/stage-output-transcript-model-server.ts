/**
 * Stand-in OpenAI Responses endpoint for stage-output-transcript terminal evidence.
 *
 * The trailing variant answers an admission with ACK-<nonce> after the stage-own
 * deliverable. The mid-prompt variant answers an admission with ACK plus a real
 * bash tool call, then makes a third request for post-admission content. The
 * deliverable-after-admission variant returns INTRO, admits the custom turn, then
 * returns REAL-DELIVERABLE. The evidence harness supplies a fixed-width nonce so
 * default ACK size is deterministic. A size control makes ACK larger than the
 * initial deliverable but keeps it below the 3:2 nomination override threshold.
 *
 * Usage: bun stage-output-transcript-model-server.ts <state-dir> <nonce>
 *   [trailing|mid-prompt|deliverable-after-admission] [default|acknowledgement-larger]
 * Writes <state-dir>/model-port when ready and <state-dir>/request-count as calls arrive.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

type ResponseItem = Record<string, unknown>;

export const STAGE_OUTPUT_TRANSCRIPT_PORT_FILE = "model-port";
export const STAGE_OUTPUT_TRANSCRIPT_REQUEST_COUNT_FILE = "request-count";

const HOLD_FIRST_RESPONSE_MS = 2_500;
const LIFETIME_MS = Number(process.env.STAGE_OUTPUT_TRANSCRIPT_MODEL_SERVER_TTL_MS ?? 5 * 60_000);

function sse(response: ServerResponse, event: unknown): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function messageItem(messageId: string, text: string): ResponseItem {
	return {
		id: messageId,
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
}

function openMessage(response: ServerResponse, outputIndex: number, messageId: string, text: string): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	sse(response, {
		type: "response.output_item.added",
		output_index: outputIndex,
		item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] },
	});
	sse(response, {
		type: "response.output_text.delta",
		output_index: outputIndex,
		content_index: 0,
		item_id: messageId,
		delta: text,
	});
}

function openFunctionCall(
	response: ServerResponse,
	outputIndex: number,
	call: { id: string; call_id: string; name: string; arguments: string },
): void {
	sse(response, {
		type: "response.output_item.added",
		output_index: outputIndex,
		item: { ...call, type: "function_call", status: "in_progress", arguments: "" },
	});
	sse(response, {
		type: "response.function_call_arguments.delta",
		output_index: outputIndex,
		item_id: call.id,
		delta: call.arguments,
	});
	sse(response, {
		type: "response.function_call_arguments.done",
		output_index: outputIndex,
		item_id: call.id,
		arguments: call.arguments,
	});
}

function completeResponse(response: ServerResponse, responseId: string, output: readonly ResponseItem[]): void {
	for (const [outputIndex, item] of output.entries()) {
		sse(response, { type: "response.output_item.done", output_index: outputIndex, item });
	}
	sse(response, {
		type: "response.completed",
		response: { id: responseId, status: "completed", output },
	});
	response.end("data: [DONE]\n\n");
}

function main(): void {
	const stateDir = process.argv[2];
	const nonce = process.argv[3];
	const ordering = process.argv[4] ?? "trailing";
	const size = process.argv[5] ?? "default";
	if (
		stateDir === undefined ||
		stateDir.trim() === "" ||
		nonce === undefined ||
		nonce.trim() === "" ||
		(ordering !== "trailing" && ordering !== "mid-prompt" && ordering !== "deliverable-after-admission") ||
		(size !== "default" && size !== "acknowledgement-larger")
	) {
		console.error(
			"stage-output-transcript model server: pass <state-dir> <nonce> " +
				"[trailing|mid-prompt|deliverable-after-admission] [default|acknowledgement-larger]",
		);
		process.exit(1);
	}

	let requestCount = 0;
	const heldResponses = new Set<ServerResponse>();
	const deliverable =
		`REAL-DELIVERABLE-${nonce}\n\n` +
		"Substantive stage report with complete findings, supporting evidence, limitations, conclusions, and concrete next steps.";
	const introduction = `INTRO-${nonce}`;
	const acknowledgement =
		size === "acknowledgement-larger"
			? `ACK-${nonce}\n\n${"Larger admission-triggered acknowledgement content. ".repeat(4)}`
			: `ACK-${nonce}`;
	const server = createServer((request, response) => {
		request.resume();
		requestCount += 1;
		writeFileSync(join(stateDir, STAGE_OUTPUT_TRANSCRIPT_REQUEST_COUNT_FILE), String(requestCount), "utf8");
		const messageId = `stage_output_transcript_${requestCount}`;
		if (requestCount === 1) {
			const firstText = ordering === "trailing" ? deliverable : introduction;
			const firstMessage = messageItem(messageId, firstText);
			openMessage(response, 0, messageId, firstText);
			heldResponses.add(response);
			const finish = (): void => {
				heldResponses.delete(response);
				if (!response.writableEnded) completeResponse(response, "stage_output_transcript_initial", [firstMessage]);
			};
			response.on("close", () => heldResponses.delete(response));
			setTimeout(finish, HOLD_FIRST_RESPONSE_MS).unref?.();
			return;
		}
		if (ordering === "mid-prompt" && requestCount === 2) {
			const acknowledgementMessage = messageItem(messageId, acknowledgement);
			const toolCall = {
				id: `fc_stage_output_transcript_${nonce}`,
				call_id: `call_stage_output_transcript_${nonce}`,
				name: "bash",
				arguments: JSON.stringify({ command: "printf 'mid-prompt tool executed\\n'" }),
			};
			openMessage(response, 0, messageId, acknowledgement);
			openFunctionCall(response, 1, toolCall);
			completeResponse(response, `stage_output_transcript_followup_${requestCount}`, [
				acknowledgementMessage,
				{ ...toolCall, type: "function_call", status: "completed" },
			]);
			return;
		}
		const text = ordering === "trailing" ? acknowledgement : deliverable;
		const finalMessage = messageItem(messageId, text);
		openMessage(response, 0, messageId, text);
		completeResponse(response, `stage_output_transcript_followup_${requestCount}`, [finalMessage]);
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
