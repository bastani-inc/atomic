/**
 * Stand-in model endpoint for the issue #2074 end-to-end scenario.
 *
 * Both drivers — `test/integration/workflow-stage-steering-queue-cli.test.ts`
 * and `scripts/e2e/issue-2074-evidence.sh` — need a workflow stage that is
 * genuinely mid-turn while the user types into its stage chat, detaches, and
 * reattaches. The queue only holds a message while the stage session is
 * streaming, so the turn has to still be open at every step of the scenario.
 *
 * This server answers any request with an `openai-responses` SSE stream that
 * opens a turn, says one line, and then never completes: it keeps the response
 * alive with a heartbeat delta so the transport cannot time it out. Nothing in
 * the scenario waits for the turn to end, and the CLI is killed at the end, so
 * a stream with no terminator is the whole point rather than a leak.
 *
 * It is a separate process on purpose. The vitest driver and the tmux script
 * then drive the same endpoint instead of each modelling one, and the CLI it
 * serves is the real one in both.
 *
 * Usage: bun issue-2074-model-server.ts <state-dir>
 * Writes `<state-dir>/model-port` once listening; that file is the readiness
 * signal, so a driver never has to guess a port or sleep for startup.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

/** Filename both drivers read to learn the port. */
export const ISSUE_2074_PORT_FILE = "model-port";

/** The one line the stage streams before its turn is held open. */
export const ISSUE_2074_STAGE_TEXT = "issue-2074 stage is mid-turn";

/**
 * Keeps the held response from being reaped by an idle-connection timeout.
 * Short enough that a stalled socket is refreshed well inside any default, and
 * the payload is empty so the transcript does not grow.
 */
const HEARTBEAT_MS = 2_000;

/**
 * Self-destruct deadline.
 *
 * `scripts/e2e/issue-2074-evidence.sh` deliberately leaves this process running
 * when it returns — ending the stage's turn would drain the queue the caller is
 * about to capture — so the process has to bound its own lifetime rather than
 * outlive the scenario. Far longer than any run of that script, far shorter
 * than a session.
 */
const LIFETIME_MS = Number(process.env.ISSUE_2074_MODEL_SERVER_TTL_MS ?? 15 * 60_000);

const MESSAGE_ID = "msg_issue_2074";

function sse(response: ServerResponse, event: unknown): void {
	response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function openTurn(response: ServerResponse): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	sse(response, {
		type: "response.output_item.added",
		output_index: 0,
		item: {
			id: MESSAGE_ID,
			type: "message",
			role: "assistant",
			status: "in_progress",
			content: [],
		},
	});
	sse(response, {
		type: "response.output_text.delta",
		output_index: 0,
		content_index: 0,
		item_id: MESSAGE_ID,
		delta: ISSUE_2074_STAGE_TEXT,
	});
}

function main(): void {
	const stateDir = process.argv[2];
	if (stateDir === undefined || stateDir.trim() === "") {
		console.error("issue-2074 model server: pass a writable state directory as the first argument");
		process.exit(1);
	}
	const held = new Set<ServerResponse>();
	const server = createServer((request, response) => {
		request.resume();
		openTurn(response);
		held.add(response);
		response.on("close", () => held.delete(response));
	});
	const heartbeat = setInterval(() => {
		for (const response of held) {
			sse(response, {
				type: "response.output_text.delta",
				output_index: 0,
				content_index: 0,
				item_id: MESSAGE_ID,
				delta: "",
			});
		}
	}, HEARTBEAT_MS);
	heartbeat.unref?.();
	server.listen(0, "127.0.0.1", () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, ISSUE_2074_PORT_FILE), String((server.address() as AddressInfo).port), "utf8");
	});
	const shutdown = (): void => {
		clearInterval(heartbeat);
		for (const response of held) response.destroy();
		server.close(() => process.exit(0));
		process.exit(0);
	};
	setTimeout(shutdown, LIFETIME_MS).unref?.();
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main();
