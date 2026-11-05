/**
 * Stand-in model endpoint for the #4359 Intercom send scenario
 * (`scripts/e2e/possible-stage-prediction-evidence.sh`).
 *
 * The endpoint is shared by the session's main chat and the workflow's stages, and routes by content:
 *
 * - A stage turn (its prompt carries {@link STAGE_MARKER}) is held open for {@link STAGE_HOLD_MS}, so the run stays
 *   live while the main chat sends to its future stages, then completes with a short message.
 * - A main-chat turn whose newest user message is `PREDICTION-E2E SEND <target>` answers with a real `intercom` send
 *   to that target; `PREDICTION-E2E LIST` answers with a real `intercom` list. The turn after the tool result
 *   completes with a short message, so each directive runs exactly one tool call through the real CLI.
 *
 * Usage: bun possible-stage-prediction-model-server.ts <state-dir>
 * Writes `<state-dir>/model-port` once listening; that file is the readiness signal.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

const STAGE_MARKER = "PREDICTION-E2E-STAGE";
const DIRECTIVE = /PREDICTION-E2E (SEND|LIST)(?: (\S+))?/;
const STAGE_HOLD_MS = Number(process.env.PREDICTION_E2E_STAGE_HOLD_MS ?? 10 * 60_000);
const LIFETIME_MS = Number(process.env.PREDICTION_E2E_MODEL_SERVER_TTL_MS ?? 20 * 60_000);

interface InputItem {
	readonly type?: string;
	readonly role?: string;
	readonly content?: string | readonly { readonly type?: string; readonly text?: string }[];
}

function sse(response: ServerResponse, event: object): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function openStream(response: ServerResponse): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
}

function finish(response: ServerResponse, id: string, output: readonly object[]): void {
	for (const [index, item] of output.entries())
		sse(response, { type: "response.output_item.done", output_index: index, item });
	sse(response, { type: "response.completed", response: { id, status: "completed", output } });
	response.end("data: [DONE]\n\n");
}

function textTurn(response: ServerResponse, id: string, text: string): void {
	const messageId = `msg_${id}`;
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
	finish(response, id, [
		{
			id: messageId,
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	]);
}

function intercomTurn(response: ServerResponse, id: string, args: object): void {
	const call = { id: `fc_${id}`, call_id: `call_${id}`, name: "intercom", arguments: JSON.stringify(args) };
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
	finish(response, id, [{ ...call, type: "function_call", status: "completed" }]);
}

function textOf(item: InputItem): string {
	if (typeof item.content === "string") return item.content;
	return (item.content ?? []).map((part) => part.text ?? "").join("");
}

function main(): void {
	const stateDir = process.argv[2];
	if (stateDir === undefined || stateDir.trim() === "") {
		console.error("prediction e2e model server: pass a writable state directory");
		process.exit(1);
	}
	let turn = 0;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			turn += 1;
			const id = `prediction_e2e_${turn}`;
			const body = Buffer.concat(chunks).toString("utf8");
			if (body.includes(STAGE_MARKER)) {
				setTimeout(() => textTurn(response, id, "stage finished"), STAGE_HOLD_MS).unref?.();
				return;
			}
			const input = ((JSON.parse(body) as { readonly input?: readonly InputItem[] }).input ?? []).filter(
				(item) => item.type !== "reasoning",
			);
			const last = input.at(-1);
			if (last?.type === "function_call_output") {
				textTurn(response, id, "intercom call finished");
				return;
			}
			const directive = DIRECTIVE.exec(textOf([...input].reverse().find((item) => item.role === "user") ?? {}));
			if (directive?.[1] === "SEND" && directive[2] !== undefined) {
				intercomTurn(response, id, {
					action: "send",
					to: directive[2],
					message: "Scope update from the e2e driver.",
				});
				return;
			}
			if (directive?.[1] === "LIST") {
				intercomTurn(response, id, { action: "list" });
				return;
			}
			textTurn(response, id, "ready");
		});
	});
	server.listen(0, "127.0.0.1", () => {
		mkdirSync(stateDir, { recursive: true });
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
