/**
 * Deterministic OpenAI Responses endpoint for issue #2588 terminal evidence.
 *
 * The parent marker produces two sibling SINGLE `subagent` function calls in
 * one assistant response. Each child gets a distinct result, then the parent
 * receives both tool outputs and prints a stable proof line.
 *
 * Usage: bun issue-2588-model-server.ts <state-dir>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

export const ISSUE_2588_PORT_FILE = "model-port";
export const ISSUE_2588_REQUEST_LOG_FILE = "requests.log";
export const ISSUE_2588_PARENT_MARKER = "ISSUE-2588-PARENT-BURST";
export const ISSUE_2588_CHILD_A = "ISSUE-2588-CHILD-A";
export const ISSUE_2588_CHILD_B = "ISSUE-2588-CHILD-B";
export const ISSUE_2588_RESULT_A = "ISSUE-2588-RESULT-A";
export const ISSUE_2588_RESULT_B = "ISSUE-2588-RESULT-B";
export const ISSUE_2588_PARENT_DONE = "ISSUE-2588-PARENT-DONE";

const LIFETIME_MS = Number(process.env.ISSUE_2588_MODEL_SERVER_TTL_MS ?? 15 * 60_000);

type FunctionCallOutput = {
	readonly id: string;
	readonly call_id: string;
	readonly name: string;
	readonly arguments: string;
	readonly type: "function_call";
	readonly status: "in_progress" | "completed";
};

type AssistantMessageOutput = {
	readonly id: string;
	readonly type: "message";
	readonly role: "assistant";
	readonly status: "in_progress" | "completed";
	readonly content: readonly {
		readonly type: "output_text";
		readonly text: string;
		readonly annotations: readonly never[];
	}[];
};

type ResponseOutputItem = FunctionCallOutput | AssistantMessageOutput;

type ResponseSseEvent =
	| { readonly type: "response.output_item.added"; readonly output_index: number; readonly item: ResponseOutputItem }
	| { readonly type: "response.output_item.done"; readonly output_index: number; readonly item: ResponseOutputItem }
	| {
			readonly type: "response.function_call_arguments.delta";
			readonly output_index: number;
			readonly item_id: string;
			readonly delta: string;
	  }
	| {
			readonly type: "response.function_call_arguments.done";
			readonly output_index: number;
			readonly item_id: string;
			readonly arguments: string;
	  }
	| {
			readonly type: "response.output_text.delta";
			readonly output_index: number;
			readonly content_index: number;
			readonly item_id: string;
			readonly delta: string;
	  }
	| {
			readonly type: "response.completed";
			readonly response: {
				readonly id: string;
				readonly status: "completed";
				readonly output: readonly ResponseOutputItem[];
			};
	  };

function sse(response: ServerResponse, event: ResponseSseEvent): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function openStream(response: ServerResponse): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
}

function completeResponse(response: ServerResponse, responseId: string, output: readonly ResponseOutputItem[]): void {
	for (const [outputIndex, item] of output.entries()) {
		sse(response, { type: "response.output_item.done", output_index: outputIndex, item });
	}
	sse(response, { type: "response.completed", response: { id: responseId, status: "completed", output } });
	response.end("data: [DONE]\n\n");
}

function functionCall(
	response: ServerResponse,
	call: Omit<FunctionCallOutput, "type" | "status">,
	outputIndex: number,
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

function parentBurstTurn(response: ServerResponse): void {
	const calls = [
		{
			id: "fc_issue_2588_a",
			call_id: "call_issue_2588_a",
			name: "subagent",
			arguments: JSON.stringify({ agent: "issue-2588-a", task: ISSUE_2588_CHILD_A }),
		},
		{
			id: "fc_issue_2588_b",
			call_id: "call_issue_2588_b",
			name: "subagent",
			arguments: JSON.stringify({ agent: "issue-2588-b", task: ISSUE_2588_CHILD_B }),
		},
	];
	openStream(response);
	for (const [index, call] of calls.entries()) functionCall(response, call, index);
	completeResponse(
		response,
		"issue_2588_parent_burst",
		calls.map((call) => ({ ...call, type: "function_call", status: "completed" })),
	);
}

function textTurn(response: ServerResponse, responseId: string, text: string): void {
	const messageId = `msg_${responseId}`;
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
	completeResponse(response, responseId, [
		{
			id: messageId,
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	]);
}

function requestClass(body: string): string {
	if (body.includes(ISSUE_2588_RESULT_A) && body.includes(ISSUE_2588_RESULT_B)) return "parent-final";
	if (body.includes(ISSUE_2588_CHILD_A)) return "child-a";
	if (body.includes(ISSUE_2588_CHILD_B)) return "child-b";
	if (body.includes(ISSUE_2588_PARENT_MARKER)) return "parent-burst";
	return "unexpected";
}

function route(response: ServerResponse, body: string, requestCount: number): void {
	const kind = requestClass(body);
	if (kind === "child-a") {
		setTimeout(() => textTurn(response, `issue_2588_child_a_${requestCount}`, ISSUE_2588_RESULT_A), 600);
		return;
	}
	if (kind === "child-b") {
		setTimeout(() => textTurn(response, `issue_2588_child_b_${requestCount}`, ISSUE_2588_RESULT_B), 900);
		return;
	}
	if (kind === "parent-final") {
		textTurn(
			response,
			`issue_2588_parent_final_${requestCount}`,
			`${ISSUE_2588_PARENT_DONE}\nCOALESCED PARALLEL RUN: 2 children\n- issue-2588-a -> ${ISSUE_2588_RESULT_A}\n- issue-2588-b -> ${ISSUE_2588_RESULT_B}`,
		);
		return;
	}
	if (kind === "parent-burst" && !body.includes("function_call_output")) {
		parentBurstTurn(response);
		return;
	}
	textTurn(response, `issue_2588_unexpected_${requestCount}`, "ISSUE-2588-E2E-UNEXPECTED-REQUEST");
}

function main(): void {
	const stateDir = process.argv[2];
	if (stateDir === undefined || stateDir.trim() === "") {
		console.error("issue-2588 model server: pass a writable state directory as the first argument");
		process.exit(1);
	}
	mkdirSync(stateDir, { recursive: true });
	let requestCount = 0;
	const requestClasses: string[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			requestCount += 1;
			const body = Buffer.concat(chunks).toString("utf8");
			requestClasses.push(`${requestCount}:${requestClass(body)}`);
			writeFileSync(join(stateDir, ISSUE_2588_REQUEST_LOG_FILE), `${requestClasses.join("\n")}\n`, "utf8");
			route(response, body, requestCount);
		});
	});
	server.listen(0, "127.0.0.1", () => {
		writeFileSync(join(stateDir, ISSUE_2588_PORT_FILE), String((server.address() as AddressInfo).port), "utf8");
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
