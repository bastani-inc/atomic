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
 * - A System One classifier request (`POST …/systemone`, the `typesafe-system-one` API) is answered as a recorded
 *   classifier would: each choice option naming one of {@link EXPECTED_STAGES} gets most of the probability, and a
 *   yes/no question about a target is confident yes for an expected stage and confident no otherwise.
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
/** The stages the helper-named scenario workflow materializes; the stand-in classifier expects exactly these. */
const EXPECTED_STAGES: ReadonlySet<string> = new Set(["review-1", "summary-2"]);
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

interface SystemOneQuestion {
	readonly type: "choice" | "noul" | "score";
	readonly criteria: Readonly<Record<string, string>> | readonly string[];
}

function expectsOption(text: string): boolean {
	return [...EXPECTED_STAGES].some((stage) => text === `stage ${stage}`);
}

/** A recorded classifier's answers for the scenario: choice probabilities and yes/no probabilities. */
function systemOneAnswers(body: {
	readonly state?: { readonly target?: unknown };
	readonly questions?: Readonly<Record<string, SystemOneQuestion>>;
}): Record<string, object> {
	const answers: Record<string, object> = {};
	for (const [id, question] of Object.entries(body.questions ?? {})) {
		if (question.type === "noul") {
			answers[id] = { type: "noul", noul: EXPECTED_STAGES.has(String(body.state?.target)) ? 0.95 : 0.05 };
			continue;
		}
		const options = Object.entries(question.criteria as Readonly<Record<string, string>>);
		const raw = options.map(
			([option, text]) => [option, expectsOption(text) ? 0.93 : 0.07 / options.length] as const,
		);
		const best = raw.reduce((left, right) => (right[1] > left[1] ? right : left));
		answers[id] = { type: "choice", choice: best[0], probabilities: Object.fromEntries(raw), confidence: best[1] };
	}
	return answers;
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
			if (request.url?.endsWith("/systemone") === true) {
				const answers = systemOneAnswers(JSON.parse(body));
				writeFileSync(
					join(stateDir, `classifier-${turn}.json`),
					JSON.stringify({ request: JSON.parse(body), answers }),
				);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ answers, usage: { input_tokens: 1, output_tokens: 1 } }));
				return;
			}
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
